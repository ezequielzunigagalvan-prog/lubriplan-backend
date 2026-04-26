import { useEffect, useMemo, useRef, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { getExecutionsMonthly } from "../../services/analyticsService";

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function ymToShortLabel(ym) {
  const s = String(ym || "");
  if (!/^\d{4}-\d{2}$/.test(s)) return s;

  const [y, m] = s.split("-").map(Number);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${months[(m || 1) - 1]} ${String(y).slice(2)}`;
}

function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let frame = 0;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const next = Math.floor(rect.width || el.offsetWidth || 0);
      setWidth(next);
    };

    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    scheduleUpdate();

    const ro = new ResizeObserver(() => {
      scheduleUpdate();
    });

    ro.observe(el);
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, []);

  return { ref, width };
}

function LegendChip({ label, color, line = false }) {
  return (
    <div style={legendChip}>
      <span
        style={
          line
            ? {
                width: 18,
                height: 0,
                borderTop: `3px solid ${color}`,
                borderRadius: 999,
                display: "inline-block",
              }
            : {
                width: 10,
                height: 10,
                borderRadius: 999,
                background: color,
                display: "inline-block",
              }
        }
      />
      <span>{label}</span>
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;

  const data = payload[0]?.payload || {};

  return (
    <div style={tooltip}>
      <div style={tooltipTitle}>{ymToShortLabel(label)}</div>
      <div style={tooltipGrid}>
        <div>Programadas: <b>{toNum(data.totalScheduled)}</b></div>
        <div>Completadas: <b>{toNum(data.completed)}</b></div>
        <div>Pendientes: <b>{toNum(data.pendingDue)}</b></div>
        <div>Vencidas: <b>{toNum(data.overdue)}</b></div>
      </div>
    </div>
  );
}

export default function ExecutionsMonthlyChart({ year, techId }) {
  const currentYear = new Date().getFullYear();
  const selectedYear = year ?? currentYear;

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [series, setSeries] = useState([]);

  const { ref: chartRef, width: chartWidth } = useElementWidth();
  const safeChartWidth = Math.max(chartWidth || 0, 780);
  const chartHeight = 360;

  const load = async () => {
    try {
      setErr("");
      setLoading(true);

      const json = await getExecutionsMonthly({
        year: selectedYear,
        techId: techId ? Number(techId) : undefined,
      });

      setSeries(Array.isArray(json?.series) ? json.series : []);
    } catch (error) {
      console.error(error);
      setErr(error?.message || "Error cargando serie mensual");
      setSeries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, techId]);

  const chartData = useMemo(
    () =>
      (Array.isArray(series) ? series : []).map((row) => ({
        month: row.month,
        label: ymToShortLabel(row.month),
        completed: toNum(row.completed),
        pendingDue: toNum(row.pendingDue),
        overdue: toNum(row.overdue),
        totalScheduled: toNum(row.totalScheduled),
      })),
    [series]
  );

  const summary = useMemo(() => {
    const totals = chartData.reduce(
      (acc, row) => {
        acc.scheduled += toNum(row.totalScheduled);
        acc.completed += toNum(row.completed);
        acc.pending += toNum(row.pendingDue);
        acc.overdue += toNum(row.overdue);
        return acc;
      },
      { scheduled: 0, completed: 0, pending: 0, overdue: 0 }
    );

    const avgScheduled = chartData.length ? totals.scheduled / chartData.length : 0;
    return { ...totals, avgScheduled };
  }, [chartData]);

  if (loading) {
    return (
      <div style={panel}>
        <div style={panelTop}>
          <div>
            <div style={panelTitle}>Actividad mensual</div>
            <div style={panelSub}>Cargando informacion del periodo...</div>
          </div>
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div style={panel}>
        <div style={panelTop}>
          <div style={panelTitle}>Actividad mensual</div>
        </div>
        <div style={errorBox}>{err}</div>
      </div>
    );
  }

  if (!chartData.length) {
    return (
      <div style={panel}>
        <div style={panelTop}>
          <div>
            <div style={panelTitle}>Actividad mensual</div>
            <div style={panelSub}>No hay datos para el periodo seleccionado.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={panel}>
      <div style={panelTop}>
        <div>
          <div style={panelTitle}>Actividad mensual ({selectedYear})</div>
          <div style={panelSub}>
            Vista consolidada de programadas, completadas, pendientes y vencidas por mes.
          </div>
        </div>

        <div style={summaryRow}>
          <span style={pill}>Programadas: {summary.scheduled}</span>
          <span style={pill}>Completadas: {summary.completed}</span>
          <span style={pill}>Promedio mes: {summary.avgScheduled.toFixed(1)}</span>
        </div>
      </div>

      <div style={legendRow}>
        <LegendChip label="Completadas" color="#16a34a" />
        <LegendChip label="Pendientes" color="#64748b" />
        <LegendChip label="Vencidas" color="#dc2626" />
        <LegendChip label="Programadas" color="#0f172a" line />
      </div>

      <div style={chartOuter} ref={chartRef}>
        <div style={chartInner}>
          <ComposedChart
            width={safeChartWidth}
            height={chartHeight}
            data={chartData}
            margin={{ top: 12, right: 18, left: 0, bottom: 10 }}
            barCategoryGap={18}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(226,232,240,0.9)" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 12, fill: "#64748b", fontWeight: 800 }}
              axisLine={{ stroke: "rgba(226,232,240,0.95)" }}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 12, fill: "#64748b", fontWeight: 800 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} />

            <Bar dataKey="completed" stackId="activity" fill="#16a34a" radius={[0, 0, 6, 6]} />
            <Bar dataKey="pendingDue" stackId="activity" fill="#94a3b8" />
            <Bar dataKey="overdue" stackId="activity" fill="#dc2626" radius={[6, 6, 0, 0]} />
            <Line
              type="monotone"
              dataKey="totalScheduled"
              stroke="#0f172a"
              strokeWidth={3}
              dot={{ r: 3, strokeWidth: 0, fill: "#0f172a" }}
              activeDot={{ r: 5 }}
            />
          </ComposedChart>
        </div>
      </div>

      <div style={footerStats}>
        <div style={footerStatCard}>
          <div style={footerLabel}>Pendientes abiertas</div>
          <div style={footerValue}>{summary.pending}</div>
        </div>
        <div style={footerStatCard}>
          <div style={footerLabel}>Vencidas acumuladas</div>
          <div style={{ ...footerValue, color: "#b91c1c" }}>{summary.overdue}</div>
        </div>
      </div>
    </div>
  );
}

const panel = {
  borderRadius: 18,
  border: "1px solid rgba(226,232,240,0.95)",
  background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)",
  boxShadow: "0 16px 34px rgba(2,6,23,0.07)",
  padding: 16,
};

const panelTop = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "flex-start",
  flexWrap: "wrap",
};

const panelTitle = {
  fontSize: 22,
  fontWeight: 1000,
  color: "#0f172a",
  lineHeight: 1.05,
};

const panelSub = {
  marginTop: 6,
  color: "#64748b",
  fontSize: 13,
  fontWeight: 850,
  lineHeight: 1.55,
};

const summaryRow = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
};

const pill = {
  display: "inline-flex",
  alignItems: "center",
  borderRadius: 999,
  padding: "8px 12px",
  background: "rgba(241,245,249,0.92)",
  color: "#334155",
  border: "1px solid rgba(226,232,240,0.95)",
  fontSize: 12,
  fontWeight: 950,
};

const legendRow = {
  marginTop: 12,
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const legendChip = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  borderRadius: 999,
  padding: "8px 12px",
  background: "rgba(248,250,252,0.95)",
  border: "1px solid rgba(226,232,240,0.95)",
  color: "#334155",
  fontSize: 12,
  fontWeight: 900,
};

const chartOuter = {
  marginTop: 14,
  width: "100%",
  overflowX: "auto",
  overflowY: "hidden",
};

const chartInner = {
  minWidth: 0,
};

const footerStats = {
  marginTop: 14,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 10,
};

const footerStatCard = {
  borderRadius: 14,
  background: "rgba(255,255,255,0.95)",
  border: "1px solid rgba(226,232,240,0.95)",
  padding: 12,
};

const footerLabel = {
  fontSize: 12,
  fontWeight: 900,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.2,
};

const footerValue = {
  marginTop: 8,
  fontSize: 24,
  fontWeight: 1000,
  color: "#0f172a",
  lineHeight: 1,
};

const tooltip = {
  background: "#fff",
  border: "1px solid rgba(226,232,240,0.95)",
  borderRadius: 14,
  padding: 12,
  boxShadow: "0 18px 34px rgba(2,6,23,0.14)",
  minWidth: 200,
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
  marginTop: 10,
  padding: 12,
  borderRadius: 14,
  background: "rgba(254,242,242,0.95)",
  border: "1px solid rgba(248,113,113,0.25)",
  color: "#991b1b",
  fontWeight: 900,
};