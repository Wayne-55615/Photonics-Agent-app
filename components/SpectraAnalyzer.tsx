"use client";

import { useState, useEffect, useRef } from "react";
import { parseSnp, getNPortsFromFilename, getDefaultPortPairs, SnpData } from "@/utils/snpParser";
import SnpChart, { SNP_COLORS as COLORS, PlotMode } from "@/components/SnpChart";

// ── ResultsBrowser ────────────────────────────────────────────────────────────
function ResultsBrowser({ onSelect }: { onSelect: (name: string) => void }) {
  const [files, setFiles] = useState<{ name: string; size: number }[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/results").then(r => r.json()).then(d => setFiles(d.files ?? []));
  }, []);

  const filtered = files.filter(f => f.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input
        placeholder="搜尋檔案 / Search files…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        style={{
          background: "#f5f8fe", border: "1px solid var(--border)", borderRadius: 6,
          color: "var(--text)", padding: "7px 14px", fontSize: 18, outline: "none",
        }}
      />
      <div style={{ maxHeight: 280, overflowY: "auto", fontSize: 18 }}>
        {filtered.length === 0 && <div style={{ color: "var(--text-muted)", padding: 10 }}>No sNp files found</div>}
        {filtered.map(f => (
          <div key={f.name}
            style={{ padding: "4px 8px", cursor: "pointer", borderRadius: 4, display: "flex", justifyContent: "space-between" }}
            className="result-file-row"
            onClick={() => onSelect(f.name)}
          >
            <span style={{ color: "#a5c8ff", fontFamily: "monospace" }}>{f.name}</span>
            <span style={{ color: "var(--text-muted)" }}>{(f.size / 1024).toFixed(0)} KB</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── TraceSelector ────────────────────────────────────────────────────────────
function TraceSelector({
  data, selected, onChange,
}: {
  data: SnpData;
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  function toggle(label: string) {
    const next = new Set(selected);
    if (next.has(label)) next.delete(label); else next.add(label);
    onChange(next);
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <span style={{ color: "var(--text-muted)", fontSize: 15 }}>Ports:</span>
      {data.traces.map((t, ci) => {
        const pIn = data.ports[t.param.portIn - 1]?.name ?? `port${t.param.portIn}`;
        const pOut = data.ports[t.param.portOut - 1]?.name ?? `port${t.param.portOut}`;
        const active = selected.has(t.param.label);
        return (
          <button key={t.param.label}
            onClick={() => toggle(t.param.label)}
            style={{
              padding: "3px 14px", fontSize: 15, borderRadius: 999, border: "1px solid",
              borderColor: active ? COLORS[ci % COLORS.length] : "var(--border)",
              background: active ? COLORS[ci % COLORS.length] + "22" : "transparent",
              color: active ? COLORS[ci % COLORS.length] : "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {t.param.label} ({pIn}→{pOut})
          </button>
        );
      })}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function SpectraAnalyzer() {
  const [snpData, setSnpData] = useState<SnpData | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<PlotMode>("power_db");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"browse" | "upload">("browse");
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadFromResults(name: string) {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/results/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const n = getNPortsFromFilename(name);
      const data = parseSnp(text, n);
      setSnpData(data);
      setFilename(name);
      setSelected(new Set(getDefaultPortPairs(n)));
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }

  function handleFileUpload(file: File) {
    setLoading(true); setError(null);
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const text = e.target?.result as string;
        const n = getNPortsFromFilename(file.name);
        const data = parseSnp(text, n);
        setSnpData(data);
        setFilename(file.name);
        setSelected(new Set(getDefaultPortPairs(n)));
      } catch (err) { setError(String(err)); }
      finally { setLoading(false); }
    };
    reader.readAsText(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
      {/* ── Top control bar ── */}
      <div style={{
        padding: "8px 12px", borderBottom: "1px solid var(--border)",
        display: "flex", flexDirection: "column", gap: 8,
        background: "#040c1a",
      }}>
        {/* Source tabs */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 15, color: "var(--text-muted)" }}>來源 / Source:</span>
          {(["browse", "upload"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "4px 16px", fontSize: 15, borderRadius: 4, border: "1px solid",
              borderColor: tab === t ? "var(--accent)" : "var(--border)",
              background: tab === t ? "rgba(37,99,235,0.08)" : "transparent",
              color: tab === t ? "var(--accent)" : "var(--text-muted)", cursor: "pointer",
            }}>
              {t === "browse" ? "📁 Results 目錄 / Browse" : "⬆ 上傳檔案 / Upload"}
            </button>
          ))}
          {filename && (
            <span style={{ marginLeft: "auto", fontSize: 15, color: "var(--text-muted)", fontFamily: "monospace" }}>
              {filename}
              {snpData && ` · ${snpData.nPorts}P · ${snpData.format} · ${snpData.wavelengths_nm.length} pts`}
            </span>
          )}
        </div>

        {tab === "browse" && <ResultsBrowser onSelect={loadFromResults} />}

        {tab === "upload" && (
          <div
            onDrop={onDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            style={{
              border: "2px dashed #c5d4ee", borderRadius: 8, padding: "20px",
              textAlign: "center", cursor: "pointer", fontSize: 18, color: "var(--text-muted)", background: "#f5f8fe",
            }}
          >
            拖放 .s2p / .s4p 檔案，或點擊選擇 / Drop .s2p / .s4p files or click to select
            <input ref={fileRef} type="file" accept=".s2p,.s4p,.snp"
              style={{ display: "none" }}
              onChange={e => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); }} />
          </div>
        )}

        {/* Plot mode + trace selector */}
        {snpData && (
          <>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 15, color: "var(--text-muted)" }}>顯示 / Show:</span>
              {([["power_db", "Power (dB)"], ["mag_lin", "Magnitude"], ["phase_deg", "Phase (°)"]] as const).map(([m, label]) => (
                <button key={m} onClick={() => setMode(m)} style={{
                  padding: "3px 12px", fontSize: 15, borderRadius: 4, border: "1px solid",
                  borderColor: mode === m ? "var(--accent)" : "var(--border)",
                  background: mode === m ? "rgba(37,99,235,0.08)" : "transparent",
                  color: mode === m ? "var(--accent)" : "var(--text-muted)", cursor: "pointer",
                }}>
                  {label}
                </button>
              ))}
            </div>
            <TraceSelector data={snpData} selected={selected} onChange={setSelected} />
          </>
        )}

        {loading && <div style={{ fontSize: 18, color: "var(--accent)" }}><span className="spinning">⟳</span> 載入中 / Loading…</div>}
        {error && <div style={{ fontSize: 18, color: "var(--error)" }}>⚠ {error}</div>}
      </div>

      {/* ── Chart area ── */}
      <div style={{ flex: 1, minHeight: 0, padding: "8px 4px 4px" }}>
        {snpData
          ? <SnpChart data={snpData} selected={selected} mode={mode} />
          : <div style={{ color: "var(--text-muted)", textAlign: "center", paddingTop: 60, fontSize: 18 }}>
              從 Results 目錄選擇或上傳 sNp 檔案 / Pick from Results dir or upload an sNp file
            </div>
        }
      </div>
    </div>
  );
}
