"use client";

import { useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

interface S21Trace {
  wavelength_um: number[];
  power_db: number[];
  power_lin: number[];
  group_delay_ps: number[];
}

interface Props { s21: S21Trace; }

type Domain = "frequency" | "time";

function buildFreqData(s21: S21Trace) {
  return s21.wavelength_um.map((wl, i) => ({
    wl: Math.round(wl * 1000 * 10) / 10,   // nm, 1 decimal
    S21_dB: s21.power_db[i] != null ? Math.round(s21.power_db[i] * 100) / 100 : null,
  }));
}

function buildTimeData(s21: S21Trace) {
  return s21.group_delay_ps.map((gd, i) => ({
    wl: Math.round(s21.wavelength_um[i] * 1000 * 10) / 10,
    group_delay_ps: gd != null ? Math.round(gd * 100) / 100 : null,
  }));
}

export default function SParamPlot({ s21 }: Props) {
  const [domain, setDomain] = useState<Domain>("frequency");
  const hasGD = s21.group_delay_ps?.some((v) => v !== null && v !== 0);

  const freqData = buildFreqData(s21);
  const timeData = hasGD ? buildTimeData(s21) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="sparam-tabs">
        <button
          className={domain === "frequency" ? "active" : ""}
          onClick={() => setDomain("frequency")}
        >
          頻域 / Freq-domain S21 (dB)
        </button>
        {hasGD && (
          <button
            className={domain === "time" ? "active" : ""}
            onClick={() => setDomain("time")}
          >
            時域 / Time-domain Group Delay (ps)
          </button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: "8px 4px 4px", background: "#ffffff" }}>
        {domain === "frequency" && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={freqData} margin={{ top: 4, right: 20, left: 0, bottom: 4 }} style={{ background: "#ffffff" }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e8eef8" />
              <XAxis
                dataKey="wl"
                type="number"
                domain={["auto", "auto"]}
                tick={{ fill: "#6b80a8", fontSize: 14 }}
                label={{ value: "Wavelength (μm)", position: "insideBottom", offset: -2, fill: "#6b80a8", fontSize: 14 }}
              />
              <YAxis
                tick={{ fill: "#6b80a8", fontSize: 14 }}
                label={{ value: "Transmission", angle: -90, position: "insideLeft", fill: "#6b80a8", fontSize: 14 }}
              />
              <Tooltip
                contentStyle={{ background: "#ffffff", border: "1px solid #d8e2f0", borderRadius: 8, fontSize: 14, boxShadow: "0 4px 12px rgba(37,99,235,0.1)" }}
                labelStyle={{ color: "#6b80a8" }}
                itemStyle={{ color: "#2563eb" }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={(v: any) => [`${v} dB`, "S21"]}
                labelFormatter={(v) => `${v} nm`}
              />
              <ReferenceLine y={-3} stroke="#ffb800" strokeDasharray="4 2" strokeOpacity={0.5} />
              <Line
                type="monotone"
                dataKey="S21_dB"
                stroke="#2563eb"
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}

        {domain === "time" && hasGD && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={timeData} margin={{ top: 4, right: 20, left: 0, bottom: 4 }} style={{ background: "#ffffff" }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e8eef8" />
              <XAxis
                dataKey="wl"
                type="number"
                domain={["auto", "auto"]}
                tick={{ fill: "#6b80a8", fontSize: 14 }}
                label={{ value: "Wavelength (μm)", position: "insideBottom", offset: -2, fill: "#6b80a8", fontSize: 14 }}
              />
              <YAxis
                tick={{ fill: "#6b80a8", fontSize: 14 }}
                label={{ value: "Group Delay (ps)", angle: -90, position: "insideLeft", fill: "#6b80a8", fontSize: 14 }}
              />
              <Tooltip
                contentStyle={{ background: "#ffffff", border: "1px solid #d8e2f0", borderRadius: 8, fontSize: 14, boxShadow: "0 4px 12px rgba(37,99,235,0.1)" }}
                labelStyle={{ color: "#6b80a8" }}
                itemStyle={{ color: "#7c3aed" }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={(v: any) => [`${v} ps`, "Group Delay"]}
                labelFormatter={(v) => `${v} nm`}
              />
              <Line
                type="monotone"
                dataKey="group_delay_ps"
                stroke="#7c3aed"
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
