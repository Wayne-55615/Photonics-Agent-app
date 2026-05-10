"use client";

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { useRef, useState } from "react";
import { SnpData } from "@/utils/snpParser";

export const SNP_COLORS = [
  "#2563eb","#7c3aed","#0891b2","#d97706",
  "#dc2626","#059669","#c026d3","#0284c7",
];

export type PlotMode = "power_db" | "mag_lin" | "phase_deg";

export const PLOT_MODE_LABELS: Record<PlotMode, string> = {
  power_db:  "Power (dB)",
  mag_lin:   "Magnitude",
  phase_deg: "Phase (°)",
};

interface Props {
  data: SnpData;
  selected: Set<string>;
  mode: PlotMode;
  /**
   * Per-trace color override keyed by label (e.g. "S31"). Falls back to
   * SNP_COLORS[index] when a label has no entry. Same override is shared
   * by the matching seed trace to keep seed/current pairs visually linked.
   */
  colorOverrides?: Record<string, string>;
  /**
   * Optional seed (baseline) sNp data overlaid on the same axes for replay/
   * optimize comparison. Seed traces share the latest's color but render
   * dashed and at lower opacity so the visual diff between seed and latest
   * is immediate. The two datasets do NOT need matching wavelength grids —
   * recharts plots each line on its own (wl, value) pairs. They share x-axis
   * units (nm) so misaligned grids align visually anyway.
   */
  seedData?: SnpData | null;
  /**
   * Old / baseline (seed) design-intent center wavelength in nm. Rendered as
   * a GRAY dashed vertical reference line (no text annotation). Pair with
   * `currentCenterNm` to show λ-shift between baseline and current run.
   */
  targetCenterNm?: number | null;
  /**
   * New / current design-intent center wavelength in nm. Rendered as a BLACK
   * dashed vertical reference line (no text annotation). When both this and
   * `targetCenterNm` are set the user sees two parallel vertical lines —
   * black = current, gray = baseline — making the drift visually obvious.
   */
  currentCenterNm?: number | null;
}

// Plot-area inset, used to convert mouse pixel-x → chart wavelength for wheel
// zoom. These match the LineChart `margin` and YAxis `width` below.
const PLOT_INSET_LEFT = 72;   // margin.left (8) + YAxis.width (64)
const PLOT_INSET_RIGHT = 24;  // margin.right

export default function SnpChart({ data, selected, mode, colorOverrides, seedData, targetCenterNm, currentCenterNm }: Props) {
  const activeTraces = data.traces.filter(t => selected.has(t.param.label));
  const activeSeedTraces = seedData
    ? seedData.traces.filter(t => selected.has(t.param.label))
    : [];

  const colorOf = (label: string, fallbackIdx: number): string =>
    colorOverrides?.[label] ?? SNP_COLORS[fallbackIdx % SNP_COLORS.length];

  // Floating legend position. `null` = use default (centered just below the
  // chart plot area). Once the user drags the legend, we store explicit
  // (x, y) in container-relative pixels and the legend stays where dropped.
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null);
  const [legendPos, setLegendPos] = useState<{ x: number; y: number } | null>(null);

  // X-axis zoom domain. `null` = auto-fit to all data. When user wheel-zooms
  // or drag-pans, this becomes an explicit [lo, hi] in nm. Y-axis auto-fits
  // to whatever's currently visible in the x window.
  const [xDomain, setXDomain] = useState<[number, number] | null>(null);
  const panRef = useRef<{ startX: number; startDom: [number, number] } | null>(null);

  const onLegendMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const cont = containerRef.current;
    if (!cont) return;
    const rect = cont.getBoundingClientRect();
    // First-time drag: seed `legendPos` from the legend's current rendered
    // position so the very first nudge doesn't snap to the cursor.
    const legendEl = e.currentTarget as HTMLElement;
    const lr = legendEl.getBoundingClientRect();
    const startX = (legendPos?.x ?? (lr.left - rect.left + lr.width / 2));
    const startY = (legendPos?.y ?? (lr.top  - rect.top  + lr.height / 2));
    dragRef.current = { ox: startX, oy: startY, sx: e.clientX, sy: e.clientY };

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current; const c = containerRef.current;
      if (!d || !c) return;
      const r = c.getBoundingClientRect();
      const x = Math.max(20, Math.min(r.width  - 20, d.ox + (ev.clientX - d.sx)));
      const y = Math.max(10, Math.min(r.height - 10, d.oy + (ev.clientY - d.sy)));
      setLegendPos({ x, y });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (activeTraces.length === 0 && activeSeedTraces.length === 0) {
    return (
      <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 40, fontSize: 12 }}>
        Select at least one port pair
      </div>
    );
  }

  // Merge by wavelength to share an x-axis. Each trace contributes its own
  // (wl, value) pairs — recharts handles missing keys via connectNulls.
  type Row = Record<string, number>;
  const rowByWl = new Map<number, Row>();
  const pushPoint = (wl: number, key: string, val: number) => {
    const r = Math.round(wl * 10) / 10;  // 0.1 nm grid
    let row = rowByWl.get(r);
    if (!row) { row = { wl: r }; rowByWl.set(r, row); }
    row[key] = Math.round((val ?? -200) * 1000) / 1000;
  };
  for (const t of activeTraces) {
    for (let i = 0; i < t.wavelengths_nm.length; i++) {
      pushPoint(t.wavelengths_nm[i], t.param.label, t[mode][i]);
    }
  }
  for (const t of activeSeedTraces) {
    for (let i = 0; i < t.wavelengths_nm.length; i++) {
      pushPoint(t.wavelengths_nm[i], `${t.param.label} (seed)`, t[mode][i]);
    }
  }
  const chartData = Array.from(rowByWl.values()).sort((a, b) => a.wl - b.wl);

  const yLabel = PLOT_MODE_LABELS[mode];

  // Full data x range (used as zoom-out limits + pan clamp).
  const dataXMin = chartData.length ? chartData[0].wl : 0;
  const dataXMax = chartData.length ? chartData[chartData.length - 1].wl : 1;
  // Effective x domain: explicit zoom OR full range.
  const xDom: [number, number] = xDomain ?? [dataXMin, dataXMax];

  // Y auto-fit to visible-in-xDom data only — when user zooms in horizontally,
  // the y-axis re-tightens to highlight the local detail (the whole point of
  // zoom). Includes a 5 % padding so traces don't kiss the top/bottom edge.
  let yDomain: [number | string, number | string] = ["auto", "auto"];
  if (xDomain) {
    const yVals: number[] = [];
    for (const row of chartData) {
      if (row.wl < xDom[0] || row.wl > xDom[1]) continue;
      for (const k of Object.keys(row)) {
        if (k === "wl") continue;
        const v = row[k];
        if (typeof v === "number" && Number.isFinite(v) && v > -200) yVals.push(v);
      }
    }
    if (yVals.length) {
      const lo = Math.min(...yVals);
      const hi = Math.max(...yVals);
      const pad = (hi - lo) * 0.05 || Math.max(1, Math.abs(hi) * 0.05);
      yDomain = [lo - pad, hi + pad];
    }
  }

  const onChartWheel = (e: React.WheelEvent) => {
    if (!chartData.length) return;
    e.preventDefault();
    const cont = containerRef.current;
    if (!cont) return;
    const rect = cont.getBoundingClientRect();
    const plotW = rect.width - PLOT_INSET_LEFT - PLOT_INSET_RIGHT;
    if (plotW <= 0) return;
    const cursorPx = e.clientX - rect.left - PLOT_INSET_LEFT;
    const cursorFrac = Math.max(0, Math.min(1, cursorPx / plotW));
    const cursorWl = xDom[0] + cursorFrac * (xDom[1] - xDom[0]);
    // wheel up (deltaY < 0) → zoom in (shrink window); down → zoom out.
    const factor = e.deltaY < 0 ? 1 / 1.2 : 1.2;
    const newWidth = (xDom[1] - xDom[0]) * factor;
    const fullWidth = dataXMax - dataXMin;
    if (newWidth >= fullWidth) {
      setXDomain(null);
      return;
    }
    let newLo = cursorWl - newWidth * cursorFrac;
    let newHi = cursorWl + newWidth * (1 - cursorFrac);
    if (newLo < dataXMin) { newHi += dataXMin - newLo; newLo = dataXMin; }
    if (newHi > dataXMax) { newLo -= newHi - dataXMax; newHi = dataXMax; }
    setXDomain([newLo, newHi]);
  };

  const onChartMouseDown = (e: React.MouseEvent) => {
    if (!xDomain) return;  // pan only when zoomed in
    const cont = containerRef.current;
    if (!cont) return;
    panRef.current = { startX: e.clientX, startDom: [xDomain[0], xDomain[1]] };
    const onMove = (ev: MouseEvent) => {
      const p = panRef.current; const c = containerRef.current;
      if (!p || !c) return;
      const rect = c.getBoundingClientRect();
      const plotW = rect.width - PLOT_INSET_LEFT - PLOT_INSET_RIGHT;
      if (plotW <= 0) return;
      const dxPx = ev.clientX - p.startX;
      const wlPerPx = (p.startDom[1] - p.startDom[0]) / plotW;
      const shift = -dxPx * wlPerPx;  // dragging right → window moves left → see lower wl
      let lo = p.startDom[0] + shift;
      let hi = p.startDom[1] + shift;
      if (lo < dataXMin) { hi += dataXMin - lo; lo = dataXMin; }
      if (hi > dataXMax) { lo -= hi - dataXMax; hi = dataXMax; }
      setXDomain([lo, hi]);
    };
    const onUp = () => {
      panRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Build legend items for the floating overlay. Built-in <Legend> is no
  // longer rendered inside the chart — see the absolutely-positioned div
  // below the ResponsiveContainer.
  type LegendItem = { key: string; label: string; color: string; isSeed: boolean };
  const legendItems: LegendItem[] = [];
  for (const t of activeSeedTraces) {
    const matchInLatest = data.traces.findIndex(x => x.param.label === t.param.label);
    const colorIdx = matchInLatest >= 0 ? matchInLatest : (seedData!.traces.indexOf(t));
    legendItems.push({
      key: `seed-${t.param.label}`,
      label: t.param.label,
      color: colorOf(t.param.label, colorIdx),
      isSeed: true,
    });
  }
  for (const t of activeTraces) {
    legendItems.push({
      key: `cur-${t.param.label}`,
      label: t.param.label,
      color: colorOf(t.param.label, data.traces.indexOf(t)),
      isSeed: false,
    });
  }

  return (
    <div
      ref={containerRef}
      onWheel={onChartWheel}
      onMouseDown={onChartMouseDown}
      style={{
        width: "100%", height: "100%", background: "#ffffff",
        position: "relative",
        cursor: xDomain ? "grab" : "default",
      }}
    >
    <ResponsiveContainer width="100%" height="100%">
      {/*
        margin.bottom: previously 20 (X-axis label sat at offset:-12 with a
        Recharts <Legend> below, which crowded the "Wavelength (nm)" label).
        Now Legend is a separate floating div, so the chart's bottom margin
        only needs to host the X-axis ticks + label. 38 keeps the label
        clearly above any default legend overlay position.
      */}
      <LineChart data={chartData} margin={{ top: 6, right: PLOT_INSET_RIGHT, left: 8, bottom: 38 }} style={{ background: "#ffffff" }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e8eef8" />
        <XAxis
          dataKey="wl" type="number"
          domain={xDomain ?? ["auto", "auto"]}
          allowDataOverflow
          tick={{ fill: "#6b80a8", fontSize: 14 }}
          label={{ value: "Wavelength (nm)", position: "insideBottom", offset: -16, fill: "#6b80a8", fontSize: 15 }}
        />
        <YAxis
          domain={yDomain}
          allowDataOverflow
          tick={{ fill: "#6b80a8", fontSize: 14 }}
          label={{ value: yLabel, angle: -90, position: "insideLeft", offset: 8, fill: "#6b80a8", fontSize: 15 }}
          width={64}
        />
        <Tooltip
          contentStyle={{ background: "#ffffff", border: "1px solid #d8e2f0", borderRadius: 8, fontSize: 15, boxShadow: "0 4px 12px rgba(37,99,235,0.1)" }}
          labelStyle={{ color: "#6b80a8" }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          labelFormatter={(v: any) => `${v} nm`}
        />
        {/* Center λ markers: gray = baseline/seed, black = current. No text
            annotations — the line color alone reads as the legend (matching
            the seed=gray/dashed vs latest=solid trace convention). */}
        {typeof targetCenterNm === "number" && Number.isFinite(targetCenterNm) && (
          <ReferenceLine
            x={Math.round(targetCenterNm * 10) / 10}
            stroke="#9ca3af"
            strokeDasharray="5 4"
            strokeWidth={1.4}
            ifOverflow="extendDomain"
          />
        )}
        {typeof currentCenterNm === "number" && Number.isFinite(currentCenterNm) && (
          <ReferenceLine
            x={Math.round(currentCenterNm * 10) / 10}
            stroke="#000"
            strokeDasharray="5 4"
            strokeWidth={1.6}
            ifOverflow="extendDomain"
          />
        )}
        {activeSeedTraces.map((t) => {
          // Seed lines: pick color from the LATEST trace list when the same
          // label exists, so seed and latest share a color even if seedData has
          // a different trace order. Fallback to seed-list index.
          const matchInLatest = data.traces.findIndex(x => x.param.label === t.param.label);
          const colorIdx = matchInLatest >= 0
            ? matchInLatest
            : (seedData!.traces.indexOf(t));
          return (
            <Line
              key={`seed-${t.param.label}`}
              type="monotone"
              dataKey={`${t.param.label} (seed)`}
              stroke={colorOf(t.param.label, colorIdx)}
              strokeOpacity={0.55}
              strokeDasharray="6 4"
              dot={false}
              strokeWidth={1.4}
              isAnimationActive={false}
              connectNulls
              legendType="plainline"
            />
          );
        })}
        {activeTraces.map((t) => (
          <Line
            key={t.param.label}
            type="monotone"
            dataKey={t.param.label}
            stroke={colorOf(t.param.label, data.traces.indexOf(t))}
            dot={false}
            strokeWidth={1.8}
            isAnimationActive={false}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>

    {/* Zoom helper UI: shows current x-range while zoomed + a reset button.
        Hidden at default view to keep the chart clean. Wheel anywhere on the
        chart to zoom (cursor-centered); drag while zoomed to pan. */}
    {xDomain && (
      <div
        onMouseDown={(e) => e.stopPropagation()}  // don't trigger pan
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          background: "rgba(255,255,255,0.92)",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          padding: "3px 8px",
          fontSize: 12,
          color: "#374151",
          display: "inline-flex",
          gap: 8,
          alignItems: "center",
          boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
          zIndex: 5,
        }}
      >
        <span style={{ fontFamily: "monospace" }}>
          {xDomain[0].toFixed(1)}–{xDomain[1].toFixed(1)} nm
        </span>
        <button
          type="button"
          onClick={() => setXDomain(null)}
          title="Reset zoom"
          style={{
            border: "none", background: "transparent", cursor: "pointer",
            color: "#2563eb", padding: "0 2px", fontSize: 13,
          }}
        >↺ reset</button>
      </div>
    )}

    {/* Floating, draggable legend.
        Default position: centered, just below the X-axis label area
        (bottom: 4 px from container edge). Once the user drags, position
        switches to explicit (x, y) and persists in component state. */}
    <div
      onMouseDown={onLegendMouseDown}
      title="Drag to reposition"
      style={{
        position: "absolute",
        ...(legendPos
          ? { left: legendPos.x, top: legendPos.y, transform: "translate(-50%, -50%)", bottom: "auto" }
          : { left: "50%", bottom: 2, transform: "translateX(-50%)" }),
        cursor: "move",
        userSelect: "none",
        background: "rgba(255,255,255,0.94)",
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        padding: "5px 12px",
        display: "flex",
        gap: 18,
        flexWrap: "wrap",
        maxWidth: "92%",
        lineHeight: 1.5,
        zIndex: 5,
      }}
    >
      {/* tiny grip dots on the left to telegraph "draggable" */}
      <span aria-hidden style={{
        color: "#cbd5e1", fontSize: 12, marginRight: 2,
        alignSelf: "center", letterSpacing: -1,
      }}>⋮⋮</span>
      {legendItems.map((it) => (
        <span
          key={it.key}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontWeight: it.isSeed ? 400 : 600,
            fontSize: it.isSeed ? 12 : 14,
            whiteSpace: "nowrap",
          }}
        >
          <svg width={26} height={8} style={{ flex: "0 0 auto" }}>
            <line
              x1={0} x2={26} y1={4} y2={4}
              stroke={it.color}
              strokeWidth={it.isSeed ? 1.6 : 2}
              strokeOpacity={it.isSeed ? 0.55 : 1}
              strokeDasharray={it.isSeed ? "5 3" : undefined}
            />
          </svg>
          {/* Label coloring: "S31"/"S41" always matches its curve color (so a
              user can tell at a glance which line is which port pair, even on
              seed traces). The "· seed" suffix is rendered in plain black so
              it reads as an annotation rather than part of the trace name. */}
          <span style={{ color: it.color, fontStyle: it.isSeed ? "italic" : "normal" }}>
            {it.label}
          </span>
          {it.isSeed && (
            <span style={{ marginLeft: 4, color: "#000", fontStyle: "normal", fontWeight: 400 }}>
              · seed
            </span>
          )}
        </span>
      ))}
      {legendPos && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setLegendPos(null); }}
          onMouseDown={(e) => e.stopPropagation()}
          title="Reset legend position"
          style={{
            border: "none", background: "transparent", cursor: "pointer",
            color: "#94a3b8", fontSize: 12, padding: "0 2px",
            alignSelf: "center", lineHeight: 1,
          }}
        >↺</button>
      )}
    </div>
    </div>

  );
}
