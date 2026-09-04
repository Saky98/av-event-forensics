#!/usr/bin/env python3
"""Converts an accumulated PCD into an MCAP for Foxglove as an extra layer.

Adapted for the av-event-forensics project:
- input:  storage/deepaccident_accumulated.pcd (or --input)
- output: storage/deepaccident_accumulated.mcap (or --output)

Example:
    python3 scripts/python/make_accumulated_mcap.py
"""

import numpy as np
import pickle, os, math, struct, sys, argparse
from mcap.writer import Writer
from foxglove_schemas_flatbuffer import get_schema, resources as res
import flatbuffers

# Project root: scripts/python/.. -> root
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_INPUT = os.path.join(PROJECT_ROOT, "storage", "deepaccident_accumulated.pcd")
DEFAULT_OUTPUT = os.path.join(PROJECT_ROOT, "storage", "deepaccident_accumulated.mcap")

# Load the required foxglove schemas (the generated flatbuffer modules come from the pip package)
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

def build_pointcloud(builder, points, ts_ns, frame_id="ego_vehicle"):
    N = points.shape[0]
    sec = ts_ns // 1_000_000_000
    nsec = ts_ns % 1_000_000_000
    fb_frame = builder.CreateString(frame_id)
    
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
    prepend_offset = builder.PrependUOffsetTRelative
    prepend_offset(f_i)
    prepend_offset(f_z)
    prepend_offset(f_y)
    prepend_offset(f_x)
    fields_vec = builder.EndVector()
    
    point_stride = 16
    data_bytes = points.astype(np.float32).tobytes()
    data_vec = builder.CreateByteVector(data_bytes)
    
    def _p3(x, y, z):
        _P3_mod.Point3Start(builder)
        _P3_mod.Point3AddX(builder, x)
        _P3_mod.Point3AddY(builder, y)
        _P3_mod.Point3AddZ(builder, z)
        return _P3_mod.Point3End(builder)
    def _q(x, y, z, w):
        _Q_mod.QuaternionStart(builder)
        _Q_mod.QuaternionAddX(builder, x)
        _Q_mod.QuaternionAddY(builder, y)
        _Q_mod.QuaternionAddZ(builder, z)
        _Q_mod.QuaternionAddW(builder, w)
        return _Q_mod.QuaternionEnd(builder)
    
    pos = _p3(0.0, 0.0, 0.0)
    quat = _q(0.0, 0.0, 0.0, 1.0)
    _Pose_mod.PoseStart(builder)
    _Pose_mod.PoseAddPosition(builder, pos)
    _Pose_mod.PoseAddOrientation(builder, quat)
    pc_pose = _Pose_mod.PoseEnd(builder)
    
    _PC_mod.PointCloudStart(builder)
    _PC_mod.PointCloudAddTimestamp(builder, _Time_mod.CreateTime(builder, sec, nsec))
    _PC_mod.PointCloudAddFrameId(builder, fb_frame)
    _PC_mod.PointCloudAddPose(builder, pc_pose)
    _PC_mod.PointCloudAddPointStride(builder, point_stride)
    _PC_mod.PointCloudAddFields(builder, fields_vec)
    _PC_mod.PointCloudAddData(builder, data_vec)
    pc = _PC_mod.PointCloudEnd(builder)
    builder.Finish(pc)
    return bytes(builder.Output())


# Load the accumulated PCD
parser = argparse.ArgumentParser(description="Accumulated PCD -> MCAP (Foxglove)")
parser.add_argument("--input", default=DEFAULT_INPUT, help="path to the accumulated PCD")
parser.add_argument("--output", default=DEFAULT_OUTPUT, help="output MCAP file")
args = parser.parse_args()

print("Loading PCD...")
pcd_path = args.input
pts = []
with open(pcd_path) as f:
    lines = f.readlines()

# Skip header
data_start = 0
for i, l in enumerate(lines):
    if l.startswith("DATA"):
        data_start = i + 1
        break

for l in lines[data_start:]:
    parts = l.strip().split()
    if len(parts) >= 4:
        pts.append([float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])])

points = np.array(pts, dtype=np.float64)
print(f"Loaded {points.shape[0]:,} points")

# Create the MCAP
out_path = args.output
writer = Writer(output=out_path)
writer.start()

schema_id = writer.register_schema(
    name="foxglove.PointCloud", encoding="flatbuffer",
    data=get_schema("PointCloud"),
)

channel_id = writer.register_channel(
    topic="/lidar/accumulated_points", message_encoding="flatbuffer",
    schema_id=schema_id,
)

builder = flatbuffers.Builder(20_000_000)
ts_ns = 1700000000 * 1_000_000_000

print("Building FlatBuffer...")
pc_data = build_pointcloud(builder, points, ts_ns, "ego_vehicle")

print("Writing to MCAP...")
writer.add_message(
    channel_id=channel_id, log_time=ts_ns,
    data=pc_data, publish_time=ts_ns,
)

writer.finish()
mb = os.path.getsize(out_path) / 1024 / 1024
print(f"✅ MCAP written: {out_path} ({mb:.1f} MB)")
print(f"   Topic: /lidar/accumulated_points")
print(f"   Frame: ego_vehicle")
print(f"   Points: {points.shape[0]:,}")
