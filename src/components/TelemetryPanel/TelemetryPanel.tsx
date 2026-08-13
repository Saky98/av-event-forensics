import React, { useEffect, useRef } from 'react';
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
 * uPlot chart of ego velocity / acceleration (left scale) and heading
 * (right scale, degrees) over relative time. A vertical cursor tracks the
 * global timeline timestamp; clicking the chart seeks the timeline.
 */

const SERIES_COLORS = {
  velocity: '#4da6ff',
  acceleration: '#ff9f43',
  heading: '#51cf66',
};

/** Builds the uPlot data table [x, velocity, acceleration, headingDeg]. */
function buildData(telemetry: TelemetryData): uPlot.AlignedData {
  const x: number[] = telemetry.velocity?.t ?? telemetry.acceleration?.t ?? telemetry.pose?.t ?? [];
  const velocity: number[] = telemetry.velocity?.v ?? [];
  const acceleration: number[] = telemetry.acceleration?.v ?? [];
  const heading: number[] = telemetry.pose ? telemetry.pose.yaw.map((y) => (y * 180) / Math.PI) : [];
  return [x, velocity, acceleration, heading];
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
      legend: { show: true },
      scales: {
        x: { time: false },
        y: { auto: true },
        y2: { auto: true },
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
        {
          stroke: '#6b7a8a',
          grid: { show: false },
          ticks: { stroke: '#6b7a8a' },
          font: '11px system-ui, sans-serif',
          side: 1,
          size: 40,
        },
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
        {
          label: 'Heading (°)',
          scale: 'y2',
          stroke: SERIES_COLORS.heading,
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

  // Data updates when telemetry arrives.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || !telemetry) {
      return;
    }
    plot.setData(buildData(telemetry));
  }, [telemetry]);

  // Vertical cursor follows the timeline.
  useEffect(() => {
    const plot = plotRef.current;
    const cursor = cursorRef.current;
    if (!plot || !cursor || !telemetry || !timeRange) {
      return;
    }
    const relSec = Number(currentTimestamp - timeRange.start) / 1e9;
    // uPlot resolves the x scale only on the first draw (RAF), so valToPos may
    // return NaN right after setData. Compute the position deterministically
    // from the scale when resolved, otherwise from the data bounds.
    const xs = plot.data[0];
    if (xs.length < 2) {
      return;
    }
    const xScale = plot.scales.x;
    const min = xScale.min != null ? xScale.min : xs[0];
    const max = xScale.max != null ? xScale.max : xs[xs.length - 1];
    const span = max - min;
    if (!Number.isFinite(span) || span <= 0) {
      return;
    }
    const left = ((relSec - min) / span) * plot.bbox.width;
    cursor.style.left = `${left}px`;
  }, [currentTimestamp, telemetry, timeRange]);

  const hasSeries = telemetry && (telemetry.velocity || telemetry.acceleration || telemetry.pose);

  return (
    <div className="telemetry-panel">
      <div className="telemetry-header">
        <span className="telemetry-title">Telemetry</span>
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
