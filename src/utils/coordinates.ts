/**
 * Coordinate helpers for rendering ROS-style data (x forward, y left, z up)
 * in Three.js (y up). Shared between the LidarView component and tests.
 */

/** ROS (x, y, z) -> Three (x, z, -y). */
export function rosToThree(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

/** ROS quaternion (qx, qy, qz, qw) -> Three (qx, qz, -qy, qw). */
export function rosQuatToThree(q: [number, number, number, number]): [number, number, number, number] {
  return [q[0], q[2], -q[1], q[3]];
}

/** Transforms an interleaved xyz Float32Array in place from ROS to Three axes. */
export function transformPositions(positions: Float32Array): void {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    positions[i] = x;
    positions[i + 1] = z;
    positions[i + 2] = -y;
  }
}

/** Yaw (heading) around the up axis from a ROS quaternion. */
export function yawFromQuaternion(q: [number, number, number, number]): number {
  const [x, y, z, w] = q;
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}
