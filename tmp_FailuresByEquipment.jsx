import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { getFailuresByEquipment } from "../../services/analyticsService";

const toNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function fmtDateTime(value) {
  if (!value) return "Sin dato";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "Sin dato";
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mi = String(dt.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const next = Math.floor(el.getBoundingClientRect().width || 0);
      setWidth(next);
    };

    update();

    const ro = new ResizeObserver(() => {
      update();
    });

    ro.observe(el);
    window.addEventListener("resize", update);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return { ref, width };
}

function Tag({ children, tone = "gray" }) {
  const bg =
    tone === "red"
      ? "#fee2e2"
      : tone === "amber"
      ? "#fef3c7"
      : tone === "green"
      ? "#dcfce7"
      : tone === "blue"
      ? "#dbeafe"
      : tone === "steel"
      ? "#e2e8f0"
      : "#f1f5f9";

  const fg =
    tone === "red"
      ? "#991b1b"
      : tone === "amber"
      ? "#92400e"
      : tone === "green"
      ? "#166534"
      : tone === "blue"
      ? "#1d4ed8"
      : "#334155";

  return (
    <span style={{ ...tag, background: bg, color: fg }}>
      {children}
    </span>
  );
}

function PillBtn({ active, children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...pillBtn,
        background: active ? "#0f172a" : "#fff",
        color: active ? "#fff" : "#0f172a",
        borderColor: active ? "#0f172a" : "#e5e7eb",
      }}
      type="button"
    >
      {children}
    </button>
  );
}

function backendRiskToUi(risk) {
  if (risk === "DUE") return { txt: "Alto", tone: "red" };
  if (risk === "WATCH") return { txt: "Medio", tone: "amber" };
  if (risk === "OK") return { txt: "Estable", tone: "green" };
  return null;
}

function calcRiskScore(row) {
  const total = toNum(row.total);
  const crit = toNum(row.critico);
  const bad = toNum(row.malo);
  const raw = crit * 3 + bad * 1 + total * 0.5;
  if (raw >= 12) return { txt: "Alto", tone: "red" };
  if (raw >= 5) return { txt: "Medio", tone: "amber" };
  return { txt: "Estable", tone: "green" };
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload || {};

  return (
    <div style={tooltip}>
      <div style={tooltipTitle}>{label || row.name}</div>
      <div style={tooltipGrid}>
        {row.code ? (
          <div>
            Codigo: <b>{row.code}</b>
          </div>
        ) : null}
        {row.area ? (
          <div>
            Area: <b>{row.area}</b>
          </div>
        ) : null}
        <div>
          Total: <b>{toNum(row.total)}</b>
        </div>
        <div>
          Criticas: <b style={{ color: "#991b1b" }}>{toNum(row.critico)}</b>
        </div>
        <div>
          Malas: <b style={{ color: "#92400e" }}>{toNum(row.malo)}</b>
        </div>
        <div>
          Ultima falla: <b>{fmtDateTime(row.lastFailureAt)}</b>
        </div>
      </div>
    </div>
  );
}

export default function FailuresByEquipment() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [days, setDays] = useState(90);
  const [severity, setSeverity] = useState("ALL");
  const [q, setQ] = useState("");
  const [data, setData] = useState({ items: [], meta: null });

  const { ref: chartRef, width: chartWidth } = useElementWidth();
  const safeChartWidth = Math.max(chartWidth || 0, 700);
  const chartHeight = 340;

  const load = async () => {
    try {
      setErr("");
      setLoading(true);
      const json = await getFailuresByEquipment({ days, severity });
      setData({
        items: Array.isArray(json?.result)
          ? json.result
          : Array.isArray(json?.items)
          ? json.items
          : [],
        meta: json?.meta || null,
      });
    } catch (error) {
      console.error(error);
      setErr(error?.message || "Error cargando fallas por equipo");
      setData({ items: [], meta: null });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, severity]);

  const rows = useMemo(() => {
    const query = String(q || "").trim().toLowerCase();

    return (Array.isArray(data.items) ? data.items : [])
      .map((row) => {
        const normalized = {
          equipmentId: row.equipmentId,
          name: row.name || row.equipmentName || row.area || "Equipo",
          code: row.code || row.equipmentCode || "",
          area: row.area || row.location || "",
          total: toNum(row.total),
          critico: toNum(row.critico ?? row.criticalCount),
          malo: toNum(row.malo ?? row.badCount),
          lastFailureAt: row.lastFailureAt || null,
          deltaTotal: toNum(row.deltaTotal),
        };

        const uiRisk = backendRiskToUi(row.risk) || calcRiskScore(normalized);
        return { ...normalized, risk: uiRisk };
      })
      .filter((row) => {
        if (!query) return true;
        const haystack = [row.name, row.code, row.area].join(" ").toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        if (b.critico !== a.critico) return b.critico - a.critico;
        return String(a.name).localeCompare(String(b.name));
      });
  }, [data.items, q]);

  const chartData = useMemo(() => rows.slice(0, 8), [rows]);

  const summary = useMemo(() => {
    const totals = rows.reduce(
      (acc, row) => {
        acc.total += toNum(row.total);
        acc.critico += toNum(row.critico);
        acc.malo += toNum(row.malo);
        return acc;
      },
      { total: 0, critico: 0, malo: 0 }
    );

    return {
      ...totals,
      topName: rows[0]?.name || "Sin foco",
      topCode: rows[0]?.code || "",
    };
  }, [rows]);

  return (
    <div className="lpCard" style={panel}>
      <div style={accentBarOrange} />

      <div style={topRow}>
        <div>
          <div style={panelTitle}>Fallas por equipo</div>
          <div style={sub}>Vista de criticidad, reincidencia y foco operativo por activo.</div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar equipo, codigo o area"
            style={searchInput}
          />
          <button onClick={load} style={btnGhost} disabled={loading} type="button">
            {loading ? "Actualizando..." : "Actualizar"}
          </button>
        </div>
      </div>

      <div style={toolbar}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[30, 90, 180, 365].map((value) => (
            <PillBtn key={value} active={days === value} onClick={() => setDays(value)}>
              {value} dias
            </PillBtn>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[
            { key: "ALL", label: "Todas" },
            { key: "CRITICO", label: "Criticas" },
            { key: "MALO", label: "Malas" },
          ].map((opt) => (
            <PillBtn key={opt.key} active={severity === opt.key} onClick={() => setSeverity(opt.key)}>
              {opt.label}
            </PillBtn>
          ))}
        </div>
      </div>

      {err ? <div style={errorBox}>{err}</div> : null}

      {loading ? (
        <div style={loadingText}>Cargando...</div>
      ) : rows.length === 0 ? (
        <div style={loadingText}>Sin fallas para los filtros actuales.</div>
      ) : (
        <>
          <div style={summaryGrid}>
            <div className="lpCard" style={summaryCard}>
              <div style={summaryLbl}>Total reportes</div>
              <div style={summaryVal}>{summary.total}</div>
              <div style={summarySub}>Condiciones malas o criticas registradas</div>
            </div>
            <div className="lpCard" style={summaryCard}>
              <div style={summaryLbl}>Criticas</div>
              <div style={{ ...summaryVal, color: "#b91c1c" }}>{summary.critico}</div>
              <div style={summarySub}>Requieren atencion inmediata</div>
            </div>
            <div className="lpCard" style={summaryCard}>
              <div style={summaryLbl}>Equipo foco</div>
              <div style={summaryValSm}>{summary.topName}</div>
              <div style={summarySub}>{summary.topCode || "Sin codigo"}</div>
            </div>
          </div>

          <div style={chartOuter} ref={chartRef}>
            <div style={chartInner}>
              <BarChart width={safeChartWidth} height={chartHeight} data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(226,232,240,0.9)" />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#64748b", fontWeight: 800 }} axisLine={false} tickLine={false} interval={0} angle={-18} textAnchor="end" height={64} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: "#64748b", fontWeight: 800 }} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="critico" fill="#dc2626" radius={[6, 6, 0, 0]} />
                <Bar dataKey="malo" fill="#f59e0b" radius={[6, 6, 0, 0]} />
              </BarChart>
            </div>
          </div>

          <div style={listWrap}>
            {rows.map((row, idx) => (
              <div key={`${row.equipmentId || row.code || row.name}-${idx}`} className="lpCard" style={riskCard}>
                <div style={riskHead}>
                  <div style={{ display: "grid", gap: 6 }}>
                    <div style={riskTitle}>{row.name}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {row.code ? <Tag tone="steel">{row.code}</Tag> : null}
                      {row.area ? <Tag tone="blue">{row.area}</Tag> : null}
                      <Tag tone={row.risk.tone}>{row.risk.txt}</Tag>
                    </div>
                  </div>

                  <div style={riskCounter}>{row.total}</div>
                </div>

                <div style={riskMeta}>
                  <span>Criticas: <b>{row.critico}</b></span>
                  <span>Malas: <b>{row.malo}</b></span>
                  <span>Ultima falla: <b>{fmtDateTime(row.lastFailureAt)}</b></span>
                  {row.deltaTotal > 0 ? <span>Tendencia: <b style={{ color: "#b91c1c" }}>+{row.deltaTotal}</b></span> : null}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const panel = {
  position: "relative",
  border: "1px solid rgba(148,163,184,0.55)",
  borderRadius: 14,
  padding: 14,
  background: "rgba(255,255,255,0.96)",
  boxShadow: "0 10px 26px rgba(2,6,23,0.08)",
  outline: "1px solid rgba(255,255,255,0.9)",
  outlineOffset: -2,
  overflow: "hidden",
};

const accentBarOrange = {
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  height: 8,
  background: "#f97316",
};

const topRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  flexWrap: "wrap",
};

const panelTitle = {
  fontSize: 22,
  fontWeight: 1000,
  color: "#0f172a",
  lineHeight: 1.05,
};

const sub = {
  marginTop: 6,
  color: "#64748b",
  fontSize: 13,
  fontWeight: 850,
  lineHeight: 1.55,
};

const toolbar = {
  marginTop: 12,
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  flexWrap: "wrap",
  alignItems: "center",
};

const searchInput = {
  minWidth: 220,
  border: "1px solid rgba(203,213,225,0.95)",
  borderRadius: 12,
  padding: "10px 12px",
  fontWeight: 850,
  color: "#0f172a",
  background: "#fff",
};

const pillBtn = {
  borderWidth: 1,
  borderStyle: "solid",
  borderRadius: 999,
  padding: "9px 12px",
  fontSize: 12,
  fontWeight: 950,
  cursor: "pointer",
};

const tag = {
  display: "inline-flex",
  alignItems: "center",
  padding: "5px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 900,
  border: "1px solid rgba(0,0,0,0.06)",
  lineHeight: 1,
  whiteSpace: "nowrap",
};

const btnGhost = {
  border: "1px solid rgba(203,213,225,0.95)",
  borderRadius: 12,
  padding: "10px 14px",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 950,
  cursor: "pointer",
};

const summaryGrid = {
  marginTop: 14,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 10,
};

const summaryCard = {
  borderRadius: 14,
  border: "1px solid rgba(226,232,240,0.95)",
  background: "rgba(255,255,255,0.92)",
  padding: 12,
};

const summaryLbl = {
  fontSize: 12,
  fontWeight: 900,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.2,
};

const summaryVal = {
  marginTop: 8,
  fontSize: 28,
  fontWeight: 1000,
  color: "#0f172a",
  lineHeight: 1,
};

const summaryValSm = {
  marginTop: 8,
  fontSize: 18,
  fontWeight: 1000,
  color: "#0f172a",
  lineHeight: 1.2,
};

const summarySub = {
  marginTop: 8,
  fontSize: 12,
  fontWeight: 850,
  color: "#475569",
  lineHeight: 1.45,
};

const chartOuter = {
  marginTop: 14,
  width: "100%",
  overflowX: "auto",
};

const chartInner = {
  minWidth: 0,
};

const listWrap = {
  marginTop: 14,
  display: "grid",
  gap: 10,
};

const riskCard = {
  borderRadius: 16,
  border: "1px solid rgba(226,232,240,0.95)",
  background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)",
  padding: 14,
};

const riskHead = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "flex-start",
};

const riskTitle = {
  fontSize: 18,
  fontWeight: 1000,
  color: "#0f172a",
  lineHeight: 1.15,
};

const riskCounter = {
  minWidth: 52,
  height: 52,
  borderRadius: 16,
  background: "rgba(15,23,42,0.92)",
  color: "#fff",
  display: "grid",
  placeItems: "center",
  fontSize: 22,
  fontWeight: 1000,
};

const riskMeta = {
  marginTop: 12,
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  color: "#475569",
  fontSize: 12,
  fontWeight: 850,
};

const loadingText = {
  marginTop: 14,
  color: "#64748b",
  fontWeight: 900,
};

const tooltip = {
  background: "#fff",
  border: "1px solid rgba(226,232,240,0.95)",
  borderRadius: 14,
  padding: 12,
  boxShadow: "0 18px 34px rgba(2,6,23,0.14)",
  minWidth: 220,
};

const tooltipTitle = {
  fontWeight: 950,
  color: "#0f172a",
};

const tooltipGrid = {
  marginTop: 8,
  display: "grid",
  gap: 6,
  fontSize: 12,
  fontWeight: 850,
  color: "#334155",
};

const errorBox = {
  marginTop: 12,
  padding: 12,
  borderRadius: 14,
  background: "rgba(254,242,242,0.95)",
  border: "1px solid rgba(248,113,113,0.25)",
  color: "#991b1b",
  fontWeight: 900,
};