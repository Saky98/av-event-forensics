import React, { useCallback, useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { RootState } from '../../store';
import { setCurrentTimestamp } from '../../store/appStore';
import type { TelemetryData, TimeRange } from '../../types';
import './TelemetryPanel.css';

/**
 * Phase 5 — Telemetry & Charts.
 *
 * uPlot chart of ego velocity / acceleration (single scale) over relative
 * time. A vertical cursor tracks the global timeline timestamp; clicking the
 * chart seeks the timeline.
 */

const SERIES_COLORS = {
  velocity: '#4da6ff',
  acceleration: '#ff9f43',
};

/** Legend entries: one per available telemetry series → color + label. */
function buildLegend(telemetry: TelemetryData | null): { color: string; label: string; unit: string }[] {
  if (!telemetry) {
    return [];
  }
  const entries: { color: string; label: string; unit: string }[] = [];
  if (telemetry.velocity?.t?.length) {
    entries.push({ color: SERIES_COLORS.velocity, label: 'Velocity', unit: 'm/s' });
  }
  if (telemetry.acceleration?.t?.length) {
    entries.push({ color: SERIES_COLORS.acceleration, label: 'Acceleration', unit: 'm/s²' });
  }
  return entries;
}

/** Builds the uPlot data table [x, velocity, acceleration]. */
function buildData(telemetry: TelemetryData): uPlot.AlignedData {
  const x: number[] = telemetry.velocity?.t ?? telemetry.acceleration?.t ?? [];
  const velocity: number[] = telemetry.velocity?.v ?? [];
  const acceleration: number[] = telemetry.acceleration?.v ?? [];
  return [x, velocity, acceleration];
}

const TelemetryPanel: React.FC = () => {
  const dispatch = useDispatch();
  const { telemetry, currentTimestamp, timeRange } = useSelector((state: RootState) => state.app);
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  // Latest time range for the click-to-seek handler (plot is created once).
  const timeRangeRef = useRef<TimeRange | null>(timeRange);
  useEffect(() => {
    timeRangeRef.current = timeRange;
  }, [timeRange]);
  // Latest timestamp for the draw hook's cursor placement (avoids stale refs).
  const timestampRef = useRef(currentTimestamp);
  useEffect(() => {
    timestampRef.current = currentTimestamp;
  }, [currentTimestamp]);

  // Places the vertical timeline cursor at the timestamp read from the refs.
  // Called from the uPlot draw hook AND the timestamp effect so the marker is
  // always correct even after the panel is re-mounted on tab switch.
  const positionCursor = useCallback((plot: uPlot, cursor: HTMLDivElement) => {
    const range = timeRangeRef.current;
    if (!range) {
      return;
    }
    const relSec = Number(timestampRef.current - range.start) / 1e9;
    const totalSec = Number(range.end - range.start) / 1e9;
    if (!Number.isFinite(relSec) || !Number.isFinite(totalSec) || totalSec <= 0) {
      return;
    }
    const frac = Math.max(0, Math.min(1, relSec / totalSec));
    const valPos = plot.valToPos(relSec, 'x');
    const left = Number.isFinite(valPos) ? valPos : frac * plot.bbox.width;
    cursor.style.left = `${left}px`;
  }, []);

  // Create the plot once (empty), attach cursor/click/resize behavior.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const opts: uPlot.Options = {
      width: container.clientWidth,
      height: container.clientHeight || 260,
      padding: [12, 10, 8, 8],
      legend: { show: false },
      scales: {
        x: { time: false },
        y: { auto: true },
      },
      // left/top/width/height are BBox fields the type requires (unused at runtime).
      select: { show: true, left: 0, top: 0, width: 0, height: 0 },
      axes: [
        {
          stroke: '#8b9aab',
          grid: { stroke: 'rgba(139,154,171,0.15)' },
          ticks: { stroke: '#8b9aab' },
          font: '11px system-ui, sans-serif',
        },
        { stroke: '#8b9aab', grid: { stroke: 'rgba(139,154,171,0.08)' }, ticks: { stroke: '#8b9aab' }, font: '11px system-ui, sans-serif' },
      ],
      series: [
        { label: 'time (s)' },
        {
          label: 'Velocity (m/s)',
          scale: 'y',
          stroke: SERIES_COLORS.velocity,
          width: 2,
          points: { show: false },
        },
        {
          label: 'Acceleration (m/s²)',
          scale: 'y',
          stroke: SERIES_COLORS.acceleration,
          width: 1.5,
          points: { show: false },
        },
      ],
      cursor: { show: true },
      hooks: {
        ready: [
          (u) => {
            // Click-to-seek: move the timeline to the clicked x position.
            u.over.addEventListener('click', (event: MouseEvent) => {
              const range = timeRangeRef.current;
              if (!range) {
                return;
              }
              const relSec = u.posToVal(event.offsetX, 'x');
              const ns = range.start + BigInt(Math.round(relSec * 1e9));
              dispatch(setCurrentTimestamp(ns));
            });
            // Double-click resets the zoom.
            u.over.addEventListener('dblclick', () => {
              (u as unknown as { resetZoom(): void }).resetZoom();
            });
          },
        ],
        draw: [
          (u) => {
            // Re-place the cursor on every draw so it stays correct even when
            // data/scale settle asynchronously after a tab re-mount.
            const cursor = cursorRef.current;
            if (cursor) {
              positionCursor(u, cursor);
            }
          },
        ],
      },
    };
    const plot = new uPlot(opts, [new Array(0), [], [], []], container);
    plotRef.current = plot;

    // Timeline cursor overlay (lives inside the plot's over div).
    const cursor = document.createElement('div');
    cursor.className = 'telemetry-cursor';
    plot.over.appendChild(cursor);
    cursorRef.current = cursor;

    const resizeObserver = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        plot.setSize({ width: container.clientWidth, height: container.clientHeight });
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      cursor.remove();
      cursorRef.current = null;
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Data updates when telemetry arrives. Also pin the x-axis to the full
  // recording range so the chart and the timeline cursor stay in sync all the
  // way to the end of the recording.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || !telemetry) {
      return;
    }
    plot.setData(buildData(telemetry));
    if (timeRange) {
      const durSec = Number(timeRange.end - timeRange.start) / 1e9;
      if (Number.isFinite(durSec) && durSec > 0) {
        plot.setScale('x', { min: 0, max: durSec });
      }
    }
  }, [telemetry, timeRange]);

  // Vertical cursor tracks the timeline during playback/scrubbing. Re-mounts
  // are additionally covered by the draw hook, which re-places the cursor when
  // the plot redraws (see positionCursor).
  useEffect(() => {
    const plot = plotRef.current;
    const cursor = cursorRef.current;
    if (plot && cursor) {
      positionCursor(plot, cursor);
    }
  }, [currentTimestamp, timeRange, positionCursor]);

  const hasSeries = telemetry && (telemetry.velocity || telemetry.acceleration);
  const legend = buildLegend(telemetry);

  return (
    <div className="telemetry-panel">
      <div className="telemetry-header">
        <span className="telemetry-title">Telemetry</span>
        {legend.length > 0 && (
          <div className="telemetry-legend">
            {legend.map((entry) => (
              <span key={entry.label} className="telemetry-legend-item">
                <span className="telemetry-legend-swatch" style={{ background: entry.color }} />
                {entry.label}{' '}
                <span className="telemetry-legend-unit">({entry.unit})</span>
              </span>
            ))}
          </div>
        )}
        <span className="telemetry-hint">click: seek · drag: zoom · double-click: reset</span>
      </div>
      {hasSeries ? (
        <div className="telemetry-plot" ref={containerRef} />
      ) : (
        <p className="telemetry-empty">No numeric telemetry topics in this recording.</p>
      )}
    </div>
  );
};

export default TelemetryPanel;
