import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { setExpectedHash } from '../../store/appStore';
import { formatBytes } from '../../utils/mcap';
import {
  buildChainRecords,
  checkChain,
  computeChain,
  shortHash,
  type ChainCheck,
  type ChainLink,
} from '../../utils/forensics';
import './ForensicPanel.css';

/**
 * Phase 6 — Forensic Validation & Hashing.
 *
 * Three cards:
 *  1. File integrity  — SHA-256 of the raw file (computed in the worker) +
 *     optional expected-hash comparison (green/red).
 *  2. Provenance      — conversion metadata (library, profile, counts) and a
 *     note about MCAP metadata/provenance records.
 *  3. Hash chain      — per-frame chain of custody (SHA-256 linked ledger):
 *     verify integrity, simulate tampering of one frame and watch the chain
 *     break from that point on.
 */

const ForensicPanel: React.FC = () => {
  const dispatch = useDispatch();
  const {
    fileInfo,
    fileHash,
    expectedHash,
    telemetry,
    events,
    currentFile,
  } = useSelector((state: RootState) => state.app);

  const [originalChain, setOriginalChain] = useState<ChainLink[] | null>(null);
  const [currentChain, setCurrentChain] = useState<ChainLink[] | null>(null);
  const [tamperedFrame, setTamperedFrame] = useState<number | null>(null);
  const [chainCheck, setChainCheck] = useState<ChainCheck | null>(null);
  const [copied, setCopied] = useState(false);

  // Recompute the chain when the source data changes. (State is only touched
  // in async callbacks; when there is no telemetry the chain simply stays
  // empty until data arrives — the panel unmounts on file close anyway.)
  useEffect(() => {
    if (!telemetry) {
      return;
    }
    let cancelled = false;
    const collisionTimes = events?.collision?.t ?? null;
    const collisionValues = events?.collision?.v ?? null;
    const brakingTimes = events?.braking.map((b) => b.t) ?? [];
    const records = buildChainRecords(telemetry, collisionTimes, collisionValues, brakingTimes);
    void computeChain(records).then((chain) => {
      if (cancelled) {
        return;
      }
      setOriginalChain(chain);
      setCurrentChain(chain);
      setTamperedFrame(null);
      setChainCheck({ firstDivergence: -1, intact: true });
    });
    return () => {
      cancelled = true;
    };
  }, [telemetry, events]);

  const verifyChain = useCallback(async () => {
    if (!originalChain) {
      return;
    }
    if (tamperedFrame === null) {
      setChainCheck({ firstDivergence: -1, intact: true });
      return;
    }
    // Recomputed chain is already `currentChain`; compare to original.
    if (currentChain) {
      setChainCheck(checkChain(originalChain, currentChain));
    }
  }, [originalChain, currentChain, tamperedFrame]);

  const simulateTamper = useCallback(async () => {
    if (!originalChain) {
      return;
    }
    const frame = Math.floor(originalChain.length / 2);
    const records = originalChain.map((link) => ({ ...link.record }));
    // Alter one value — e.g. bump velocity by 30% (a "modified" record).
    const rec = records[frame];
    rec.velocity = Number.isFinite(rec.velocity) ? rec.velocity * 1.3 : 17.0;
    const tampered = await computeChain(records);
    setCurrentChain(tampered);
    setTamperedFrame(frame);
    setChainCheck({ firstDivergence: frame, intact: false });
  }, [originalChain]);

  const resetChain = useCallback(() => {
    setCurrentChain(originalChain);
    setTamperedFrame(null);
    setChainCheck(originalChain ? { firstDivergence: -1, intact: true } : null);
  }, [originalChain]);

  const copyHash = useCallback(async () => {
    if (!fileHash) {
      return;
    }
    try {
      await navigator.clipboard.writeText(fileHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  }, [fileHash]);

  const hashMatch = useMemo(() => {
    if (!fileHash || !expectedHash) {
      return null;
    }
    const norm = expectedHash.trim().toLowerCase();
    return norm.length === 64 ? fileHash === norm : null;
  }, [fileHash, expectedHash]);

  const expectedHashValid = expectedHash !== null && expectedHash.trim().length === 64;
  const integrityStatus = hashMatch === null ? 'neutral' : hashMatch ? 'ok' : 'bad';

  return (
    <div className="forensic-panel">
      {/* ---- 1. File integrity ---- */}
      <section className="forensic-card">
        <div className="forensic-card-header">
          <span className="forensic-card-title">File Integrity — SHA-256</span>
          <span className={`forensic-badge ${integrityStatus}`}>
            {integrityStatus === 'ok' ? '✓ INTACT' : integrityStatus === 'bad' ? '✗ MISMATCH' : '—'}
          </span>
        </div>
        <div className="forensic-row">
          <span className="forensic-label">Computed hash</span>
          {fileHash ? (
            <>
              <code className="forensic-hash">{fileHash}</code>
              <button className="forensic-btn" onClick={copyHash} title="Copy hash">
                {copied ? 'copied ✓' : 'copy'}
              </button>
            </>
          ) : (
            <span className="forensic-muted">computing…</span>
          )}
        </div>
        <div className="forensic-row">
          <span className="forensic-label">Expected hash</span>
          <input
            className="forensic-input"
            type="text"
            placeholder="paste expected SHA-256 (64 hex chars) or leave empty"
            value={expectedHash ?? ''}
            onChange={(e) => dispatch(setExpectedHash(e.target.value.trim() === '' ? null : e.target.value))}
            spellCheck={false}
          />
          {expectedHashValid && integrityStatus !== 'neutral' && (
            <span className={`forensic-inline ${integrityStatus === 'ok' ? 'ok' : 'bad'}`}>
              {integrityStatus === 'ok' ? 'hash matches' : 'hash does NOT match'}
            </span>
          )}
        </div>
        <p className="forensic-hint">
          SHA-256 is computed over the raw bytes of the opened file (in the decoding worker).
          Compare it against the hash produced by <code>sha256sum</code> at capture time to prove
          the file was not altered.
        </p>
      </section>

      {/* ---- 2. Provenance / conversion metadata ---- */}
      <section className="forensic-card">
        <div className="forensic-card-header">
          <span className="forensic-card-title">Provenance &amp; Conversion Metadata</span>
        </div>
        {fileInfo ? (
          <div className="forensic-meta-grid">
            <div className="forensic-meta-item">
              <span className="forensic-meta-label">File</span>
              <span className="forensic-meta-value" title={fileInfo.name}>{fileInfo.name}</span>
            </div>
            <div className="forensic-meta-item">
              <span className="forensic-meta-label">Size</span>
              <span className="forensic-meta-value">{formatBytes(fileInfo.size)}</span>
            </div>
            <div className="forensic-meta-item">
              <span className="forensic-meta-label">Library</span>
              <span className="forensic-meta-value">{fileInfo.library || '—'}</span>
            </div>
            <div className="forensic-meta-item">
              <span className="forensic-meta-label">Profile</span>
              <span className="forensic-meta-value">{fileInfo.profile || '—'}</span>
            </div>
            <div className="forensic-meta-item">
              <span className="forensic-meta-label">Messages</span>
              <span className="forensic-meta-value">{fileInfo.messageCount.toLocaleString()}</span>
            </div>
            <div className="forensic-meta-item">
              <span className="forensic-meta-label">Channels / Schemas</span>
              <span className="forensic-meta-value">
                {fileInfo.channelCount} / {fileInfo.schemaCount}
              </span>
            </div>
            <div className="forensic-meta-item">
              <span className="forensic-meta-label">Compression</span>
              <span className="forensic-meta-value">
                {fileInfo.compressionFormats.length ? fileInfo.compressionFormats.join(', ') : 'none'}
              </span>
            </div>
            <div className="forensic-meta-item">
              <span className="forensic-meta-label">MCAP metadata records</span>
              <span className="forensic-meta-value">0 (not written by converter)</span>
            </div>
          </div>
        ) : (
          <p className="forensic-muted">No file loaded.</p>
        )}
        <p className="forensic-hint">
          The MCAP <code>library</code> header records which tool produced the file; a provenance /
          metadata record would carry conversion parameters. These DeepAccident files were written
          by <code>python mcap 1.3.1</code> without provenance records.
        </p>
      </section>

      {/* ---- 3. Frame hash chain ---- */}
      <section className="forensic-card">
        <div className="forensic-card-header">
          <span className="forensic-card-title">Frame Hash Chain (chain of custody)</span>
          <span
            className={`forensic-badge ${
              chainCheck ? (chainCheck.intact ? 'ok' : 'bad') : 'neutral'
            }`}
          >
            {chainCheck
              ? chainCheck.intact
                ? `✓ ${originalChain?.length ?? 0} links intact`
                : `✗ broke at link ${chainCheck.firstDivergence}`
              : '—'}
          </span>
        </div>
        {!originalChain || originalChain.length === 0 ? (
          <p className="forensic-muted">
            No telemetry available to build the chain. Load a file with /ego/velocity,
            /ego/acceleration or /ego/pose.
          </p>
        ) : (
          <>
            <div className="forensic-toolbar">
              <button className="forensic-btn" onClick={verifyChain} disabled={!currentChain}>
                Verify chain
              </button>
              <button className="forensic-btn" onClick={simulateTamper} disabled={tamperedFrame !== null}>
                Simulate tamper (frame {tamperedFrame ?? Math.floor(originalChain.length / 2)})
              </button>
              <button className="forensic-btn" onClick={resetChain} disabled={tamperedFrame === null}>
                Reset
              </button>
              <span className="forensic-hint">
                Each link = SHA-256(prevHash | frameRecord). Any change breaks every following link.
              </span>
            </div>
            <div className="forensic-chain">
              {currentChain?.map((link) => {
                const isTampered = tamperedFrame !== null && link.index >= tamperedFrame;
                const r = link.record;
                return (
                  <div key={link.index} className={`forensic-link ${isTampered ? 'tampered' : ''}`}>
                    <span className="forensic-link-frame">{link.index}</span>
                    <span className="forensic-link-t">{r.t.toFixed(2)}s</span>
                    <span className="forensic-link-v">
                      v {Number.isFinite(r.velocity) ? r.velocity.toFixed(1) : '—'}
                    </span>
                    <span className="forensic-link-a">
                      a {Number.isFinite(r.acceleration) ? r.acceleration.toFixed(1) : '—'}
                    </span>
                    <span className="forensic-link-flags">
                      {r.collision ? '💥' : ''}
                      {r.braking ? '🛑' : ''}
                    </span>
                    <code className="forensic-link-hash" title={link.hash}>
                      {shortHash(link.hash)}…
                    </code>
                    <span
                      className={`forensic-link-dot ${
                        tamperedFrame !== null && link.index < tamperedFrame ? 'ok' : isTampered ? 'bad' : ''
                      }`}
                      title={
                        tamperedFrame !== null && link.index < tamperedFrame
                          ? 'intact (before tamper point)'
                          : isTampered
                            ? 'broken — hash diverges from original'
                            : 'intact'
                      }
                    />
                  </div>
                );
              })}
            </div>
            <p className="forensic-hint">
              {tamperedFrame === null
                ? 'Simulate an alteration of one frame’s record to see the chain of custody break.'
                : `Tampered frame ${tamperedFrame}: every link from it onward no longer matches the original chain — this is how a hash chain proves where data was modified.`}
            </p>
          </>
        )}
      </section>

      {currentFile && <p className="forensic-footer">Session file: {currentFile.name}</p>}
    </div>
  );
};

export default ForensicPanel;
