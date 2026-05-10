"use client";

import { useEffect, useState, useRef, useCallback } from "react";

interface Props { url: string; }

interface ViewerState {
  loadedUrl: string | null;
  content:   string | null;
  error:     boolean;
}

export default function GdsViewer({ url }: Props) {
  const [state, setState] = useState<ViewerState>({ loadedUrl: null, content: null, error: false });

  const [scale,  setScale]  = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const dragging     = useRef(false);
  const lastPos      = useRef({ x: 0, y: 0 });

  // Reset transform when a new SVG loads
  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.text(); })
      .then(content => { if (!cancelled) setState({ loadedUrl: url, content, error: false }); })
      .catch(() => { if (!cancelled) setState({ loadedUrl: url, content: null, error: true }); });
    return () => { cancelled = true; };
  }, [url]);

  const zoom = useCallback((delta: number, cx?: number, cy?: number) => {
    setScale(prev => {
      const next = Math.min(20, Math.max(0.1, prev * (1 + delta)));
      if (cx !== undefined && cy !== undefined && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const ox = cx - rect.left - rect.width  / 2;
        const oy = cy - rect.top  - rect.height / 2;
        setOffset(o => ({
          x: o.x - ox * (next - prev) / prev,
          y: o.y - oy * (next - prev) / prev,
        }));
      }
      return next;
    });
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 0.12 : -0.12, e.clientX, e.clientY);
  }, [zoom]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    lastPos.current  = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setOffset(o => ({ x: o.x + dx, y: o.y + dy }));
  }, []);

  const onMouseUp = useCallback(() => { dragging.current = false; }, []);

  const reset = useCallback(() => { setScale(1); setOffset({ x: 0, y: 0 }); }, []);

  const loading = state.loadedUrl !== url && !state.error;

  if (state.error && state.loadedUrl === url) return (
    <div style={{ color: "var(--error)", fontSize: 12, textAlign: "center" }}>
      無法載入 SVG / Failed to load SVG<br />
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{url}</span>
    </div>
  );

  if (loading || !state.content) return (
    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>載入中 / Loading…</div>
  );

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>

      {/* ── Zoom controls ── */}
      <div style={toolbarStyle}>
        <button style={btnStyle} onClick={() => zoom(0.25)} title="Zoom in">＋</button>
        <button style={btnStyle} onClick={() => zoom(-0.25)} title="Zoom out">－</button>
        <button style={{ ...btnStyle, fontSize: 11, padding: "3px 8px" }} onClick={reset} title="Reset">⟳ {Math.round(scale * 100)}%</button>
      </div>

      {/* ── SVG canvas ── */}
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", cursor: dragging.current ? "grabbing" : "grab", userSelect: "none" }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: "center center",
            transition: dragging.current ? "none" : "transform 0.05s ease-out",
          }}
          dangerouslySetInnerHTML={{ __html: state.content }}
        />
      </div>
    </div>
  );
}

const toolbarStyle: React.CSSProperties = {
  position:       "absolute",
  top:            8,
  right:          8,
  zIndex:         10,
  display:        "flex",
  gap:            4,
  background:     "rgba(255,255,255,0.92)",
  border:         "1px solid rgba(37,99,235,0.18)",
  borderRadius:   8,
  padding:        "4px 6px",
  boxShadow:      "0 2px 8px rgba(37,99,235,0.1)",
  backdropFilter: "blur(4px)",
};

const btnStyle: React.CSSProperties = {
  width:        28,
  height:       28,
  border:       "1px solid rgba(37,99,235,0.2)",
  borderRadius: 5,
  background:   "rgba(255,255,255,0.9)",
  color:        "var(--accent)",
  fontSize:     16,
  fontWeight:   700,
  cursor:       "pointer",
  display:      "flex",
  alignItems:   "center",
  justifyContent: "center",
  transition:   "background 0.15s",
};
