/**
 * Phase 6 — forensic helpers: SHA-256 hashing and a per-frame hash chain
 * (chain of custody simulation).
 *
 * The hash chain works like a hash-linked ledger: every frame's record is
 * hashed together with the previous frame's hash, so any modification of a
 * record breaks every subsequent link. The UI can "simulate tampering" by
 * altering one record and recomputing the chain — the divergence from the
 * original chain marks exactly where the record was changed.
 *
 * All functions here are pure and use `crypto.subtle`, so the same code runs
 * in the browser and in Node smoke tests.
 */

import type { TelemetryData } from '../types';

/** Converts bytes to a lowercase hex string. */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** SHA-256 of a UTF-8 string, hex. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

export interface ChainRecord {
  frame: number;
  /** Relative time in seconds (2 decimals → deterministic). */
  t: number;
  velocity: number;
  acceleration: number;
  x: number;
  y: number;
  yaw: number;
  collision: boolean;
  braking: boolean;
}

export interface ChainLink {
  index: number;
  record: ChainRecord;
  /** Canonical string that was hashed (kept for display / debugging). */
  canonical: string;
  hash: string;
}

const CHAIN_SEED = 'av-event-forensics::chain-v1';

/** Serializes a record deterministically (stable field order, rounded values). */
function canonicalRecord(record: ChainRecord): string {
  const round = (n: number, digits: number): number => {
    if (!Number.isFinite(n)) {
      return 0;
    }
    const f = 10 ** digits;
    return Math.round(n * f) / f;
  };
  return JSON.stringify({
    frame: record.frame,
    t: round(record.t, 6),
    velocity: round(record.velocity, 4),
    acceleration: round(record.acceleration, 4),
    x: round(record.x, 4),
    y: round(record.y, 4),
    yaw: round(record.yaw, 4),
    collision: record.collision,
    braking: record.braking,
  });
}

/**
 * Builds one chain record per frame from the telemetry series. Records are
 * aligned by frame index; collision/braking flags come from the event topics
 * (matched to the nearest frame time).
 */
export function buildChainRecords(
  telemetry: TelemetryData,
  collisionTimes: number[] | null,
  collisionValues: Int8Array | number[] | null,
  brakingTimes: number[],
): ChainRecord[] {
  const t = telemetry.pose?.t ?? telemetry.velocity?.t ?? telemetry.acceleration?.t ?? [];
  const velocity = telemetry.velocity?.v ?? [];
  const acceleration = telemetry.acceleration?.v ?? [];
  const xs = telemetry.pose?.x ?? [];
  const ys = telemetry.pose?.y ?? [];
  const yaws = telemetry.pose?.yaw ?? [];

  const count = t.length;
  const records: ChainRecord[] = [];
  for (let i = 0; i < count; i++) {
    records.push({
      frame: i,
      t: t[i] ?? 0,
      velocity: velocity[i] ?? NaN,
      acceleration: acceleration[i] ?? NaN,
      x: xs[i] ?? NaN,
      y: ys[i] ?? NaN,
      yaw: yaws[i] ?? NaN,
      collision: nearestFlag(collisionTimes, collisionValues, t[i]),
      braking: brakingTimes.some((bt) => Math.abs(bt - t[i]) < 0.06),
    });
  }
  return records;
}

function nearestFlag(
  times: number[] | null,
  values: Int8Array | number[] | null,
  target: number,
): boolean {
  if (!times || !values || times.length === 0) {
    return false;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(times[i] - target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return bestDist < 0.06 && values[best] === 1;
}

/**
 * Computes the hash chain: hash[i] = SHA-256(seed | hash[i-1] | canonical[i]),
 * with hash[-1] = seed. Returns links (original or tampered, depending on the
 * records passed in).
 */
export async function computeChain(records: ChainRecord[]): Promise<ChainLink[]> {
  const links: ChainLink[] = [];
  let prev = CHAIN_SEED;
  for (let i = 0; i < records.length; i++) {
    const canonical = canonicalRecord(records[i]);
    const hash = await sha256Hex(`${prev}|${canonical}`);
    links.push({ index: i, record: records[i], canonical, hash });
    prev = hash;
  }
  return links;
}

export interface ChainCheck {
  /** Index of the first link whose hash differs from the original, or -1. */
  firstDivergence: number;
  /** True when every link matches the original chain. */
  intact: boolean;
}

/** Compares a recomputed chain against the original; returns where they differ. */
export function checkChain(original: ChainLink[], recomputed: ChainLink[]): ChainCheck {
  const limit = Math.min(original.length, recomputed.length);
  for (let i = 0; i < limit; i++) {
    if (original[i].hash !== recomputed[i].hash) {
      return { firstDivergence: i, intact: false };
    }
  }
  return { firstDivergence: -1, intact: original.length === recomputed.length };
}

/** Short display form of a hash (first 8 hex chars). */
export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}
