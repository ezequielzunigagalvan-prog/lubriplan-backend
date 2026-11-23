// src/routes/analysis.routes.js
// Módulo de Análisis: indicadores calculados con definiciones explícitas y verificables.
//
// Reemplaza los cálculos de la pantalla de Análisis, que mostraban datos no verídicos:
//  - "A tiempo" era igual a "completadas" y "tarde" siempre 0.
//  - El cumplimiento dividía completadas del mes entre programadas de 180 días.
//  - Las vencidas mensuales siempre salían en 0 (se buscaba un estado que casi nunca se guarda).
//  - En técnicos, "malas" y "críticas" se mostraban como "tarde" y "vencidas".
//  - El OLE ignoraba el filtro de días y su tendencia usaba otra fórmula.
//  - Fechas en hora UTC del servidor, no en la hora de la planta.
//
// Definiciones (todas en la zona horaria de la planta):
//  - Programadas exigibles: actividades con fecha programada dentro del periodo y hasta hoy,
//    sin contar las de hoy que aún no se hacen (todavía están en tiempo).
//  - Cumplimiento = completadas / programadas exigibles.
//  - Puntualidad = completadas a más tardar el día programado / programadas exigibles.
//  - Vencidas = programadas exigibles sin completar.
//  - Condición normal = completadas con condición Buena o Regular / completadas con condición registrada.
//  - Consumo = salidas de inventario (lo realmente descontado), convertido a L o kg.

import { Router } from "express";
import { logger } from "../config/logger.js";
import { DEFAULT_TZ, safeTimeZone, zonedStartOfDay, zonedEndOfDay, zonedYmd } from "../utils/tzRange.js";
import { normalizeUnit, convertUnits } from "../utils/units.js";

const DAY = 86400000;
const r1 = (n) => Math.round(Number(n || 0) * 10) / 10;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const pct = (a, b) => (b > 0 ? r1((a / b) * 100) : null);
const up = (v) => String(v || "").trim().toUpperCase();
const ymdDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const addDaysYmd = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const NORMAL = new Set(["BUENO", "REGULAR"]);
const ABNORMAL = new Set(["MALO", "CRITICO"]);
const HIGH_CRIT = new Set(["ALTA", "CRITICA"]);
const critKey = (c) => up(c).normalize("NFD").replace(/[̀-ͯ]/g, "");

/* ───────── Periodo ───────── */

/** Periodo en días de la planta. from/to YYYY-MM-DD o days=N (por defecto 90, terminando hoy). */
export function resolvePeriod(query, tz, now = new Date()) {
  const today = zonedYmd(now, tz);
  const re = /^\d{4}-\d{2}-\d{2}$/;
  let fromYmd = re.test(String(query.from || "")) ? String(query.from) : null;
  let toYmd = re.test(String(query.to || "")) ? String(query.to) : null;

  // Mes calendario (reporte mensual): se compara contra el mes calendario anterior.
  const ym = /^(\d{4})-(\d{2})$/.exec(String(query.month || ""));
  if (ym) {
    const y = +ym[1];
    const m = +ym[2];
    if (m < 1 || m > 12) return { error: "Mes inválido" };
    const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
    fromYmd = `${ym[1]}-${ym[2]}-01`;
    toYmd = lastDay(y, m);
    const prevFrom = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const prevTo = lastDay(y, m - 1);
    return {
      tz,
      today,
      month: `${ym[1]}-${ym[2]}`,
      fromYmd,
      toYmd,
      days: ymdDiff(fromYmd, toYmd) + 1,
      from: zonedStartOfDay(fromYmd, tz),
      to: zonedEndOfDay(toYmd, tz),
      prev: { fromYmd: prevFrom, toYmd: prevTo, from: zonedStartOfDay(prevFrom, tz), to: zonedEndOfDay(prevTo, tz) },
    };
  }

  if (!fromYmd || !toYmd) {
    const days = Math.min(Math.max(Number.parseInt(query.days, 10) || 90, 1), 1095);
    toYmd = today;
    fromYmd = addDaysYmd(today, -(days - 1));
  }
  if (fromYmd > toYmd) return { error: "La fecha 'desde' es posterior a 'hasta'" };
  const days = ymdDiff(fromYmd, toYmd) + 1;
  if (days > 1095) return { error: "El periodo máximo es de 3 años" };
  const prevTo = addDaysYmd(fromYmd, -1);
  const prevFrom = addDaysYmd(prevTo, -(days - 1));
  return {
    tz,
    today,
    fromYmd,
    toYmd,
    days,
    from: zonedStartOfDay(fromYmd, tz),
    to: zonedEndOfDay(toYmd, tz),
    prev: { fromYmd: prevFrom, toYmd: prevTo, from: zonedStartOfDay(prevFrom, tz), to: zonedEndOfDay(prevTo, tz) },
  };
}

/* ───────── Cálculos puros (probados) ───────── */

/**
 * Clasifica actividades programadas en un periodo.
 * rows: { status, scheduledAt, executedAt, technicianId, condition }
 */
export function complianceStats(rows, { tz, today, fromYmd, toYmd }) {
  const s = { scheduled: 0, dueToday: 0, upcoming: 0, due: 0, completed: 0, onTime: 0, late: 0, overdue: 0, lateDaysSum: 0 };
  for (const x of rows) {
    const sd = zonedYmd(x.scheduledAt, tz);
    if (!sd || sd < fromYmd || sd > toYmd) continue;
    s.scheduled += 1;
    const done = up(x.status) === "COMPLETED" && x.executedAt;
    if (sd > today) {
      s.upcoming += 1;
      if (!done) continue;
    }
    if (sd === today && !done) {
      s.dueToday += 1;
      continue;
    }
    if (sd > today) continue; // adelantadas a futuro: no son exigibles todavía
    s.due += 1;
    if (done) {
      s.completed += 1;
      const delay = ymdDiff(sd, zonedYmd(x.executedAt, tz));
      if (delay <= 0) s.onTime += 1;
      else {
        s.late += 1;
        s.lateDaysSum += delay;
      }
    } else {
      s.overdue += 1;
    }
  }
  return {
    scheduled: s.scheduled,
    due: s.due,
    completed: s.completed,
    onTime: s.onTime,
    late: s.late,
    overdue: s.overdue,
    dueToday: s.dueToday,
    upcoming: s.upcoming,
    complianceRate: pct(s.completed, s.due),
    onTimeRate: pct(s.onTime, s.due),
    avgLateDays: s.late ? r1(s.lateDaysSum / s.late) : null,
  };
}

/** Distribución de condición de las actividades ejecutadas. */
export function conditionStats(rows) {
  const c = { BUENO: 0, REGULAR: 0, MALO: 0, CRITICO: 0, SIN_DATO: 0 };
  for (const x of rows) {
    const k = up(x.condition);
    if (k in c) c[k] += 1;
    else c.SIN_DATO += 1;
  }
  const withData = c.BUENO + c.REGULAR + c.MALO + c.CRITICO;
  return { ...c, total: rows.length, withData, normalRate: pct(c.BUENO + c.REGULAR, withData), abnormal: c.MALO + c.CRITICO };
}

/** Tipo de lubricante: por el campo tipo/nombre y, si no, por la unidad. */
export function lubricantKind(lub) {
  const txt = `${lub?.type || ""} ${lub?.name || ""}`.toLowerCase();
  if (txt.includes("grasa")) return "GRASA";
  if (txt.includes("aceite")) return "ACEITE";
  const u = normalizeUnit(lub?.unit);
  if (u === "l" || u === "L" || u === "ml") return "ACEITE";
  if (u === "kg" || u === "g") return "GRASA";
  return "OTRO";
}

/** Cantidad en L (aceite) o kg (grasa); si no se puede convertir, en su propia unidad. */
export function toDisplayQty(qty, unit, kind) {
  const target = kind === "ACEITE" ? "L" : kind === "GRASA" ? "kg" : null;
  if (target) {
    const v = convertUnits(qty, unit, target);
    if (v != null) return { qty: v, unit: target };
  }
  return { qty: Number(qty) || 0, unit: unit || "" };
}

/** OLE = Cumplimiento × Puntualidad × Condición normal (en %). */
export function oleIndex(compliance, onTime, normal) {
  if (compliance == null || onTime == null || normal == null) return null;
  return r1((compliance / 100) * (onTime / 100) * (normal / 100) * 100);
}

/* ───────── Router ───────── */

/* ───────── Resumen ejecutivo (texto generado solo con los datos verificados) ───────── */

const fmtN = (n, d = 1) => Number(n || 0).toLocaleString("es-MX", { maximumFractionDigits: d });
const fmtMoneyMx = (n) => Number(n || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
/** ", +3 pts vs. mes anterior" (vacío si no hay con qué comparar). */
const ptsDelta = (cur, prev, label) => {
  if (cur == null || prev == null) return "";
  const d = r1(cur - prev);
  if (Math.abs(d) < 0.05) return `, igual que el ${label}`;
  return `, ${d > 0 ? "+" : "−"}${fmtN(Math.abs(d))} pts vs. ${label}`;
};
const plural = (n, one, many) => `${fmtN(n, 0)} ${n === 1 ? one : many}`;

export function narrative(d) {
  const prevLabel = d.period?.month ? "mes anterior" : "periodo anterior";
  const c = d.compliance;
  const cond = d.condition;
  const cons = d.consumption;
  const rep = d.reports;
  const paragraphs = [];
  const highlights = [];
  const actions = [];

  if (!c.due && !d.executed.total) {
    return {
      headline: "Sin actividades exigibles ni ejecutadas en el periodo.",
      paragraphs: ["No hay registros de actividades programadas o ejecutadas en este periodo para la planta."],
      highlights,
      actions: ["Verifica que las rutas tengan fechas programadas y técnico asignado."],
    };
  }

  const headline = c.due
    ? `Cumplimiento ${fmtN(c.complianceRate)}% · Puntualidad ${fmtN(c.onTimeRate)}% · ${plural(c.overdue, "vencida", "vencidas")}`
    : `${plural(d.executed.total, "actividad ejecutada", "actividades ejecutadas")} sin actividades programadas exigibles`;

  if (c.due) {
    paragraphs.push(
      `Se completaron ${fmtN(c.completed, 0)} de ${fmtN(c.due, 0)} actividades exigibles: cumplimiento de ${fmtN(c.complianceRate)}%${ptsDelta(c.complianceRate, c.prev.complianceRate, prevLabel)}. ` +
        `${plural(c.onTime, "se hizo a tiempo", "se hicieron a tiempo")} (puntualidad de ${fmtN(c.onTimeRate)}%${ptsDelta(c.onTimeRate, c.prev.onTimeRate, prevLabel)})` +
        (c.late ? ` y ${plural(c.late, "con retraso", "con retraso")}, en promedio ${fmtN(c.avgLateDays)} días después de lo programado.` : ".")
    );
  }
  if (c.overdue) {
    paragraphs.push(
      `${c.overdue === 1 ? "Queda" : "Quedan"} ${plural(c.overdue, "actividad vencida", "actividades vencidas")} del ${d.period?.month ? "mes" : "periodo"}` +
        (c.criticalOverdue ? `, ${fmtN(c.criticalOverdue, 0)} en equipos de criticidad alta o crítica.` : ".")
    );
  }
  if (cond.total) {
    const top = (d.failures || []).filter((f) => f.total).slice(0, 2).map((f) => f.name);
    paragraphs.push(
      `En ${plural(cond.total, "actividad ejecutada", "actividades ejecutadas")} la condición fue normal en ${fmtN(cond.normalRate)}%` +
        (cond.abnormal
          ? `; se encontraron ${plural(cond.abnormal, "hallazgo", "hallazgos")} (${fmtN(cond.MALO, 0)} mala${cond.MALO === 1 ? "" : "s"}, ${fmtN(cond.CRITICO, 0)} crítica${cond.CRITICO === 1 ? "" : "s"})${top.length ? `, principalmente en ${top.join(" y ")}` : ""}.`
          : ", sin hallazgos de condición mala o crítica.")
    );
  }
  if (cons.oilL || cons.greaseKg) {
    paragraphs.push(
      `Consumo descontado de inventario: ${[cons.oilL ? `${fmtN(cons.oilL)} L de aceite` : null, cons.greaseKg ? `${fmtN(cons.greaseKg, 2)} kg de grasa` : null].filter(Boolean).join(" y ")}` +
        (cons.cost ? `, con un costo de ${fmtMoneyMx(cons.cost)}${cons.prev.cost ? (Math.abs(cons.cost - cons.prev.cost) < 0.5 ? `, igual que el ${prevLabel}` : ` (${cons.cost > cons.prev.cost ? "+" : "−"}${fmtN(Math.abs(((cons.cost - cons.prev.cost) / cons.prev.cost) * 100))}% vs. ${prevLabel})`) : ""}.` : ".")
    );
  }
  if (rep.total || rep.openNow) {
    paragraphs.push(
      `Reportes de condición: ${fmtN(rep.total, 0)} levantados en el periodo, ${fmtN(rep.byStatus.RESOLVED, 0)} resueltos; ${rep.openNow === 1 ? "1 sigue abierto" : `${fmtN(rep.openNow, 0)} siguen abiertos`} a hoy` +
        (rep.openAvgAgeDays ? ` con ${fmtN(rep.openAvgAgeDays)} días promedio de antigüedad.` : ".")
    );
  }

  // Puntos clave
  const bestTech = (d.technicians || []).filter((t) => t.technicianId && t.due >= 3).sort((a, b) => (b.onTimeRate ?? 0) - (a.onTimeRate ?? 0))[0];
  if (bestTech) highlights.push(`Mejor puntualidad: ${bestTech.name} (${fmtN(bestTech.onTimeRate)}% de ${fmtN(bestTech.due, 0)} actividades).`);
  const worstTech = (d.technicians || []).filter((t) => t.technicianId && t.overdue).sort((a, b) => b.overdue - a.overdue)[0];
  if (worstTech) highlights.push(`Más vencidas: ${worstTech.name} (${fmtN(worstTech.overdue, 0)}).`);
  const topLub = (cons.byLubricant || [])[0];
  if (topLub?.cost) highlights.push(`Mayor costo de lubricante: ${topLub.name} (${fmtMoneyMx(topLub.cost)}).`);

  // Acciones sugeridas (reglas simples y explícitas)
  if (c.criticalOverdue) actions.push(`Atender primero ${c.criticalOverdue === 1 ? "la actividad vencida" : `las ${fmtN(c.criticalOverdue, 0)} actividades vencidas`} en equipos críticos.`);
  if (c.overdue) actions.push(`Completar o reprogramar ${c.overdue === 1 ? "la actividad vencida" : `las ${fmtN(c.overdue, 0)} actividades vencidas`}.`);
  if (c.onTimeRate != null && c.onTimeRate < 80 && c.late) actions.push("Revisar la carga de trabajo y las fechas de las rutas: la mayoría se ejecuta después de lo programado.");
  if (d.quality?.overdueWithoutTechnician) actions.push(`Asignar técnico a ${plural(d.quality.overdueWithoutTechnician, "actividad vencida", "actividades vencidas")} sin responsable.`);
  if (cond.CRITICO) actions.push("Dar seguimiento correctivo a los equipos con condición crítica.");
  if (d.quality?.completedWithoutInventoryDeduction) actions.push(`Revisar ${plural(d.quality.completedWithoutInventoryDeduction, "actividad", "actividades")} que no descontaron inventario.`);
  if (rep.openNow) actions.push(`Cerrar o programar corrección de ${plural(rep.openNow, "reporte de condición abierto", "reportes de condición abiertos")}.`);

  return { headline, paragraphs, highlights, actions: actions.slice(0, 5) };
}

async function plantInfo(prisma, plantId) {
  const plant = await prisma.plant.findFirst({ where: { id: plantId }, select: { id: true, name: true, timezone: true } });
  return { name: plant?.name || "", tz: safeTimeZone(plant?.timezone || DEFAULT_TZ) };
}

const EXEC_SELECT = {
  id: true,
  status: true,
  scheduledAt: true,
  executedAt: true,
  condition: true,
  technicianId: true,
  routeId: true,
  manualTitle: true,
  equipmentId: true,
  route: { select: { equipmentId: true, lubricantId: true } },
};

export class PeriodError extends Error {}

/**
 * Calcula todos los indicadores del periodo. Lo usan la pantalla de Análisis, el Reporte mensual,
 * el correo mensual y el resumen con IA, para que todos digan lo mismo.
 */
export async function computeOverview(prisma, plantId, query, { withOverdueList = false } = {}) {
      const plant = await plantInfo(prisma, plantId);
      const P = resolvePeriod(query, plant.tz);
      if (P.error) throw new PeriodError(P.error);

      // Ventana de 12 meses para la tendencia mensual (termina en el mes de 'to').
      const toMonth = P.toYmd.slice(0, 7);
      const [ty, tm] = toMonth.split("-").map(Number);
      const trendStartYmd = new Date(Date.UTC(ty, tm - 12, 1)).toISOString().slice(0, 10);
      const trendFrom = zonedStartOfDay(trendStartYmd, P.tz);
      const loadFrom = trendFrom < P.prev.from ? trendFrom : P.prev.from;

      const [scheduledRows, executedRows, technicians, equipment, movements, reports, openReports] = await Promise.all([
        // Programadas (para cumplimiento): periodo, periodo anterior y 12 meses
        prisma.execution.findMany({
          where: { plantId, scheduledAt: { gte: loadFrom, lte: P.to } },
          select: EXEC_SELECT,
        }),
        // Ejecutadas en el periodo y el anterior (trabajo realizado, condición, fallas)
        prisma.execution.findMany({
          where: { plantId, status: "COMPLETED", executedAt: { gte: P.prev.from, lte: P.to } },
          select: { ...EXEC_SELECT, lubricantMovements: { where: { type: "OUT" }, select: { id: true } } },
        }),
        prisma.technician.findMany({ where: { plantId }, select: { id: true, name: true, code: true, deletedAt: true } }),
        prisma.equipment.findMany({
          where: { plantId },
          select: { id: true, name: true, code: true, criticality: true, area: { select: { name: true } } },
        }),
        prisma.lubricantMovement.findMany({
          where: {
            type: "OUT",
            createdAt: { gte: trendFrom < P.prev.from ? trendFrom : P.prev.from, lte: P.to },
            OR: [{ lubricant: { plantId } }, { execution: { is: { plantId } } }],
          },
          select: {
            quantity: true,
            createdAt: true,
            executionId: true,
            lubricant: { select: { id: true, name: true, code: true, unit: true, type: true, unitCost: true } },
            execution: { select: { equipmentId: true, route: { select: { equipmentId: true } } } },
          },
        }),
        prisma.conditionReport.findMany({
          where: { plantId, createdAt: { gte: P.from, lte: P.to } },
          select: {
            id: true,
            status: true,
            category: true,
            condition: true,
            detectedAt: true,
            createdAt: true,
            resolvedAt: true,
            equipmentId: true,
            correctiveExecution: { select: { executedAt: true } },
          },
        }),
        prisma.conditionReport.findMany({
          where: { plantId, status: { in: ["OPEN", "IN_PROGRESS"] } },
          select: { detectedAt: true, createdAt: true },
        }),
      ]);

      const eqById = new Map(equipment.map((e) => [e.id, e]));
      const techById = new Map(technicians.map((t) => [t.id, t]));
      const eqOf = (x) => x.route?.equipmentId ?? x.equipmentId ?? null;
      const inRange = (d, a, b) => d && new Date(d) >= a && new Date(d) <= b;

      /* Cumplimiento */
      const cur = complianceStats(scheduledRows, P);
      const prev = complianceStats(scheduledRows, { tz: P.tz, today: P.today, fromYmd: P.prev.fromYmd, toYmd: P.prev.toYmd });

      /* Trabajo ejecutado y condición */
      const execCur = executedRows.filter((x) => inRange(x.executedAt, P.from, P.to));
      const execPrev = executedRows.filter((x) => inRange(x.executedAt, P.prev.from, P.prev.to));
      const condCur = conditionStats(execCur);
      const condPrev = conditionStats(execPrev);
      const kindCount = { ROUTE: 0, MANUAL: 0, EMERGENCY: 0 };
      for (const x of execCur) {
        if (x.routeId) kindCount.ROUTE += 1;
        else if (/^EMERGENTE\b/i.test(String(x.manualTitle || ""))) kindCount.EMERGENCY += 1;
        else kindCount.MANUAL += 1;
      }

      /* Tendencia mensual (12 meses) */
      const months = [];
      for (let i = 0; i < 12; i += 1) {
        const d = new Date(Date.UTC(ty, tm - 12 + i, 1));
        const key = d.toISOString().slice(0, 7);
        const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
        const st = complianceStats(scheduledRows, { tz: P.tz, today: P.today, fromYmd: `${key}-01`, toYmd: last });
        months.push({ month: key, due: st.due, completed: st.completed, onTime: st.onTime, late: st.late, overdue: st.overdue, complianceRate: st.complianceRate, onTimeRate: st.onTimeRate });
      }

      /* Técnicos */
      const techRows = new Map();
      const techRow = (id) => {
        const key = id ?? 0;
        if (!techRows.has(key)) {
          const t = id ? techById.get(id) : null;
          techRows.set(key, {
            technicianId: id ?? null,
            name: id ? t?.name || `Técnico ${id}` : "Sin técnico asignado",
            code: t?.code || null,
            inactive: Boolean(t?.deletedAt),
            due: 0, completed: 0, onTime: 0, late: 0, overdue: 0, executed: 0, findings: 0, lastExecutedAt: null,
          });
        }
        return techRows.get(key);
      };
      const dueRows = new Map();
      for (const x of scheduledRows) {
        const k = x.technicianId ?? 0;
        if (!dueRows.has(k)) dueRows.set(k, []);
        dueRows.get(k).push(x);
      }
      for (const [k, rows] of dueRows) {
        const st = complianceStats(rows, P);
        if (!st.due) continue;
        const row = techRow(k || null);
        Object.assign(row, { due: st.due, completed: st.completed, onTime: st.onTime, late: st.late, overdue: st.overdue });
      }
      for (const x of execCur) {
        const row = techRow(x.technicianId ?? null);
        row.executed += 1;
        if (ABNORMAL.has(up(x.condition))) row.findings += 1;
        if (!row.lastExecutedAt || new Date(x.executedAt) > new Date(row.lastExecutedAt)) row.lastExecutedAt = x.executedAt;
      }
      const techniciansOut = [...techRows.values()]
        .map((r) => ({ ...r, complianceRate: pct(r.completed, r.due), onTimeRate: pct(r.onTime, r.due) }))
        .sort((a, b) => (a.technicianId == null) - (b.technicianId == null) || b.due - a.due || b.executed - a.executed);

      /* Fallas por equipo (condición mala/crítica en actividades ejecutadas) */
      const failMap = new Map();
      const failRow = (id) => {
        if (!failMap.has(id)) {
          const e = eqById.get(id);
          failMap.set(id, { equipmentId: id, name: e?.name || `Equipo ${id}`, code: e?.code || null, area: e?.area?.name || null, criticality: e?.criticality || null, malo: 0, critico: 0, total: 0, prevTotal: 0, reports: 0, lastAt: null });
        }
        return failMap.get(id);
      };
      for (const x of execCur) {
        const c = up(x.condition);
        if (!ABNORMAL.has(c)) continue;
        const id = eqOf(x);
        if (!id) continue;
        const row = failRow(id);
        row.total += 1;
        if (c === "CRITICO") row.critico += 1;
        else row.malo += 1;
        if (!row.lastAt || new Date(x.executedAt) > new Date(row.lastAt)) row.lastAt = x.executedAt;
      }
      for (const x of execPrev) {
        if (!ABNORMAL.has(up(x.condition))) continue;
        const id = eqOf(x);
        if (id && failMap.has(id)) failMap.get(id).prevTotal += 1;
      }
      for (const r of reports) if (r.equipmentId) failRow(r.equipmentId).reports += 1;
      const failures = [...failMap.values()]
        .filter((r) => r.total || r.reports)
        .sort((a, b) => b.critico - a.critico || b.total - a.total || b.reports - a.reports)
        .slice(0, 15);

      /* Consumo (salidas de inventario) */
      const cons = { byLubricant: new Map(), byEquipment: new Map(), byMonth: new Map(), totals: { ACEITE: 0, GRASA: 0 }, prevTotals: { ACEITE: 0, GRASA: 0 }, cost: 0, prevCost: 0, missingCost: new Set(), other: [] };
      for (const m of movements) {
        const lub = m.lubricant;
        if (!lub) continue;
        const kind = lubricantKind(lub);
        const { qty, unit } = toDisplayQty(m.quantity, lub.unit, kind);
        const cost = lub.unitCost != null ? Number(m.quantity) * Number(lub.unitCost) : null;
        const isCur = inRange(m.createdAt, P.from, P.to);
        const isPrev = inRange(m.createdAt, P.prev.from, P.prev.to);
        const month = zonedYmd(m.createdAt, P.tz).slice(0, 7);
        if (kind === "ACEITE" || kind === "GRASA") {
          if (!cons.byMonth.has(month)) cons.byMonth.set(month, { ACEITE: 0, GRASA: 0, cost: 0 });
          const mm = cons.byMonth.get(month);
          mm[kind] += qty;
          if (cost != null) mm.cost += cost;
        }
        if (isPrev) {
          if (kind in cons.prevTotals) cons.prevTotals[kind] += qty;
          if (cost != null) cons.prevCost += cost;
        }
        if (!isCur) continue;
        if (kind in cons.totals) cons.totals[kind] += qty;
        if (cost != null) cons.cost += cost;
        else cons.missingCost.add(lub.name);

        if (!cons.byLubricant.has(lub.id)) cons.byLubricant.set(lub.id, { lubricantId: lub.id, name: lub.name, code: lub.code || null, kind, unit, qty: 0, cost: lub.unitCost != null ? 0 : null, moves: 0 });
        const lr = cons.byLubricant.get(lub.id);
        lr.qty += qty;
        lr.moves += 1;
        if (cost != null) lr.cost += cost;

        const eqId = m.execution ? m.execution.route?.equipmentId ?? m.execution.equipmentId : null;
        const ek = eqId ?? 0;
        if (!cons.byEquipment.has(ek)) {
          const e = eqId ? eqById.get(eqId) : null;
          cons.byEquipment.set(ek, { equipmentId: eqId, name: eqId ? e?.name || `Equipo ${eqId}` : "Salidas sin actividad (manuales)", code: e?.code || null, ACEITE: 0, GRASA: 0, cost: 0 });
        }
        const er = cons.byEquipment.get(ek);
        if (kind === "ACEITE" || kind === "GRASA") er[kind] += qty;
        if (cost != null) er.cost += cost;
      }
      const monthsConsumption = months.map((m) => {
        const v = cons.byMonth.get(m.month) || { ACEITE: 0, GRASA: 0, cost: 0 };
        return { month: m.month, oilL: r2(v.ACEITE), greaseKg: r2(v.GRASA), cost: r2(v.cost) };
      });

      /* Reportes de condición */
      const repByStatus = { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0, DISMISSED: 0 };
      const repByCat = new Map();
      let respSum = 0;
      let respN = 0;
      for (const r of reports) {
        if (up(r.status) in repByStatus) repByStatus[up(r.status)] += 1;
        const cat = r.category || "OTRO";
        repByCat.set(cat, (repByCat.get(cat) || 0) + 1);
        const done = r.correctiveExecution?.executedAt || r.resolvedAt;
        const start = r.detectedAt || r.createdAt;
        if (up(r.status) === "RESOLVED" && done && start) {
          const h = (new Date(done) - new Date(start)) / 3600000;
          if (h >= 0) {
            respSum += h;
            respN += 1;
          }
        }
      }
      const now = Date.now();
      const openAges = openReports.map((r) => (now - new Date(r.detectedAt || r.createdAt)) / DAY).filter((d) => d >= 0);

      /* Calidad de datos */
      const completedNoMove = execCur.filter((x) => x.route?.lubricantId && !(x.lubricantMovements || []).length).length;
      const quality = {
        completedWithoutTechnician: execCur.filter((x) => x.technicianId == null).length,
        completedWithoutCondition: condCur.SIN_DATO,
        completedWithoutInventoryDeduction: completedNoMove,
        lubricantsWithoutCost: [...cons.missingCost],
        overdueWithoutTechnician: scheduledRows.filter((x) => {
          const sd = zonedYmd(x.scheduledAt, P.tz);
          return sd >= P.fromYmd && sd < P.today && sd <= P.toYmd && up(x.status) !== "COMPLETED" && x.technicianId == null;
        }).length,
      };

      const ole = oleIndex(cur.complianceRate, cur.onTimeRate, condCur.normalRate);
      const olePrev = oleIndex(prev.complianceRate, prev.onTimeRate, condPrev.normalRate);
      const critOverdue = scheduledRows.filter((x) => {
        const sd = zonedYmd(x.scheduledAt, P.tz);
        if (!(sd >= P.fromYmd && sd < P.today && sd <= P.toYmd) || up(x.status) === "COMPLETED") return false;
        return HIGH_CRIT.has(critKey(eqById.get(eqOf(x))?.criticality));
      }).length;

      // Pendientes al cierre (anexo del reporte): exigibles del periodo sin completar.
      let overdueList = null;
      if (withOverdueList) {
        const rows = await prisma.execution.findMany({
          where: { plantId, status: { not: "COMPLETED" }, scheduledAt: { gte: P.from, lte: P.to } },
          select: {
            id: true,
            scheduledAt: true,
            manualTitle: true,
            technician: { select: { name: true } },
            route: { select: { name: true, equipmentId: true } },
            equipmentId: true,
          },
          orderBy: { scheduledAt: "asc" },
        });
        overdueList = rows
          .map((x) => ({ ...x, sd: zonedYmd(x.scheduledAt, P.tz) }))
          .filter((x) => x.sd < P.today)
          .slice(0, 100)
          .map((x) => {
            const e = eqById.get(x.route?.equipmentId ?? x.equipmentId);
            return {
              id: x.id,
              scheduled: x.sd,
              daysLate: ymdDiff(x.sd, P.today),
              activity: x.route?.name || x.manualTitle || "Actividad",
              equipment: e?.name || null,
              equipmentCode: e?.code || null,
              criticality: e?.criticality || null,
              technician: x.technician?.name || null,
            };
          });
      }

      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        plant: { id: plantId, name: plant.name, timezone: P.tz },
        period: { month: P.month || null, from: P.fromYmd, to: P.toYmd, days: P.days, today: P.today, prevFrom: P.prev.fromYmd, prevTo: P.prev.toYmd },
        compliance: { ...cur, criticalOverdue: critOverdue, prev },
        executed: { total: execCur.length, prevTotal: execPrev.length, byKind: kindCount },
        condition: { ...condCur, prev: condPrev },
        ole: { value: ole, prev: olePrev, formula: "Cumplimiento × Puntualidad × Condición normal" },
        months,
        technicians: techniciansOut,
        failures,
        consumption: {
          oilL: r2(cons.totals.ACEITE),
          greaseKg: r2(cons.totals.GRASA),
          cost: r2(cons.cost),
          prev: { oilL: r2(cons.prevTotals.ACEITE), greaseKg: r2(cons.prevTotals.GRASA), cost: r2(cons.prevCost) },
          byLubricant: [...cons.byLubricant.values()].map((l) => ({ ...l, qty: r2(l.qty), cost: l.cost == null ? null : r2(l.cost) })).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.qty - a.qty),
          byEquipment: [...cons.byEquipment.values()].map((e) => ({ ...e, ACEITE: r2(e.ACEITE), GRASA: r2(e.GRASA), cost: r2(e.cost) })).sort((a, b) => b.cost - a.cost || b.ACEITE + b.GRASA - (a.ACEITE + a.GRASA)).slice(0, 15),
          months: monthsConsumption,
        },
        reports: {
          total: reports.length,
          byStatus: repByStatus,
          byCategory: [...repByCat.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
          avgResolutionHours: respN ? r1(respSum / respN) : null,
          openNow: openReports.length,
          openAvgAgeDays: openAges.length ? r1(openAges.reduce((s, d) => s + d, 0) / openAges.length) : null,
        },
        quality,
        overdueList,
      };
}

export default function analysisRoutes({ prisma, auth, requireRole }) {
  const router = Router();
  const managers = requireRole ? requireRole(["ADMIN", "SUPERVISOR"]) : (req, res, next) => next();

  const handle = (opts, label) => async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
      const data = await computeOverview(prisma, plantId, req.query, opts);
      if (opts.withOverdueList) data.narrative = narrative(data);
      return res.json(data);
    } catch (e) {
      if (e instanceof PeriodError) return res.status(400).json({ error: e.message });
      logger.error(label, e);
      return res.status(500).json({ error: "Error calculando el análisis" });
    }
  };

  // GET /api/analysis/overview?days=90 | from&to
  router.get("/overview", auth, managers, handle({}, "analysis/overview"));

  // GET /api/analysis/monthly-report?month=YYYY-MM  (compara contra el mes calendario anterior)
  router.get("/monthly-report", auth, managers, (req, res, next) => {
    if (!/^\d{4}-\d{2}$/.test(String(req.query.month || ""))) return res.status(400).json({ error: "Indica el mes (YYYY-MM)" });
    return next();
  }, handle({ withOverdueList: true }, "analysis/monthly-report"));

  return router;
}

/**
 * Sustituye en el resumen del dashboard los totales de actividades del mes por los verificados,
 * para que el resumen con IA y el correo mensual digan lo mismo que el Reporte mensual.
 */
export async function withVerifiedMonth(prisma, plantId, month, dashboard) {
  const ov = await computeOverview(prisma, Number(plantId), { month });
  const c = ov.compliance;
  const verified = {
    completed: c.completed,
    pending: c.dueToday + c.upcoming,
    overdue: c.overdue,
    total: c.due + c.dueToday + c.upcoming,
  };
  const patched = {
    ...(dashboard || {}),
    activities: { ...(dashboard?.activities || {}), ...verified },
    monthlyTotals: { ...(dashboard?.monthlyTotals || {}), ...verified },
    alerts: { ...(dashboard?.alerts || {}), overdueActivities: c.overdue },
  };
  return { overview: ov, dashboard: patched };
}
