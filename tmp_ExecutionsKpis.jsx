import { useEffect, useMemo, useState } from "react";
import { getExecutionsSummary } from "../../services/analyticsService";
import { Icon } from "../ui/lpIcons";

export default function ExecutionsKpis({ days = 180, techId }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [summary, setSummary] = useState(null);

  const load = async () => {
    try {
      setErr("");
      setLoading(true);
      const json = await getExecutionsSummary({
        days,
        techId: techId || undefined,
      });
      setSummary(json || null);
    } catch (error) {
      console.error(error);
      setErr(error?.message || "Error cargando KPIs de actividades");
      setSummary(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, techId]);

  const cards = useMemo(() => {
    const safe = summary || {};
    const pct = (n) => `${Number(n || 0).toFixed(0)}%`;

    return [
      {
        key: "scheduled",
        label: "Programadas",
        value: safe.totalScheduled ?? 0,
        hint: "Ventana de analisis",
        tone: "steel",
        icon: "calendar",
      },
      {
        key: "completedMonth",
        label: "Completadas",
        value: safe.completed ?? 0,
        hint: "Cierre del periodo",
        tone: "blue",
        icon: "check",
      },
      {
        key: "completed30d",
        label: "Ultimos 30 dias",
        value: safe.completed30d ?? 0,
        hint: "Actividad ejecutada reciente",
        tone: "green",
        icon: "bolt",
      },
      {
        key: "pending",
        label: "Pendientes",
        value: safe.pendingDue ?? 0,
        hint: "Aun no vencen",
        tone: "steel",
        icon: "list",
      },
      {
        key: "overdue",
        label: "Vencidas",
        value: safe.overdue ?? 0,
        hint: "Requieren atencion",
        tone: "danger",
        icon: "alert",
      },
      {
        key: "completionRate",
        label: "Cumplimiento",
        value: pct(safe.completionRate),
        hint: "Completadas / programadas",
        tone: "purple",
        icon: "doc",
      },
    ];
  }, [summary]);

  return (
    <div style={{ marginTop: 10 }}>
      {err ? <div style={errorBox}>{err}</div> : null}

      <div style={grid}>
        {cards.map((card) => (
          <div key={card.key} className="lpKpiCard" style={{ ...kpiCard, ...toneCard(card.tone) }}>
            <div style={topAccent(card.tone)} />

            <div style={kpiHeader}>
              <div style={kpiLabel}>{card.label}</div>
              <span style={iconWrap(card.tone)}>
                <Icon name={card.icon} />
              </span>
            </div>

            <div style={{ ...kpiValue, ...toneValue(card.tone) }}>
              {loading ? "..." : card.value}
            </div>

            <div style={kpiSub}>{card.hint}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function toneCard(tone) {
  if (tone === "danger") {
    return {
      background: "linear-gradient(180deg, #ffffff 0%, #fff7f7 100%)",
      border: "1px solid rgba(248,113,113,0.24)",
    };
  }

  if (tone === "green") {
    return {
      background: "linear-gradient(180deg, #ffffff 0%, #f7fff9 100%)",
      border: "1px solid rgba(74,222,128,0.24)",
    };
  }

  if (tone === "blue") {
    return {
      background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
      border: "1px solid rgba(96,165,250,0.24)",
    };
  }

  if (tone === "purple") {
    return {
      background: "linear-gradient(180deg, #ffffff 0%, #fbfaff 100%)",
      border: "1px solid rgba(167,139,250,0.24)",
    };
  }

  return {
    background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)",
    border: "1px solid rgba(226,232,240,0.95)",
  };
}

function topAccent(tone) {
  let bg = "#334155";
  if (tone === "danger") bg = "#dc2626";
  if (tone === "green") bg = "#16a34a";
  if (tone === "blue") bg = "#2563eb";
  if (tone === "purple") bg = "#7c3aed";

  return {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: 6,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    background: bg,
  };
}

function toneValue(tone) {
  if (tone === "danger") return { color: "#b91c1c" };
  if (tone === "green") return { color: "#15803d" };
  if (tone === "blue") return { color: "#1d4ed8" };
  if (tone === "purple") return { color: "#6d28d9" };
  return { color: "#0f172a" };
}

function iconWrap(tone) {
  let bg = "rgba(226,232,240,0.85)";
  let bd = "rgba(203,213,225,0.95)";
  let fg = "#334155";

  if (tone === "danger") {
    bg = "rgba(254,226,226,0.9)";
    bd = "rgba(248,113,113,0.28)";
    fg = "#b91c1c";
  }

  if (tone === "green") {
    bg = "rgba(220,252,231,0.95)";
    bd = "rgba(74,222,128,0.28)";
    fg = "#15803d";
  }

  if (tone === "blue") {
    bg = "rgba(219,234,254,0.95)";
    bd = "rgba(96,165,250,0.28)";
    fg = "#1d4ed8";
  }

  if (tone === "purple") {
    bg = "rgba(243,232,255,0.95)";
    bd = "rgba(167,139,250,0.28)";
    fg = "#6d28d9";
  }

  return {
    width: 34,
    height: 34,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    background: bg,
    border: `1px solid ${bd}`,
    color: fg,
    flex: "0 0 auto",
  };
}

const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
};

const kpiCard = {
  position: "relative",
  borderRadius: 16,
  padding: 14,
  boxShadow: "0 10px 24px rgba(2,6,23,0.05)",
  overflow: "hidden",
  minHeight: 118,
};

const kpiHeader = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  marginTop: 4,
};

const kpiLabel = {
  fontSize: 12,
  color: "#64748b",
  fontWeight: 950,
  textTransform: "uppercase",
  letterSpacing: 0.2,
};

const kpiValue = {
  marginTop: 12,
  fontSize: 28,
  fontWeight: 1000,
  lineHeight: 1,
};

const kpiSub = {
  marginTop: 10,
  fontSize: 12,
  color: "#475569",
  fontWeight: 850,
  lineHeight: 1.45,
};

const errorBox = {
  marginBottom: 10,
  padding: 12,
  borderRadius: 14,
  background: "rgba(254,242,242,0.95)",
  border: "1px solid rgba(248,113,113,0.25)",
  color: "#991b1b",
  fontWeight: 900,
};