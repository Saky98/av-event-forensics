/**
 * Shares the user's LiDAR camera view (position + orbit target) so the
 * forensic report snapshot can reuse the exact framing the operator set on the
 * LiDAR tab — instead of a hardcoded default angle.
 *
 * This is a tiny module-level cache (no React), written each frame by
 * LidarView and read by the snapshot generator at export time.
 */

export interface LidarViewState {
  position: [number, number, number];
  target: [number, number, number];
}

const DEFAULT_POSITION: [number, number, number] = [45, 42, 65];
const DEFAULT_TARGET: [number, number, number] = [0, 0, 0];

let view: LidarViewState | null = null;

/** Called by LidarView's render loop with the live camera pose. */
export function setLidarViewState(position: [number, number, number], target: [number, number, number]): void {
  view = { position, target };
}

/** Called by the snapshot generator; falls back to the default framing. */
export function getLidarViewState(): LidarViewState {
  if (view && view.position.every(Number.isFinite) && view.target.every(Number.isFinite)) {
    return view;
  }
  return { position: DEFAULT_POSITION, target: DEFAULT_TARGET };
}
