"use client";

import { useEffect, useMemo, useState } from "react";
import SnpChart, { PlotMode, PLOT_MODE_LABELS, SNP_COLORS } from "@/components/SnpChart";
import { getDefaultPortPairs, getNPortsFromFilename, parseSnp, SnpData } from "@/utils/snpParser";

interface Props {
  filename: string;
  /**
   * Optional seed (baseline) sNp filename for replay/optimize comparison.
   * When set, the seed file is loaded alongside `filename` and its traces
   * overlay the latest in dashed/translucent style on the same axes.
   */
  seedFilename?: string | null;
  /**
   * Old / baseline design-intent center wavelength in nm — drawn as a gray
   * dashed vertical line. Used to mark the seed (pre-replay / iter-1)
   * design center for visual drift comparison against `currentCenterNm`.
   */
  targetCenterNm?: number | null;
  /**
   * New / current design-intent center wavelength in nm — drawn as a black
   * dashed vertical line.
   */
  currentCenterNm?: number | null;
  embedded?: boolean;
}

export default function SnpHtmlViewer({ filename, seedFilename, targetCenterNm, currentCenterNm, embedded = false }: Props) {
  const [snpData, setSnpData] = useState<SnpData | null>(null);
  const [seedData, setSeedData] = useState<SnpData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [colorOverrides, setColorOverrides] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<PlotMode>("power_db");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tracesOpen, setTracesOpen] = useState(false);
  const [headerCollapsed, setHeaderCollapsed] = useState(true);
  const [showSeed, setShowSeed] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadOne(name: string): Promise<SnpData> {
      const res = await fetch(`/api/results/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`Unable to read ${name} (HTTP ${res.status})`);
      const text = await res.text();
      return parseSnp(text, getNPortsFromFilename(name));
    }

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const parsed = await loadOne(filename);
        if (cancelled) return;
        setSnpData(parsed);
        setSelected(new Set(getDefaultPortPairs(parsed.nPorts)));

        if (seedFilename && seedFilename !== filename) {
          try {
            const seedParsed = await loadOne(seedFilename);
            if (!cancelled) setSeedData(seedParsed);
          } catch {
            // Seed is best-effort; failing to load it shouldn't error the page.
            if (!cancelled) setSeedData(null);
          }
        } else {
          setSeedData(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [filename, seedFilename]);

  const selectedCount = selected.size;
  const wavelengthRange = useMemo(() => {
    if (!snpData || snpData.wavelengths_nm.length === 0) return null;
    const first = snpData.wavelengths_nm[0];
    const last = snpData.wavelengths_nm[snpData.wavelengths_nm.length - 1];
    return `${first.toFixed(1)}-${last.toFixed(1)} nm`;
  }, [snpData]);

  function toggleTrace(label: string) {
    const next = new Set(selected);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    setSelected(next);
  }

  return (
    <div className={embedded ? "html-spectrum embedded" : "html-spectrum"}>
      {headerCollapsed ? (
        <div className="html-spectrum-hero-compact">
          <button
            type="button"
            className="html-spectrum-collapse-btn"
            onClick={() => setHeaderCollapsed(false)}
            title="展開說明區 / Expand info"
            aria-label="Expand header"
          >▼</button>
          <span className="html-spectrum-compact-label">sNp</span>
          <code className="html-spectrum-compact-file">{filename}</code>
          {snpData && (
            <span className="html-spectrum-compact-meta">
              {snpData.nPorts}P · {snpData.format} · {snpData.wavelengths_nm.length}pt
              {wavelengthRange ? ` · ${wavelengthRange}` : ""}
            </span>
          )}
          {seedData && (
            <span
              className="html-spectrum-compact-meta"
              style={{ color: "#a16207", fontStyle: "italic" }}
              title={seedFilename ?? undefined}
            >
              · seed {seedData.nPorts}P · {seedData.wavelengths_nm.length}pt
            </span>
          )}
        </div>
      ) : (
        <div className="html-spectrum-hero">
          <div>
            <div className="html-spectrum-eyebrow">Touchstone HTML Viewer</div>
            <h1>sNp Spectrum Window</h1>
            <p>
              Read Touchstone files directly from the simulation results folder and inspect
              wavelength-domain power, magnitude, and phase traces in a standalone HTML view.
            </p>
          </div>
          <div className="html-spectrum-filebox">
            <span className="html-spectrum-filelabel">Current File</span>
            <code>{filename}</code>
            {seedFilename && (
              <>
                <span className="html-spectrum-filelabel" style={{ marginTop: 6 }}>
                  Seed File
                </span>
                <code style={{ color: "#a16207" }}>{seedFilename}</code>
              </>
            )}
          </div>
          <button
            type="button"
            className="html-spectrum-collapse-btn"
            onClick={() => setHeaderCollapsed(true)}
            title="收折說明區 / Collapse info"
            aria-label="Collapse header"
          >▲</button>
        </div>
      )}

      {loading && <div className="html-spectrum-state">Loading sNp file…</div>}
      {error && !loading && <div className="html-spectrum-state error">{error}</div>}

      {snpData && !loading && !error && (
        <>
          {!headerCollapsed && <div className="html-spectrum-meta">
            <div className="html-spectrum-card">
              <span>Ports</span>
              <strong>{snpData.nPorts}P</strong>
            </div>
            <div className="html-spectrum-card">
              <span>Format</span>
              <strong>{snpData.format}</strong>
            </div>
            <div className="html-spectrum-card">
              <span>Points</span>
              <strong>{snpData.wavelengths_nm.length}</strong>
            </div>
            <div className="html-spectrum-card">
              <span>Range</span>
              <strong>{wavelengthRange ?? "—"}</strong>
            </div>
            <div className="html-spectrum-card">
              <span>Selected</span>
              <strong>{selectedCount}</strong>
            </div>
          </div>}

          <div className="html-spectrum-toolbar">
            <div className="html-spectrum-modegroup">
              {(Object.keys(PLOT_MODE_LABELS) as PlotMode[]).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  className={mode === entry ? "active" : ""}
                  onClick={() => setMode(entry)}
                >
                  {PLOT_MODE_LABELS[entry]}
                </button>
              ))}
            </div>

            <a
              href={`/api/results/${encodeURIComponent(filename)}`}
              target="_blank"
              rel="noreferrer"
              className="html-spectrum-link"
            >
              Open raw file
            </a>

            {seedData && (
              <button
                type="button"
                onClick={() => setShowSeed(v => !v)}
                style={{
                  marginLeft: 8, padding: "4px 10px", fontSize: 13,
                  background: showSeed ? "#fef3c7" : "transparent",
                  border: "1px solid " + (showSeed ? "#a16207" : "var(--border, #ddd)"),
                  borderRadius: 6, cursor: "pointer",
                  color: showSeed ? "#a16207" : "var(--text-muted, #666)",
                }}
                title={showSeed ? "Hide seed overlay" : "Show seed overlay"}
              >
                {showSeed ? "Seed ON" : "Seed OFF"}
              </button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, marginBottom: 4 }}>
            <button
              type="button"
              onClick={() => setTracesOpen(v => !v)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "4px 10px", fontSize: 13,
                background: "transparent", border: "1px solid var(--border, #ddd)",
                borderRadius: 6, cursor: "pointer", color: "var(--text, #333)",
              }}
              aria-expanded={tracesOpen}
              aria-label={tracesOpen ? "收折 S 參數清單 / Collapse S-param list" : "展開 S 參數清單 / Expand S-param list"}
            >
              <span style={{ display: "inline-block", transform: tracesOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>▶</span>
              S 參數 / S-params ({selectedCount}/{snpData.traces.length})
            </button>
            {!tracesOpen && selectedCount > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted, #666)" }}>
                已選 / Selected: {Array.from(selected).join(", ")}
              </div>
            )}
          </div>

          {tracesOpen && (
            <div className="html-spectrum-traces">
              {snpData.traces.map((trace, index) => {
                const active = selected.has(trace.param.label);
                const color = colorOverrides[trace.param.label]
                  ?? SNP_COLORS[index % SNP_COLORS.length];

                return (
                  <span
                    key={trace.param.label}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    <button
                      type="button"
                      className={active ? "active" : ""}
                      onClick={() => toggleTrace(trace.param.label)}
                      style={{
                        borderColor: active ? color : undefined,
                        color: active ? color : undefined,
                        background: active ? `${color}18` : undefined,
                      }}
                    >
                      <span>{trace.param.label}</span>
                    </button>
                    {active && (
                      <label
                        title="Pick line color"
                        style={{
                          display: "inline-flex", alignItems: "center",
                          width: 18, height: 18, borderRadius: 4,
                          background: color,
                          border: "1px solid rgba(0,0,0,0.18)",
                          cursor: "pointer",
                          position: "relative", overflow: "hidden",
                          flexShrink: 0,
                        }}
                      >
                        <input
                          type="color"
                          value={color}
                          onChange={(e) => setColorOverrides(prev => ({
                            ...prev, [trace.param.label]: e.target.value,
                          }))}
                          style={{
                            position: "absolute", inset: 0, opacity: 0,
                            width: "100%", height: "100%", cursor: "pointer",
                            border: "none", padding: 0,
                          }}
                        />
                      </label>
                    )}
                  </span>
                );
              })}
              {Object.keys(colorOverrides).length > 0 && (
                <button
                  type="button"
                  onClick={() => setColorOverrides({})}
                  title="Reset all line colors to default"
                  style={{
                    marginLeft: 6, padding: "2px 8px", fontSize: 11,
                    background: "transparent", border: "1px dashed var(--border, #ddd)",
                    borderRadius: 4, cursor: "pointer", color: "var(--text-muted, #666)",
                  }}
                >
                  ↺ reset colors
                </button>
              )}
            </div>
          )}

          <div className="html-spectrum-chart">
            <SnpChart
              data={snpData}
              selected={selected}
              mode={mode}
              colorOverrides={colorOverrides}
              seedData={showSeed ? seedData : null}
              targetCenterNm={targetCenterNm ?? null}
              currentCenterNm={currentCenterNm ?? null}
            />
          </div>
        </>
      )}
    </div>
  );
}
