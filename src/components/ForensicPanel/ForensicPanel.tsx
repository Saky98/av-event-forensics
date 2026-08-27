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
 *  2. Provenance      — producer (library), content counts and size/compression.
 *  3. Hash chain      — per-frame chain of custody (SHA-256 linked ledger).
 *     The "authentic" chain is recomputed from the source data; "Simulate
 *     tamper" alters a copy of one frame's record and recomputes the chain,
 *     so the displayed chain diverges from the authentic one from that frame
 *     on. "Verify" re-checks the displayed chain against the source data and
 *     always reports the result.
 */

const ForensicPanel: React.FC = () => {
  const dispatch = useDispatch();
  const { fileInfo, fileHash, expectedHash, telemetry, events } = useSelector(
    (state: RootState) => state.app,
  );

  const [authenticChain, setAuthenticChain] = useState<ChainLink[] | null>(null);
  const [displayedChain, setDisplayedChain] = useState<ChainLink[] | null>(null);
  const [tamperedFrame, setTamperedFrame] = useState<number | null>(null);
  const [chainCheck, setChainCheck] = useState<ChainCheck | null>(null);
  /** Result of the last Verify / tamper action (always visible feedback). */
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Authentic chain: recomputed from the source data whenever it changes.
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
      setAuthenticChain(chain);
      setDisplayedChain(chain);
      setTamperedFrame(null);
      setChainCheck({ firstDivergence: -1, intact: true });
      setVerifyMsg(`Authentic chain built from source data: ${chain.length} links.`);
    });
    return () => {
      cancelled = true;
    };
  }, [telemetry, events]);

  // Verify: compare the DISPLAYED chain against the authentic one (recomputed
  // from the source data) and always report the outcome.
  const verifyChain = useCallback(async () => {
    if (!authenticChain || !displayedChain) {
      return;
    }
    const result = checkChain(authenticChain, displayedChain);
    setChainCheck(result);
    setVerifyMsg(
      result.intact
        ? `Verified against source data: all ${authenticChain.length} links match the authentic chain.`
        : `Verified against source data: displayed chain diverges at link ${result.firstDivergence} ` +
            `— ${authenticChain.length - result.firstDivergence} links no longer match. The data was modified.`,
    );
  }, [authenticChain, displayedChain]);

  const simulateTamper = useCallback(async () => {
    if (!authenticChain) {
      return;
    }
    const frame = Math.floor(authenticChain.length / 2);
    // Alter a copy of one record (velocity ×1.3) and recompute the chain.
    const records = authenticChain.map((link) => ({ ...link.record }));
    const rec = records[frame];
    rec.velocity = Number.isFinite(rec.velocity) ? rec.velocity * 1.3 : 17.0;
    const tampered = await computeChain(records);
    setDisplayedChain(tampered);
    setTamperedFrame(frame);
    setChainCheck({ firstDivergence: frame, intact: false });
    setVerifyMsg(
      `Tampered frame ${frame} (velocity ×1.3): links ${frame}..${authenticChain.length - 1} no longer match the source chain.`,
    );
  }, [authenticChain]);

  const resetChain = useCallback(() => {
    setDisplayedChain(authenticChain);
    setTamperedFrame(null);
    setChainCheck(authenticChain ? { firstDivergence: -1, intact: true } : null);
    setVerifyMsg(null);
  }, [authenticChain]);

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
          Computed over the raw file bytes; compare against the capture-time <code>sha256sum</code> to prove the file is unchanged.
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
              <span className="forensic-meta-label">Producer (library)</span>
              <span className="forensic-meta-value" title={fileInfo.library || 'unknown'}>
                {fileInfo.library || 'unknown'}
              </span>
            </div>
            <div className="forensic-meta-item">
              <span className="forensic-meta-label">Content</span>
              <span className="forensic-meta-value" title={`${fileInfo.messageCount} msgs in ${fileInfo.channelCount} channels / ${fileInfo.schemaCount} schemas`}>
                {fileInfo.channelCount} ch · {fileInfo.schemaCount} schemas · {fileInfo.messageCount.toLocaleString()} msgs
              </span>
            </div>
            <div className="forensic-meta-item">
              <span className="forensic-meta-label">Size · Compression</span>
              <span className="forensic-meta-value">
                {formatBytes(fileInfo.size)}
                {fileInfo.compressionFormats.length ? ` · ${fileInfo.compressionFormats.join(', ')}` : ''}
              </span>
            </div>
          </div>
        ) : (
          <p className="forensic-muted">No file loaded.</p>
        )}
        <p className="forensic-hint">
          The <code>library</code> header records which tool produced the file and links it to its provenance.
        </p>
      </section>

      {/* ---- 3. Frame hash chain ---- */}
      <section className="forensic-card">
        <div className="forensic-card-header">
          <span className="forensic-card-title">Frame Hash Chain (chain of custody)</span>
          <span className={`forensic-badge ${chainCheck ? (chainCheck.intact ? 'ok' : 'bad') : 'neutral'}`}>
            {chainCheck
              ? chainCheck.intact
                ? `✓ ${authenticChain?.length ?? 0} links intact`
                : `✗ broke at link ${chainCheck.firstDivergence}`
              : '—'}
          </span>
        </div>
        {!authenticChain || authenticChain.length === 0 ? (
          <p className="forensic-muted">
            No telemetry available to build the chain. Load a file with /ego/velocity,
            /ego/acceleration or /ego/pose.
          </p>
        ) : (
          <>
            <div className="forensic-toolbar">
              <button className="forensic-btn" onClick={verifyChain} disabled={!displayedChain}>
                Verify chain
              </button>
              <button className="forensic-btn" onClick={simulateTamper} disabled={tamperedFrame !== null}>
                Simulate tamper (frame {tamperedFrame ?? Math.floor(authenticChain.length / 2)})
              </button>
              <button className="forensic-btn" onClick={resetChain} disabled={tamperedFrame === null}>
                Reset
              </button>
            </div>
            {verifyMsg && (
              <p className={`forensic-verify-msg ${chainCheck?.intact ? 'ok' : 'bad'}`}>{verifyMsg}</p>
            )}
            <p className="forensic-hint">
              <span className="forensic-flag col">col</span> collision ·{' '}
              <span className="forensic-flag brk">brk</span> sudden braking · any change breaks every following link
            </p>
            <div className="forensic-chain">
              <div className="forensic-link forensic-link-header">
                <span className="forensic-link-frame">#</span>
                <span className="forensic-link-t">time</span>
                <span className="forensic-link-v">velocity m/s</span>
                <span className="forensic-link-flags">flags</span>
                <span className="forensic-link-dot" />
              </div>
              {displayedChain?.map((link) => {
                const isTampered = tamperedFrame !== null && link.index >= tamperedFrame;
                const r = link.record;
                return (
                  <div
                    key={link.index}
                    className={`forensic-link ${isTampered ? 'tampered' : ''}`}
                    title={isTampered ? `link ${link.index}: hash ${shortHash(link.hash)}… breaks the chain` : link.hash}
                  >
                    <span className="forensic-link-frame">{link.index}</span>
                    <span className="forensic-link-t">{r.t.toFixed(2)}s</span>
                    <span className="forensic-link-v">
                      {Number.isFinite(r.velocity) ? r.velocity.toFixed(1) : '—'}
                    </span>
                    <span className="forensic-link-flags">
                      {r.collision && (
                        <span className="forensic-flag col" title="collision detected">col</span>
                      )}
                      {r.braking && (
                        <span className="forensic-flag brk" title="sudden braking event">brk</span>
                      )}
                    </span>
                    <span
                      className={`forensic-link-dot ${
                        tamperedFrame !== null && link.index < tamperedFrame
                          ? 'ok'
                          : isTampered
                            ? 'bad'
                            : ''
                      }`}
                      title={
                        tamperedFrame !== null && link.index < tamperedFrame
                          ? 'intact (before tamper point)'
                          : isTampered
                            ? 'broken — hash diverges from authentic chain'
                            : 'intact'
                      }
                    />
                  </div>
                );
              })}
            </div>
            <p className="forensic-hint">
              {tamperedFrame === null
                ? 'Simulate a frame alteration to see the chain break, then verify against the source data.'
                : `Tamper at link ${tamperedFrame}: every link from here on fails — the chain shows exactly where data was modified.`}
            </p>
          </>
        )}
      </section>
    </div>
  );
};

export default ForensicPanel;
