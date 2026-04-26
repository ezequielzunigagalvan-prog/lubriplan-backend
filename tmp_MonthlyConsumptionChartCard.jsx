import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { getMonthlyTotal } from "../../services/analyticsService";

const toNum = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

const formatGramsSmart = (grams) => {
  const g = toNum(grams);
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  return `${Math.round(g)} g`;
};

const formatMlToLiters = (ml) => `${(toNum(ml) / 1000).toFixed(2)} L`;

const formatByKind = (value, kind) => {
  if (kind === "ACEITE") return formatMlToLiters(value);
  if (kind === "GRASA") return formatGramsSmart(value);
  return String(toNum(value));
};

const monthKey = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
};

const addMonths = (date, months) => {
  const next = new Date(date);
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  return next;
};

const monthsBetweenInclusive = (fromDate, toDate) => {
  const start = new Date(fromDate);
  const end = new Date(toDate);
  start.setDate(1);
  end.setDate(1);

  const out = [];
  let current = new Date(start);
  while (current <= end) {
    out.push(monthKey(current));
    current = addMonths(current, 1);
  }
  return out;
};

const monthLabelShort = (ym) => {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) return ym || "-";
  const [y, m] = ym.split("-").map(Number);
  const monthsEs = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${monthsEs[(m || 1) - 1]} ${String(y).slice(2)}`;
};

function CustomTooltip({ active, payload, label, kind }) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload || {};
  return (
    <div style={tooltip}>
      <div style={tooltipTitle}>{label || row.month}</div>
      <div style={tooltipSub}>Total: <b>{formatByKind(row.totalRaw, kind)}</b></div>
    </div>
  );
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

function useFormatChartAxis(kind) {
  return useMemo(() => {
    return (value) => {
      const n = toNum(value);
      if (kind === "ACEITE") return `${n.toFixed(1)} L`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)} kg`;
      return `${Math.round(n)} g`;
    };
  }, [kind]);
}

export default function MonthlyConsumptionChartCard({
  title = "Consumo mensual",
  kind,
  days = 180,
  lubricantId,
}) {
  const [series, setSeries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const { ref: chartRef, width: chartWidth } = useElementWidth();
  const safeChartWidth = Math.max(chartWidth || 0, 640);
  const chartHeight = 300;

  const gradientId = useMemo(
    () => `monthly-consumption-grad-${kind}-${String(lubricantId ?? "all")}`,
    [kind, lubricantId]
  );

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        setErr("");
        setLoading(true);
        const json = await getMonthlyTotal(days, kind, lubricantId);
        if (!mounted) return;
        setSeries(Array.isArray(json?.series) ? json.series : []);
      } catch (error) {
        if (!mounted) return;
        setErr(error?.message || "Error cargando consumo mensual");
        setSeries([]);
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [days, kind, lubricantId]);

  const normalized = useMemo(() => {
    const today = new Date();
    const from = new Date();
    from.setDate(from.getDate() - Number(days || 180));

    const wantedMonths = monthsBetweenInclusive(from, today);
    const map = new Map(
      (series || [])
        .map((row) => ({ month: String(row?.month || ""), total: toNum(row?.total) }))
        .filter((row) => /^\d{4}-\d{2}$/.test(row.month))
        .map((row) => [row.month, row.total])
    );

    return wantedMonths.map((month) => ({
      month,
      label: monthLabelShort(month),
      totalRaw: toNum(map.get(month) || 0),
      totalChart: kind === "ACEITE" ? toNum(map.get(month) || 0) / 1000 : toNum(map.get(month) || 0),
    }));
  }, [series, days, kind]);

  const stats = useMemo(() => {
    const totals = normalized.map((row) => toNum(row.totalRaw));
    const total = totals.reduce((acc, value) => acc + value, 0);
    const avg = totals.length ? total / totals.length : 0;

    let topMonth = "-";
    let topValue = -1;
    for (const row of normalized) {
      if (row.totalRaw > topValue) {
        topValue = row.totalRaw;
        topMonth = row.month;
      }
    }

    return { total, avg, topMonth, topValue };
  }, [normalized]);

  const compare = useMemo(() => {
    if (!normalized.length) return null;
    const last = normalized[normalized.length - 1];
    const prev = normalized[normalized.length - 2] || null;
    const delta = last.totalRaw - toNum(prev?.totalRaw);
    const pct = prev && toNum(prev.totalRaw) > 0 ? (delta / toNum(prev.totalRaw)) * 100 : null;
    return { last, prev, delta, pct };
  }, [normalized]);

  const avgChart = useMemo(() => {
    if (!normalized.length) return 0;
    return normalized.reduce((acc, row) => acc + toNum(row.totalChart), 0) / normalized.length;
  }, [normalized]);

  const chartColor = kind === "ACEITE" ? "#2563eb" : "#16a34a";
  const unitHint = kind === "ACEITE" ? "Unidad: litros" : "Unidad: gramos / kilos";
  const formatChartAxis = useFormatChartAxis(kind);

  if (loading) {
    return (
      <div style={card}>
        <div style={titleRow}>
          <div style={titleTxt}>{title}</div>
          <div style={unitHintSt}>{unitHint}</div>
        </div>
        <div style={stateText}>Cargando...</div>
      </div>
    );
  }

  if (err) {
    return (
      <div style={card}>
        <div style={titleRow}>
          <div style={titleTxt}>{title}</div>
          <div style={unitHintSt}>{unitHint}</div>
        </div>
        <div style={errorBox}>{err}</div>
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={titleRow}>
        <div>
          <div style={titleTxt}>{title}</div>
          <div style={subTxt}>Serie mensual y comparativo del periodo seleccionado.</div>
        </div>
        <div style={unitHintSt}>{unitHint}</div>
      </div>

      <div style={statsGrid}>
        <div style={statCard}>
          <div style={statLabel}>Total periodo</div>
          <div style={statValue}>{formatByKind(stats.total, kind)}</div>
        </div>
        <div style={statCard}>
          <div style={statLabel}>Promedio mes</div>
          <div style={statValue}>{formatByKind(stats.avg, kind)}</div>
        </div>
        <div style={statCard}>
          <div style={statLabel}>Mes pico</div>
          <div style={statValue}>{monthLabelShort(stats.topMonth)}</div>
          <div style={statSub}>{formatByKind(stats.topValue, kind)}</div>
        </div>
        <div style={statCard}>
          <div style={statLabel}>Cambio mensual</div>
          <div style={statValue}>
            {compare
              ? `${compare.delta >= 0 ? "+" : ""}${formatByKind(compare.delta, kind)}`
              : "-"}
          </div>
          <div style={statSub}>
            {compare?.pct == null ? "Sin base previa" : `${compare.pct >= 0 ? "+" : ""}${compare.pct.toFixed(1)}%`}
          </div>
        </div>
      </div>

      <div style={chartOuter} ref={chartRef}>
        <div style={chartInner}>
          <AreaChart width={safeChartWidth} height={chartHeight} data={normalized} margin={{ top: 16, right: 14, left: 0, bottom: 10 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColor} stopOpacity={0.34} />
                <stop offset="100%" stopColor={chartColor} stopOpacity={0.03} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="rgba(226,232,240,0.95)" />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#64748b", fontWeight: 800 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={formatChartAxis} tick={{ fontSize: 12, fill: "#64748b", fontWeight: 800 }} axisLine={false} tickLine={false} width={76} />
            <Tooltip content={<CustomTooltip kind={kind} />} />
            <ReferenceLine y={avgChart} stroke="rgba(15,23,42,0.45)" strokeDasharray="4 4" />
            <Area type="monotone" dataKey="totalChart" stroke={chartColor} strokeWidth={3} fill={`url(#${gradientId})`} dot={{ r: 3, fill: chartColor, strokeWidth: 0 }} activeDot={{ r: 5 }} />
          </AreaChart>
        </div>
      </div>
    </div>
  );
}

const card = {
  borderRadius: 18,
  border: "1px solid rgba(226,232,240,0.95)",
  background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)",
  boxShadow: "0 16px 34px rgba(2,6,23,0.07)",
  padding: 16,
};

const titleRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 10,
  flexWrap: "wrap",
};

const titleTxt = {
  fontSize: 22,
  fontWeight: 1000,
  color: "#0f172a",
  lineHeight: 1.05,
};

const subTxt = {
  marginTop: 6,
  color: "#64748b",
  fontSize: 13,
  fontWeight: 850,
  lineHeight: 1.5,
};

const unitHintSt = {
  display: "inline-flex",
  alignItems: "center",
  padding: "8px 12px",
  borderRadius: 999,
  background: "rgba(241,245,249,0.95)",
  border: "1px solid rgba(226,232,240,0.95)",
  color: "#334155",
  fontSize: 12,
  fontWeight: 900,
};

const statsGrid = {
  marginTop: 14,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
  gap: 10,
};

const statCard = {
  borderRadius: 14,
  border: "1px solid rgba(226,232,240,0.95)",
  background: "rgba(255,255,255,0.96)",
  padding: 12,
};

const statLabel = {
  fontSize: 12,
  fontWeight: 900,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.2,
};

const statValue = {
  marginTop: 8,
  fontSize: 20,
  fontWeight: 1000,
  color: "#0f172a",
  lineHeight: 1.1,
};

const statSub = {
  marginTop: 6,
  fontSize: 12,
  color: "#475569",
  fontWeight: 850,
};

const chartOuter = {
  marginTop: 14,
  width: "100%",
  overflowX: "auto",
};

const chartInner = {
  minWidth: 0,
};

const tooltip = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: "10px 12px",
  boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
};

const tooltipTitle = {
  fontWeight: 900,
  color: "#0f172a",
};

const tooltipSub = {
  marginTop: 4,
  fontSize: 12,
  color: "#475569",
  fontWeight: 800,
};

const stateText = {
  marginTop: 12,
  color: "#64748b",
  fontWeight: 850,
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