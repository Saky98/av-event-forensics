#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║                      deepaccident_to_mcap.py — MCAP converter                ║
║                         DeepAccident dataset → Foxglove MCAP                 ║
╚══════════════════════════════════════════════════════════════════════════════╝

Converts a DeepAccident Mini dataset into the MCAP format using Foxglove
FlatBuffer schemas for direct visualization in Foxglove Studio.

Example:
    python3 deepaccident_to_mcap.py --list
    python3 deepaccident_to_mcap.py --scenario type1_subtype1_accident \\
        --town Town03_type001_subtype0001_scenario00024 \\
        --output output.mcap
"""

import os
import sys
import json
import math
import argparse
import struct
import pickle
from pathlib import Path

import numpy as np
import cv2
import flatbuffers
from mcap.writer import Writer
from foxglove_schemas_flatbuffer import get_schema, resources as res

# Load the FlatBuffers generated classes
_FB_PATH = str(res.files('foxglove_schemas_flatbuffer'))
if _FB_PATH not in sys.path:
    sys.path.insert(0, _FB_PATH)

import CompressedImage as _CI_mod
import PointCloud as _PC_mod
import PackedElementField as _PEF_mod
import Pose as _Pose_mod
import Point3 as _P3_mod
import Quaternion as _Q_mod
import Vector3 as _V3_mod
import Time as _Time_mod
import SceneUpdate as _SU_mod
import SceneEntity as _SE_mod
import CubePrimitive as _CP_mod
import Color as _Color_mod

# ══════════════════════════════════════════════════════════════
# PATHS (adapted for av-event-forensics)
# ══════════════════════════════════════════════════════════════

# Project root: scripts/python/deepaccident_to_mcap.py -> .. -> .. -> root
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_DATASET = os.path.join(PROJECT_ROOT, "storage", "DeepAccident_mini")
DEFAULT_OUTPUT = os.path.join(PROJECT_ROOT, "storage", "output.mcap")

# ══════════════════════════════════════════════════════════════
# CONSTANTS
# ══════════════════════════════════════════════════════════════

FPS = 10
DT = 1.0 / FPS
BRAKING_THRESHOLD_MS2 = -5.0

CAMERAS = [
    "Camera_Front", "Camera_Back",
    "Camera_FrontLeft", "Camera_FrontRight",
    "Camera_BackLeft", "Camera_BackRight",
]

CAMERA_TOPICS = {
    "Camera_Front":      "/camera_front/image/compressed",
    "Camera_Back":       "/camera_back/image/compressed",
    "Camera_FrontLeft":  "/camera_front_left/image/compressed",
    "Camera_FrontRight": "/camera_front_right/image/compressed",
    "Camera_BackLeft":   "/camera_back_left/image/compressed",
    "Camera_BackRight":  "/camera_back_right/image/compressed",
}

LIDAR_TOPIC = "/lidar/points"
EGO_POSE_TOPIC = "/ego/pose"
EGO_VELOCITY_TOPIC = "/ego/velocity"
EGO_ACCELERATION_TOPIC = "/ego/acceleration"
COLLISION_TOPIC = "/collision/detected"
BRAKING_EVENT_TOPIC = "/events/sudden_braking"
ANNOTATIONS_TOPIC = "/annotations/objects"
BACKGROUND_MAP_TOPIC = "/lidar/background_map"


# ══════════════════════════════════════════════════════════════
# PARSING
# ══════════════════════════════════════════════════════════════

def parse_label_file(filepath):
    result = {"ego_x": 0.0, "ego_y": 0.0, "heading": 0.0,
              "objects": [], "has_collision": False}
    with open(filepath) as f:
        lines = f.readlines()
    if not lines:
        return result
    parts = lines[0].strip().split()
    if len(parts) >= 2:
        result["ego_x"] = float(parts[0])
        result["ego_y"] = float(parts[1])
    if len(parts) >= 3:
        result["heading"] = float(parts[2])
    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 13:
            continue
        obj = {"type": parts[0],
               "x": float(parts[1]), "y": float(parts[2]), "z": float(parts[3]),
               "width": float(parts[4]), "height": float(parts[5]), "length": float(parts[6]),
               "yaw": float(parts[7]), "vx": float(parts[8]), "vy": float(parts[9]),
               "id": int(parts[10]), "token": int(parts[11]),
               "collision": parts[12] == "True"}
        result["objects"].append(obj)
        if obj["collision"]:
            result["has_collision"] = True
    return result


def parse_meta_file(filepath):
    result = {"weather": "", "accident": False, "collision_type": "", "collision_speed": 0.0}
    try:
        with open(filepath) as f:
            lines = f.readlines()
        if not lines:
            return result
        parts = lines[0].strip().split()
        if parts:
            result["weather"] = parts[0]
        if len(parts) >= 2 and parts[1] != "-1":
            result["accident"] = True
            result["collision_speed"] = float(parts[-1]) if len(parts) >= 9 else 0.0
            if len(parts) >= 7:
                result["collision_type"] = parts[6]
    except Exception:
        pass
    return result


# ══════════════════════════════════════════════════════════════
# SUDDEN BRAKING DETECTION
# ══════════════════════════════════════════════════════════════

def detect_sudden_braking(ego_positions, threshold=BRAKING_THRESHOLD_MS2):
    results = []
    for i in range(len(ego_positions)):
        fi = {"frame": i + 1, "velocity": 0.0, "acceleration": 0.0, "is_braking_event": False}
        if i > 0:
            dx = ego_positions[i][0] - ego_positions[i - 1][0]
            dy = ego_positions[i][1] - ego_positions[i - 1][1]
            fi["velocity"] = math.sqrt(dx**2 + dy**2) / DT
            if i > 1:
                pv = math.sqrt(
                    (ego_positions[i - 1][0] - ego_positions[i - 2][0])**2 +
                    (ego_positions[i - 1][1] - ego_positions[i - 2][1])**2
                ) / DT
                accel = (fi["velocity"] - pv) / DT
                fi["acceleration"] = accel
                if accel < threshold:
                    fi["is_braking_event"] = True
        results.append(fi)
    return results


# ═════════════════════════════════════════════════════════════════════════════
# FLATBUFFER BUILDERS
# ═════════════════════════════════════════════════════════════════════════════

def build_compressed_image(builder, jpeg_bytes, ts_ns, frame_id="ego_vehicle"):
    """Builds a FlatBuffer for foxglove_msgs/CompressedImage.

    Note: FlatBuffers requires structs (e.g. Time) to be built inline right
    before the corresponding PrependStructSlot call.
    """
    sec = ts_ns // 1_000_000_000
    nsec = ts_ns % 1_000_000_000
    fb_frame = builder.CreateString(frame_id)
    fb_fmt = builder.CreateString("jpeg")
    fb_data = builder.CreateByteVector(jpeg_bytes)
    _CI_mod.CompressedImageStart(builder)
    _CI_mod.CompressedImageAddFrameId(builder, fb_frame)
    _CI_mod.CompressedImageAddFormat(builder, fb_fmt)
    _CI_mod.CompressedImageAddData(builder, fb_data)
    # Struct is added after the other fields, inline
    _CI_mod.CompressedImageAddTimestamp(
        builder, _Time_mod.CreateTime(builder, sec, nsec))
    img = _CI_mod.CompressedImageEnd(builder)
    builder.Finish(img)
    return bytes(builder.Output())


def build_pointcloud(builder, points, ts_ns, frame_id="ego_vehicle"):
    """Builds a FlatBuffer for foxglove_msgs/PointCloud.
    points: numpy array (N, 4) = [x, y, z, intensity]
    """
    N = points.shape[0]
    sec = ts_ns // 1_000_000_000
    nsec = ts_ns % 1_000_000_000
    fb_frame = builder.CreateString(frame_id)

    # Building the PackedElementField entries
    def _make_field(b, name, offset, typ):
        name_off = b.CreateString(name)
        _PEF_mod.PackedElementFieldStart(b)
        _PEF_mod.PackedElementFieldAddName(b, name_off)
        _PEF_mod.PackedElementFieldAddOffset(b, offset)
        _PEF_mod.PackedElementFieldAddType(b, typ)
        return _PEF_mod.PackedElementFieldEnd(b)

    f_x = _make_field(builder, "x", 0, 7)
    f_y = _make_field(builder, "y", 4, 7)
    f_z = _make_field(builder, "z", 8, 7)
    f_i = _make_field(builder, "intensity", 12, 7)

    _PC_mod.PointCloudStartFieldsVector(builder, 4)
    # flatbuffers 25.x koristi PrependUOffsetTRelative umesto PrependUOffsetTRel
    prepend_offset = builder.PrependUOffsetTRelative
    prepend_offset(f_i)
    prepend_offset(f_z)
    prepend_offset(f_y)
    prepend_offset(f_x)
    fields_vec = builder.EndVector()

    point_stride = 16
    data_bytes = points.astype(np.float32).tobytes()
    data_vec = builder.CreateByteVector(data_bytes)

    # Pose (identity)
    def _p3(x, y, z):
        _P3_mod.Point3Start(builder)
        _P3_mod.Point3AddX(builder, x); _P3_mod.Point3AddY(builder, y)
        _P3_mod.Point3AddZ(builder, z)
        return _P3_mod.Point3End(builder)
    def _q(x, y, z, w):
        _Q_mod.QuaternionStart(builder)
        _Q_mod.QuaternionAddX(builder, x); _Q_mod.QuaternionAddY(builder, y)
        _Q_mod.QuaternionAddZ(builder, z); _Q_mod.QuaternionAddW(builder, w)
        return _Q_mod.QuaternionEnd(builder)
    pos = _p3(0.0, 0.0, 0.0)
    quat = _q(0.0, 0.0, 0.0, 1.0)
    _Pose_mod.PoseStart(builder)
    _Pose_mod.PoseAddPosition(builder, pos)
    _Pose_mod.PoseAddOrientation(builder, quat)
    pc_pose = _Pose_mod.PoseEnd(builder)

    _PC_mod.PointCloudStart(builder)
    # Struct is added inline
    _PC_mod.PointCloudAddTimestamp(
        builder, _Time_mod.CreateTime(builder, sec, nsec))
    _PC_mod.PointCloudAddFrameId(builder, fb_frame)
    _PC_mod.PointCloudAddPose(builder, pc_pose)
    _PC_mod.PointCloudAddPointStride(builder, point_stride)
    _PC_mod.PointCloudAddFields(builder, fields_vec)
    _PC_mod.PointCloudAddData(builder, data_vec)
    pc = _PC_mod.PointCloudEnd(builder)
    builder.Finish(pc)
    return bytes(builder.Output())


def build_pose(builder, x, y, z, yaw, ts_ns):
    """Builds a FlatBuffer for foxglove_msgs/Pose."""
    qz = math.sin(yaw * 0.5)
    qw = math.cos(yaw * 0.5)
    def _p3(x, y, z):
        _P3_mod.Point3Start(builder)
        _P3_mod.Point3AddX(builder, x); _P3_mod.Point3AddY(builder, y)
        _P3_mod.Point3AddZ(builder, z)
        return _P3_mod.Point3End(builder)
    def _q(x, y, z, w):
        _Q_mod.QuaternionStart(builder)
        _Q_mod.QuaternionAddX(builder, x); _Q_mod.QuaternionAddY(builder, y)
        _Q_mod.QuaternionAddZ(builder, z); _Q_mod.QuaternionAddW(builder, w)
        return _Q_mod.QuaternionEnd(builder)
    pos = _p3(x, y, z)
    quat = _q(0.0, 0.0, qz, qw)
    _Pose_mod.PoseStart(builder)
    _Pose_mod.PoseAddPosition(builder, pos)
    _Pose_mod.PoseAddOrientation(builder, quat)
    pose = _Pose_mod.PoseEnd(builder)
    builder.Finish(pose)
    return bytes(builder.Output())


# ═════════════════════════════════════════════════════════════════════════════
# BUILD SCENE UPDATE (3D bounding-box annotations for Foxglove)
# ═════════════════════════════════════════════════════════════════════════════

def build_cube_primitive(builder, obj, color_r, color_g, color_b):
    """Builds a CubePrimitive FlatBuffer for a single object."""
    # Position
    _P3_mod.Point3Start(builder)
    _P3_mod.Point3AddX(builder, obj["x"])
    _P3_mod.Point3AddY(builder, obj["y"])
    _P3_mod.Point3AddZ(builder, obj["z"])
    pos = _P3_mod.Point3End(builder)
    
    # Orientation (yaw only)
    qz = math.sin(obj["yaw"] * 0.5)
    qw = math.cos(obj["yaw"] * 0.5)
    _Q_mod.QuaternionStart(builder)
    _Q_mod.QuaternionAddX(builder, 0.0)
    _Q_mod.QuaternionAddY(builder, 0.0)
    _Q_mod.QuaternionAddZ(builder, qz)
    _Q_mod.QuaternionAddW(builder, qw)
    quat = _Q_mod.QuaternionEnd(builder)
    
    # Pose
    _Pose_mod.PoseStart(builder)
    _Pose_mod.PoseAddPosition(builder, pos)
    _Pose_mod.PoseAddOrientation(builder, quat)
    pose = _Pose_mod.PoseEnd(builder)
    
    # Size (width, height, length)
    _V3_mod.Vector3Start(builder)
    _V3_mod.Vector3AddX(builder, obj["width"])
    _V3_mod.Vector3AddY(builder, obj["height"])
    _V3_mod.Vector3AddZ(builder, obj["length"])
    size = _V3_mod.Vector3End(builder)
    
    # Color
    _Color_mod.ColorStart(builder)
    _Color_mod.ColorAddR(builder, color_r)
    _Color_mod.ColorAddG(builder, color_g)
    _Color_mod.ColorAddB(builder, color_b)
    _Color_mod.ColorAddA(builder, 0.7)
    color = _Color_mod.ColorEnd(builder)
    
    # Cube
    _CP_mod.CubePrimitiveStart(builder)
    _CP_mod.CubePrimitiveAddPose(builder, pose)
    _CP_mod.CubePrimitiveAddSize(builder, size)
    _CP_mod.CubePrimitiveAddColor(builder, color)
    return _CP_mod.CubePrimitiveEnd(builder)


def build_scene_update(builder, objects, frame_id="ego_vehicle"):
    """Builds a SceneUpdate FlatBuffer with bounding boxes for all detected objects."""
    if not objects:
        return None
    
    # Build a single SceneEntity holding all the cubes
    cubes = []
    for obj in objects:
        # Color based on type and collision status
        if obj["collision"]:
            r, g, b = 1.0, 0.2, 0.2  # red for collision
        elif obj["type"] == "truck":
            r, g, b = 1.0, 0.6, 0.0  # orange for the truck
        elif obj["type"] == "pedestrian":
            r, g, b = 1.0, 1.0, 0.0  # yellow for pedestrians
        else:
            r, g, b = 0.2, 0.5, 1.0  # blue for other vehicles
        
        cube = build_cube_primitive(builder, obj, r, g, b)
        cubes.append(cube)
    
    # Prepend cubes (FlatBuffers builds them in reverse)
    _SE_mod.SceneEntityStartCubesVector(builder, len(cubes))
    for c in reversed(cubes):
        builder.PrependUOffsetTRelative(c)
    cubes_vec = builder.EndVector()
    
    # Frame ID string
    fb_frame = builder.CreateString(frame_id)
    
    # Entity ID string
    entity_id = builder.CreateString("objects")
    
    # SceneEntity
    _SE_mod.SceneEntityStart(builder)
    _SE_mod.SceneEntityAddFrameId(builder, fb_frame)
    _SE_mod.SceneEntityAddId(builder, entity_id)
    _SE_mod.SceneEntityAddCubes(builder, cubes_vec)
    entity = _SE_mod.SceneEntityEnd(builder)
    
    # SceneUpdate (entities only, no deletions)
    _SU_mod.SceneUpdateStartEntitiesVector(builder, 1)
    builder.PrependUOffsetTRelative(entity)
    entities_vec = builder.EndVector()
    
    _SU_mod.SceneUpdateStart(builder)
    _SU_mod.SceneUpdateAddEntities(builder, entities_vec)
    scene_update = _SU_mod.SceneUpdateEnd(builder)
    builder.Finish(scene_update)
    return bytes(builder.Output())


# ═════════════════════════════════════════════════════════════════════════════
# MAIN MCAP CONVERSION
# ═════════════════════════════════════════════════════════════════════════════

def get_timestamp_ns(frame_number, fps=FPS, base_sec=1700000000):
    return int((base_sec + frame_number / fps) * 1e9)


# FlatBuffer schemas (BFBS) from the foxglove-schemas-flatbuffer package
FB_SCHEMAS = {
    "foxglove.CompressedImage": get_schema("CompressedImage"),
    "foxglove.PointCloud": get_schema("PointCloud"),
    "foxglove.Pose": get_schema("Pose"),
    "foxglove.SceneUpdate": get_schema("SceneUpdate"),
}


def register_schemas(writer):
    """Registers FlatBuffer schemas in the MCAP. Returns dict {name: schema_id}."""
    ids = {}
    for name, fb_data in FB_SCHEMAS.items():
        ids[name] = writer.register_schema(
            name=name,
            encoding="flatbuffer",
            data=fb_data,
        )
    return ids


def register_channels(writer, schema_ids):
    """Registers the channels/topics. Returns dict {name: channel_id}."""
    ch = {}
    for cam_name, topic in CAMERA_TOPICS.items():
        ch[cam_name] = writer.register_channel(
            topic=topic, message_encoding="flatbuffer",
            schema_id=schema_ids["foxglove.CompressedImage"],
        )
    ch["lidar"] = writer.register_channel(
        topic=LIDAR_TOPIC, message_encoding="flatbuffer",
        schema_id=schema_ids["foxglove.PointCloud"],
    )
    ch["ego_pose"] = writer.register_channel(
        topic=EGO_POSE_TOPIC, message_encoding="flatbuffer",
        schema_id=schema_ids["foxglove.Pose"],
    )
    # For velocity and acceleration we keep simple Float64 topics
    # (not foxglove FlatBuffers, so we write them as JSON)
    ch["velocity"] = writer.register_channel(
        topic=EGO_VELOCITY_TOPIC, message_encoding="json",
        schema_id=writer.register_schema(
            name="std_msgs/Float64", encoding="jsonschema",
            data=json.dumps({"type": "object", "properties": {"data": {"type": "number"}}}).encode(),
        ),
    )
    ch["acceleration"] = writer.register_channel(
        topic=EGO_ACCELERATION_TOPIC, message_encoding="json",
        schema_id=writer.register_schema(
            name="std_msgs/Float64", encoding="jsonschema",
            data=json.dumps({"type": "object", "properties": {"data": {"type": "number"}}}).encode(),
        ),
    )
    ch["collision"] = writer.register_channel(
        topic=COLLISION_TOPIC, message_encoding="json",
        schema_id=writer.register_schema(
            name="std_msgs/Bool", encoding="jsonschema",
            data=json.dumps({"type": "object", "properties": {"data": {"type": "boolean"}}}).encode(),
        ),
    )
    ch["braking_event"] = writer.register_channel(
        topic=BRAKING_EVENT_TOPIC, message_encoding="json",
        schema_id=writer.register_schema(
            name="std_msgs/String", encoding="jsonschema",
            data=json.dumps({"type": "object", "properties": {"data": {"type": "string"}}}).encode(),
        ),
    )
    ch["annotations"] = writer.register_channel(
        topic=ANNOTATIONS_TOPIC, message_encoding="flatbuffer",
        schema_id=schema_ids["foxglove.SceneUpdate"],
    )
    # Accumulated cloud in world frame (n=1, used as the "background map")
    ch["background_map"] = writer.register_channel(
        topic=BACKGROUND_MAP_TOPIC, message_encoding="flatbuffer",
        schema_id=schema_ids["foxglove.PointCloud"],
    )
    return ch


# Shared FlatBuffer builder (allocates memory)
_builder = flatbuffers.Builder(2_000_000)


def accumulate_cloud(acc, points, ego_to_world):
    """Transforms a lidar frame into the world frame via ego_to_world (4x4)
    and appends it to the accumulated cloud. Returns None when there are no points."""
    if points is None or len(points) == 0:
        return acc
    pts = np.asarray(points, dtype=np.float32)
    xyz = pts[:, :3]
    if pts.shape[1] >= 4:
        intensity = pts[:, 3:4]
    else:
        intensity = np.ones((pts.shape[0], 1), dtype=np.float32)
    ones = np.ones((pts.shape[0], 1), dtype=np.float32)
    world = (ego_to_world @ np.hstack([xyz, ones]).T).T[:, :3]
    merged = np.hstack([world, intensity]).astype(np.float32)
    return merged if acc is None else np.vstack([acc, merged])


def convert_scenario_to_mcap(
    scenario_base_path, scenario_name, town_name,
    frame_start=1, frame_end=None,
    output_path="output.mcap", agent="ego_vehicle",
    accumulate=True,
):
    global _builder

    print(f"▶ Converting: {scenario_name}")
    print(f"  Output: {output_path}")

    label_dir = os.path.join(scenario_base_path, agent, "label", scenario_name)
    if not os.path.isdir(label_dir):
        print(f"  ❌ Does not exist: {label_dir}")
        return False

    label_files = sorted([f for f in os.listdir(label_dir) if f.endswith(".txt")])
    if not label_files:
        print("  ❌ No label files found")
        return False

    if frame_end is None:
        frame_end = len(label_files)
    total_frames = frame_end - frame_start + 1
    print(f"  Frames: {frame_start} → {frame_end} ({total_frames})")

    meta = parse_meta_file(os.path.join(scenario_base_path, "meta", f"{scenario_name}.txt"))
    if meta["accident"]:
        print(f'  🚗 Collision: {meta["collision_type"]}, {meta["collision_speed"]} km/h, {meta["weather"]}')
    else:
        print("  ✅ Normal driving")

    writer = Writer(output=output_path)
    writer.start()
    schema_ids = register_schemas(writer)
    channels = register_channels(writer, schema_ids)

    ego_positions = []
    acc_points = None
    acc_ts = None

    for idx, frame_num in enumerate(range(frame_start, frame_end + 1)):
        frame_str = f"{frame_num:03d}"
        ts_ns = get_timestamp_ns(frame_num)

        # Label data
        label_path = os.path.join(scenario_base_path, agent, "label", scenario_name,
                                  f"{scenario_name}_{frame_str}.txt")
        if not os.path.exists(label_path):
            continue
        label_data = parse_label_file(label_path)
        
        # Real position in the world from the calib PKL file (ego_to_world matrix)
        calib_path = os.path.join(scenario_base_path, agent, "calib", scenario_name,
                                  f"{scenario_name}_{frame_str}.pkl")
        if os.path.exists(calib_path):
            with open(calib_path, 'rb') as f:
                calib_data = pickle.load(f)
            M = calib_data['ego_to_world']
            ego_to_world = M
            world_x, world_y = M[0,3], M[1,3]
        else:
            ego_to_world = np.eye(4)
            world_x, world_y = label_data["ego_x"], label_data["ego_y"]
        ego_positions.append((world_x, world_y))

        # === 1. Ego pose (FlatBuffer) ===
        _builder.Clear()
        pose_data = build_pose(_builder, label_data["ego_x"], label_data["ego_y"], 0.0,
                               label_data["heading"], ts_ns)
        writer.add_message(
            channel_id=channels["ego_pose"], log_time=ts_ns,
            data=pose_data, publish_time=ts_ns,
        )

        # === 2. Collision (JSON) ===
        writer.add_message(
            channel_id=channels["collision"], log_time=ts_ns,
            data=json.dumps({"data": label_data["has_collision"]}).encode(),
            publish_time=ts_ns,
        )

        # === 3. Kamere (FlatBuffer) ===
        for cam_name in CAMERAS:
            img_path = os.path.join(scenario_base_path, agent, cam_name, scenario_name,
                                    f"{scenario_name}_{frame_str}.jpg")
            if not os.path.exists(img_path):
                continue
            with open(img_path, "rb") as f:
                jpeg_bytes = f.read()
            _builder.Clear()
            img_data = build_compressed_image(_builder, jpeg_bytes, ts_ns, cam_name)
            writer.add_message(
                channel_id=channels[cam_name], log_time=ts_ns,
                data=img_data, publish_time=ts_ns,
            )

        # === 4. LiDAR (FlatBuffer) ===
        lidar_path = os.path.join(scenario_base_path, agent, "lidar01", scenario_name,
                                  f"{scenario_name}_{frame_str}.npz")
        if os.path.exists(lidar_path):
            try:
                with np.load(lidar_path) as data:
                    points = data["data"]
                if accumulate:
                    acc_points = accumulate_cloud(acc_points, points, ego_to_world)
                    if acc_ts is None:
                        acc_ts = ts_ns
                _builder.Clear()
                pc_data = build_pointcloud(_builder, points, ts_ns)
                writer.add_message(
                    channel_id=channels["lidar"], log_time=ts_ns,
                    data=pc_data, publish_time=ts_ns,
                )
            except Exception as e:
                print(f"  ⚠ LiDAR frame {frame_str}: {e}")

        # === 5. 3D Anotacije (SceneUpdate) ===
        if label_data.get("objects"):
            _builder.Clear()
            ann_data = build_scene_update(_builder, label_data["objects"], agent)
            if ann_data:
                writer.add_message(
                    channel_id=channels["annotations"], log_time=ts_ns,
                    data=ann_data, publish_time=ts_ns,
                )

        # Progress
        if (idx + 1) % 10 == 0 or idx == 0 or idx == total_frames - 1:
            print(f"  📍 Frame {frame_str}/{frame_end:03d} ({idx+1}/{total_frames})", end="\r")

    print()

    # === ACCUMULATED CLOUD: all lidar frames in the world frame ===
    if accumulate and acc_points is not None and len(acc_points) > 0:
        ts_map = acc_ts if acc_ts is not None else get_timestamp_ns(frame_start)
        print(f"  🗺️ Accumulated cloud: {len(acc_points):,} points -> {BACKGROUND_MAP_TOPIC}")
        _builder.Clear()
        map_data = build_pointcloud(_builder, acc_points, ts_map, "map")
        writer.add_message(
            channel_id=channels["background_map"], log_time=ts_map,
            data=map_data, publish_time=ts_map,
        )
        del acc_points  # free memory

    # === SUDDEN BRAKING DETECTION ===
    print("  🔍 Detecting sudden braking...")
    braking_results = detect_sudden_braking(ego_positions)
    braking_frames = [r for r in braking_results if r["is_braking_event"]]

    if braking_frames:
        print(f"  🛑 DETECTED on {len(braking_frames)} frames:")
        for br in braking_frames[:5]:
            print(f"     Frame {br['frame']:03d}: v={br['velocity']:.1f} m/s, a={br['acceleration']:.1f} m/s²")
        if len(braking_frames) > 5:
            print(f"     ... + {len(braking_frames) - 5}")
    else:
        print("  ✅ No sudden braking")

    # === Write velocity and acceleration for EVERY frame ===
    for br in braking_results:
        ts_ns = get_timestamp_ns(br["frame"])
        writer.add_message(
            channel_id=channels["velocity"], log_time=ts_ns,
            data=json.dumps({"data": br["velocity"]}).encode(),
            publish_time=ts_ns,
        )
        writer.add_message(
            channel_id=channels["acceleration"], log_time=ts_ns,
            data=json.dumps({"data": br["acceleration"]}).encode(),
            publish_time=ts_ns,
        )

    for br in braking_frames:
        ts_ns = get_timestamp_ns(br["frame"])
        writer.add_message(
            channel_id=channels["braking_event"], log_time=ts_ns,
            data=json.dumps({"data": json.dumps({
                "event": "sudden_braking",
                "frame": br["frame"],
                "velocity_ms": round(br["velocity"], 2),
                "acceleration_ms2": round(br["acceleration"], 2),
            })}).encode(),
            publish_time=ts_ns,
        )

    writer.finish()
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"  ✅ MCAP written: {output_path} ({size_mb:.1f} MB)")
    return True


# ══════════════════════════════════════════════════════════════
# HELPER FUNCTIONS
# ══════════════════════════════════════════════════════════════

def list_scenarios(dataset_path="DeepAccident_mini"):
    if not os.path.isdir(dataset_path):
        print(f"❌ Does not exist: {dataset_path}")
        return
    print(f"📂 Scenarios in {dataset_path}:\n")
    for root, dirs, files in os.walk(dataset_path):
        if root.endswith("meta"):
            for f in sorted(files):
                if not f.endswith(".txt"):
                    continue
                name = f.replace(".txt", "")
                meta = parse_meta_file(os.path.join(root, f))
                marker = "🚗 COLLISION" if meta["accident"] else "✅ normal"
                w = meta["weather"] or "?"
                s = f'{meta["collision_speed"]} km/h' if meta["accident"] else "-"
                print(f"  {marker}  {name}\n         Weather: {w} | Speed: {s}\n")


def get_frame_range(scenario_base, scenario_name, agent="ego_vehicle"):
    d = os.path.join(scenario_base, agent, "label", scenario_name)
    if not os.path.isdir(d):
        return 1, 0
    files = sorted([f for f in os.listdir(d) if f.endswith(".txt")])
    if not files:
        return 1, 0
    nums = []
    for f in files:
        try:
            nums.append(int(f.replace(".txt", "").split("_")[-1]))
        except ValueError:
            continue
    return min(nums), max(nums) if nums else (1, 0)


# ═════════════════════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════════════════════

def main():
    p = argparse.ArgumentParser(description="DeepAccident → MCAP (FlatBuffer)")
    p.add_argument("--dataset", default=DEFAULT_DATASET)
    p.add_argument("--scenario")
    p.add_argument("--town")
    p.add_argument("--frame", type=int, default=1)
    p.add_argument("--frame-end", type=int)
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--agent", default="ego_vehicle")
    p.add_argument("--list", action="store_true")
    p.add_argument("--all-accidents", action="store_true")
    p.add_argument("--no-accumulate", action="store_true",
                   help="disable the accumulated cloud (/lidar/background_map)")
    args = p.parse_args()

    if args.list:
        list_scenarios(args.dataset)
        return

    if args.all_accidents:
        for at in ["type1_subtype1_accident", "type1_subtype2_accident"]:
            base = os.path.join(args.dataset, at)
            front = os.path.join(base, args.agent, "Camera_Front")
            if not os.path.isdir(front):
                continue
            for tn in sorted(os.listdir(front)):
                tp = os.path.join(front, tn)
                if not os.path.isdir(tp):
                    continue
                out = os.path.join(
                    os.path.dirname(args.output) if args.output != "output.mcap" else ".",
                    f"{tn}_{at}.mcap"
                )
                mi, ma = get_frame_range(base, tn, args.agent)
                if ma == 0:
                    continue
                print(f"\n{'='*60}")
                convert_scenario_to_mcap(base, tn, tn, mi, ma, out, args.agent,
                                         accumulate=not args.no_accumulate)
        return

    if not args.scenario or not args.town:
        p.print_help()
        print("\n📂 Types:")
        for d in sorted(os.listdir(args.dataset)):
            if os.path.isdir(os.path.join(args.dataset, d)):
                print(f"   • {d}")
        return

    base = os.path.join(args.dataset, args.scenario)
    if not os.path.isdir(base):
        print(f"❌ Does not exist: {base}")
        return

    mi, ma = get_frame_range(base, args.town, args.agent)
    if args.frame_end is None:
        args.frame_end = ma
    convert_scenario_to_mcap(base, args.town, args.town, args.frame, args.frame_end,
                              args.output, args.agent,
                              accumulate=not args.no_accumulate)


if __name__ == "__main__":
    main()
