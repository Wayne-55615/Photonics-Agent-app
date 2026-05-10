// Touchstone / sNp parser — supports RI, MA, DB formats; s2p, s4p, etc.

export interface SnpPort {
  index: number;   // 1-based
  name: string;    // e.g. "in1", "out2"
}

export interface SParam {
  portIn: number;  // 1-based
  portOut: number; // 1-based
  label: string;   // e.g. "S31"
}

export interface SnpTrace {
  param: SParam;
  wavelengths_nm: number[];
  power_db: number[];
  phase_deg: number[];
  mag_lin: number[];
}

export interface SnpData {
  nPorts: number;
  ports: SnpPort[];
  format: "RI" | "MA" | "DB";
  freqUnit: string;
  refImpedance: number;
  traces: SnpTrace[];            // all N² traces
  wavelengths_nm: number[];      // shared x-axis (sorted ascending)
}

// ─── helpers ────────────────────────────────────────────────────────────────

const C_M_S = 2.99792458e8;  // speed of light

function freqToNm(f: number, unit: string): number {
  const mul: Record<string, number> = {
    hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9, thz: 1e12,
  };
  const hz = f * (mul[unit.toLowerCase()] ?? 1e9);
  return (C_M_S / hz) * 1e9;
}

function riToComplex(r: number, i: number): [number, number] {
  return [r, i];
}
function maToComplex(mag: number, angleDeg: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [mag * Math.cos(a), mag * Math.sin(a)];
}
function dbToComplex(db: number, angleDeg: number): [number, number] {
  const mag = Math.pow(10, db / 20);
  const a = (angleDeg * Math.PI) / 180;
  return [mag * Math.cos(a), mag * Math.sin(a)];
}

function toPowerDb(re: number, im: number): number {
  const mag2 = re * re + im * im;
  if (mag2 <= 0) return -200;
  return 10 * Math.log10(mag2);
}

function toPhaseDeg(re: number, im: number): number {
  return (Math.atan2(im, re) * 180) / Math.PI;
}

// ─── port name extraction ────────────────────────────────────────────────────

function extractPorts(comments: string[], nPorts: number): SnpPort[] {
  const ports: SnpPort[] = Array.from({ length: nPorts }, (_, i) => ({
    index: i + 1,
    name: `port${i + 1}`,
  }));

  // IPKISS: "! Luceda port in1: mode 0:0"
  for (const line of comments) {
    const m = line.match(/Luceda port (\w+):\s*mode\s*\d+:(\d+)/);
    if (m) {
      const idx = parseInt(m[2], 10) + 1;
      if (idx >= 1 && idx <= nPorts) ports[idx - 1].name = m[1];
    }
  }

  // CST: '! Touchstone port 1 = CST MWS port 1 ("in1")'
  for (const line of comments) {
    const m = line.match(/Touchstone port\s+(\d+)\s*=.*\("(\w+)"\)/i);
    if (m) {
      const idx = parseInt(m[1], 10);
      if (idx >= 1 && idx <= nPorts) ports[idx - 1].name = m[2];
    }
  }

  return ports;
}

// ─── main parser ─────────────────────────────────────────────────────────────

export function parseSnp(text: string, nPorts: number): SnpData {
  const lines = text.split(/\r?\n/);
  const comments: string[] = [];
  let freqUnit = "GHz";
  let format: "RI" | "MA" | "DB" = "RI";
  let refImpedance = 50;
  const dataTokens: number[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("!")) { comments.push(line.slice(1).trim()); continue; }
    if (line.startsWith("#")) {
      const parts = line.slice(1).trim().split(/\s+/);
      freqUnit = parts[0] ?? "GHz";
      format = ((parts[2] ?? "RI").toUpperCase()) as "RI" | "MA" | "DB";
      refImpedance = parseFloat(parts[4] ?? "50") || 50;
      continue;
    }
    // data
    for (const tok of line.split(/\s+/)) {
      const n = parseFloat(tok);
      if (!isNaN(n)) dataTokens.push(n);
    }
  }

  const valuesPerFreq = 1 + 2 * nPorts * nPorts;
  const nFreqs = Math.floor(dataTokens.length / valuesPerFreq);

  const wavelengths_nm: number[] = [];
  // accumulate per-port-pair: [ [portIn][portOut] ] → complex[] per freq
  const real: number[][][] = Array.from({ length: nPorts }, () =>
    Array.from({ length: nPorts }, () => [])
  );
  const imag: number[][][] = Array.from({ length: nPorts }, () =>
    Array.from({ length: nPorts }, () => [])
  );

  for (let fi = 0; fi < nFreqs; fi++) {
    const base = fi * valuesPerFreq;
    const wl = freqToNm(dataTokens[base], freqUnit);
    wavelengths_nm.push(wl);

    for (let row = 0; row < nPorts; row++) {
      for (let col = 0; col < nPorts; col++) {
        const offset = base + 1 + (row * nPorts + col) * 2;
        const a = dataTokens[offset];
        const b = dataTokens[offset + 1];
        let re: number, im: number;
        if (format === "RI") [re, im] = riToComplex(a, b);
        else if (format === "MA") [re, im] = maToComplex(a, b);
        else [re, im] = dbToComplex(a, b);
        real[row][col].push(re);
        imag[row][col].push(im);
      }
    }
  }

  // sort ascending by wavelength (freq is descending → wl ascending)
  const order = wavelengths_nm.map((_, i) => i).sort((a, b) => wavelengths_nm[a] - wavelengths_nm[b]);
  const wl_sorted = order.map(i => wavelengths_nm[i]);

  const ports = extractPorts(comments, nPorts);

  const traces: SnpTrace[] = [];
  for (let row = 0; row < nPorts; row++) {
    for (let col = 0; col < nPorts; col++) {
      const power_db = order.map(i => toPowerDb(real[row][col][i], imag[row][col][i]));
      const phase_deg = order.map(i => toPhaseDeg(real[row][col][i], imag[row][col][i]));
      const mag_lin = order.map(i => Math.sqrt(real[row][col][i] ** 2 + imag[row][col][i] ** 2));
      traces.push({
        param: { portIn: col + 1, portOut: row + 1, label: `S${row + 1}${col + 1}` },
        wavelengths_nm: wl_sorted,
        power_db,
        phase_deg,
        mag_lin,
      });
    }
  }

  return { nPorts, ports, format, freqUnit, refImpedance, traces, wavelengths_nm: wl_sorted };
}

export function getNPortsFromFilename(filename: string): number {
  const m = filename.match(/\.s(\d+)p$/i);
  return m ? parseInt(m[1], 10) : 2;
}

export function getDefaultPortPairs(nPorts: number): string[] {
  // For 2-port: S21. For 4-port: S31, S41 (out1→in1, out2→in1)
  if (nPorts === 2) return ["S21"];
  if (nPorts === 4) return ["S31", "S41"];
  return [`S${nPorts}1`];
}
