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

export default function analysisRoutes({ prisma, auth, requireRole }) {
  const router = Router();
  const managers = requireRole ? requireRole(["ADMIN", "SUPERVISOR"]) : (req, res, next) => next();

  async function plantInfo(plantId) {
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

  // GET /api/analysis/overview?days=90 | from&to
  router.get("/overview", auth, managers, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
      const plant = await plantInfo(plantId);
      const P = resolvePeriod(req.query, plant.tz);
      if (P.error) return res.status(400).json({ error: P.error });

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

      return res.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        plant: { id: plantId, name: plant.name, timezone: P.tz },
        period: { from: P.fromYmd, to: P.toYmd, days: P.days, today: P.today, prevFrom: P.prev.fromYmd, prevTo: P.prev.toYmd },
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
      });
    } catch (e) {
      logger.error("analysis/overview", e);
      return res.status(500).json({ error: "Error calculando el análisis" });
    }
  });

  return router;
}
