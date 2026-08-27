/**
 * Report generator: builds a self-contained, presentable HTML document from
 * the forensic data (file integrity + hash chain + provenance + baseline).
 * Used by the Forensic tab "Export HTML report" button.
 */

export interface ReportRow {
  frame: number;
  timeSec: string;
  expectedHash?: string;
  currentHash: string;
  matches: boolean;
}

export interface ReportData {
  fileName: string;
  library: string;
  sizeBytes: number;
  channels: number;
  schemas: number;
  messages: number;
  compression: string;
  computedHash: string;
  expectedHash: string;
  hashMatches: boolean | null;
  baseline: {
    hasSnapshot: boolean;
    intact: boolean;
    snapshotShort?: string;
  };
  chain: {
    status: 'intact' | 'modified' | 'unknown';
    firstDivergence: number;
    rows: ReportRow[];
  };
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Builds a self-contained HTML report from the given data. */
export function buildHtmlReport(data: ReportData): string {
  const fileStatus =
    data.hashMatches === null
      ? '<span class="badge neutral">n/a</span>'
      : data.hashMatches
        ? '<span class="badge ok">INTACT</span>'
        : '<span class="badge bad">MODIFIED</span>';

  const chainStatus =
    data.chain.status === 'intact'
      ? '<span class="badge ok">INTACT</span>'
      : data.chain.status === 'modified'
        ? `<span class="badge bad">MODIFIED</span>`
        : '<span class="badge neutral">unknown</span>';

  const baselineBadge = data.baseline.hasSnapshot
    ? data.baseline.intact
      ? '<span class="badge ok">baseline intact</span>'
      : '<span class="badge bad">baseline mismatch</span>'
    : '<span class="badge neutral">no baseline</span>';

  const rowsHtml = data.chain.rows
    .map((r) => {
      const statusDot = r.matches ? '<span class="dot ok"></span>' : '<span class="dot bad"></span>';
      const expectedCell = r.expectedHash !== undefined && r.expectedHash !== r.currentHash
        ? `<code class="exp">${esc(r.expectedHash)}</code>`
        : '';
      const currentClass = r.matches ? 'now ok' : 'now bad';
      return `<tr>
        <td>${r.frame}</td>
        <td>${esc(r.timeSec)}s</td>
        <td>${expectedCell}</td>
        <td><code class="${currentClass}">${esc(r.currentHash)}</code></td>
        <td>${statusDot}</td>
      </tr>`;
    })
    .join('');

  const firstDivergenceNote =
    data.chain.status === 'modified'
      ? `<p class="note">First divergence from baseline at ${data.chain.firstDivergence}.</p>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Forensic Integrity Report</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #e6edf3; padding: 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 10px; text-transform: uppercase; letter-spacing: .05em; color: #9ecbff; border-bottom: 1px solid #2a3b4d; padding-bottom: 6px; }
  .meta { color: #8b9aab; font-size: 12px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #1b2633; word-break: break-all; }
  th { color: #6b7a8a; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  code.exp { color: #4ade80; background: rgba(74,222,128,.08); border: 1px solid rgba(74,222,128,.25); border-radius: 3px; padding: 1px 4px; display: block; }
  code.now { display: block; padding: 1px 4px; border-radius: 3px; }
  code.now.ok { color: #4ade80; }
  code.now.bad { color: #ff6b6b; background: rgba(255,107,107,.06); }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 11px; font-weight: 600; border: 1px solid; }
  .badge.ok { color: #4ade80; background: rgba(74,222,128,.12); border-color: rgba(74,222,128,.35); }
  .badge.bad { color: #ff6b6b; background: rgba(255,107,107,.12); border-color: rgba(255,107,107,.35); }
  .badge.neutral { color: #8b9aab; background: rgba(139,154,171,.1); border-color: rgba(139,154,171,.2); }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #3a4a5c; }
  .dot.ok { background: #4ade80; }
  .dot.bad { background: #ff6b6b; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
  .field { background: #10161f; border: 1px solid #1b2633; border-radius: 6px; padding: 8px 10px; }
  .field dt { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #6b7a8a; }
  .field dd { margin: 3px 0 0; font-size: 13px; }
  .note { color: #ffc46b; font-size: 12px; }
  .hash { font-family: ui-monospace, monospace; font-size: 12px; color: #9ecbff; word-break: break-all; }
</style>
</head>
<body>
  <h1>Forensic Integrity Report</h1>
  <p class="meta">Generated ${esc(new Date().toISOString())}</p>
  <h2>File</h2>
  <dl class="grid">
    <div class="field"><dt>File</dt><dd>${esc(data.fileName)}</dd></div>
    <div class="field"><dt>Producer (library)</dt><dd>${esc(data.library)}</dd></div>
    <div class="field"><dt>Content</dt><dd>${data.channels} ch · ${data.schemas} schemas · ${data.messages} msgs</dd></div>
    <div class="field"><dt>Size · Compression</dt><dd>${esc(formatBytes(data.sizeBytes))}${data.compression ? ' · ' + esc(data.compression) : ''}</dd></div>
  </dl>
  <h2>File Integrity — SHA-256</h2>
  <p>Computed: <span class="hash">${esc(data.computedHash)}</span></p>
  <p>Expected (baseline): <span class="hash">${esc(data.expectedHash)}</span></p>
  <p>Status: ${fileStatus} &nbsp; Baseline: ${baselineBadge}</p>
  <h2>Frame Hash Chain</h2>
  <p>Status: ${chainStatus}</p>
  ${firstDivergenceNote}
  <table>
    <thead><tr><th>#</th><th>time</th><th>expected hash</th><th>current hash</th><th></th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;
}

/** Triggers a browser download of the report as a single-file HTML. */
export function downloadHtmlReport(data: ReportData, fileNameBase: string): void {
  const html = buildHtmlReport(data);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileNameBase}-report.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
