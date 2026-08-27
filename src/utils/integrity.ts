/**
 * Integrity snapshot & registry (chain-of-custody simulation).
 *
 * On the FIRST time a given MCAP is opened, the app stores a "fingerprint"
 * snapshot: the SHA-256 of the whole file plus the per-frame hash chain.
 * The snapshot is keyed in IndexedDB by its own snapshot hash (the file name
 * = hash idea), and a small registry maps each MCAP filename to that
 * snapshot hash. On every later open the app checks the registry, loads the
 * stored snapshot and compares it against the freshly computed values to
 * report INTACT / MODIFIED.
 *
 * Everything is local (IndexedDB) so the app stays read-only on disk.
 */

export interface IntegritySnapshot {
  /** SHA-256 of the whole MCAP file (hex). */
  fileHash: string;
  /** Per-frame chain: one hash per frame, computed the same way as the UI. */
  frameChain: string[];
  /** ISO timestamp when the snapshot was first recorded. */
  createdAt: string;
}

export interface IntegrityRegistryEntry {
  /** MCAP file name used as the lookup key. */
  fileName: string;
  /** Key of the stored snapshot (derived from the file hash). */
  snapshotHash: string;
}

export interface IntegrityComparison {
  /** Snapshot exists for this file and matches the current data. */
  intact: boolean;
  /** Snapshot exists but the file hash differs (file modified). */
  mismatchFile: boolean;
  /** Snapshot exists and file hash matches, but the frame chain differs. */
  mismatchChain: boolean;
  /** No snapshot recorded yet (first open, or unknown file). */
  noSnapshot: boolean;
  /** Short derived snapshot key (first 8 hex chars) when present. */
  snapshotShort?: string;
}

const DB_NAME = 'av-forensics-integrity';
const DB_VERSION = 1;
const SNAPSHOT_STORE = 'snapshots';
const REGISTRY_STORE = 'registry';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE);
      }
      if (!db.objectStoreNames.contains(REGISTRY_STORE)) {
        db.createObjectStore(REGISTRY_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Reads a value from a key/value object store. */
async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(store, 'readonly');
  return idbRequest(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

/** Writes a value into a key/value object store. */
async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSnapshot(snapshotHash: string): Promise<IntegritySnapshot | undefined> {
  return idbGet<IntegritySnapshot>(SNAPSHOT_STORE, snapshotHash);
}

export async function getRegistryEntry(fileName: string): Promise<IntegrityRegistryEntry | undefined> {
  return idbGet<IntegrityRegistryEntry>(REGISTRY_STORE, fileName);
}

/**
 * Records a snapshot and registers the file in the registry.
 * The snapshot key is derived from the file hash (name = hash).
 */
export async function saveIntegritySnapshot(
  fileName: string,
  snapshot: IntegritySnapshot,
): Promise<IntegrityRegistryEntry> {
  const snapshotHash = snapshot.fileHash;
  await idbPut(SNAPSHOT_STORE, snapshotHash, snapshot);
  const entry: IntegrityRegistryEntry = { fileName, snapshotHash };
  await idbPut(REGISTRY_STORE, fileName, entry);
  return entry;
}

/**
 * Compares the currently computed data against any stored snapshot for this
 * file. Returns a comparison summary without writing anything.
 */
export async function compareIntegrity(
  fileName: string,
  currentFileHash: string,
  currentFrameChain: string[],
): Promise<IntegrityComparison> {
  const entry = await getRegistryEntry(fileName);
  if (!entry) {
    return { intact: false, mismatchFile: false, mismatchChain: false, noSnapshot: true };
  }
  const snapshot = await getSnapshot(entry.snapshotHash);
  if (!snapshot) {
    return { intact: false, mismatchFile: false, mismatchChain: false, noSnapshot: true };
  }
  const fileMatches = snapshot.fileHash === currentFileHash;
  const chainMatches = chainsEqual(snapshot.frameChain, currentFrameChain);
  return {
    intact: fileMatches && chainMatches,
    mismatchFile: !fileMatches,
    mismatchChain: fileMatches && !chainMatches,
    noSnapshot: false,
    snapshotShort: snapshot.fileHash.slice(0, 8),
  };
}

function chainsEqual(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
