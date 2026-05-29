// src/routes/analytics.routes.js
import express from "express";
import { logger } from "../config/logger.js";

// Helpers (LOCAL time)
const up = (v) => String(v || "").trim().toUpperCase();

const toStartOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const endOfDay = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

const startOfWeekLocalMon = (d) => {
  const x = toStartOfDay(d);
  // JS: 0=Sun..6=Sat. Queremos lunes inicio.
  const day = x.getDay();
  const diff = (day === 0 ? -6 : 1 - day); // domingo -> -6
  return addDays(x, diff);
};

const weekKey = (d) => {
  const w = startOfWeekLocalMon(d);
  const y = w.getFullYear();
  const m = String(w.getMonth() + 1).padStart(2, "0");
  const dd = String(w.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`; // lunes de esa semana
};

const parseRange = (req) => {
  // Soporta:
  // - ?range=30D|60D|90D|180D|365D|MONTH
  // - o ?from=YYYY-MM-DD&to=YYYY-MM-DD
  const now = new Date();

  const fromQ = String(req.query.from || "").trim();
  const toQ = String(req.query.to || "").trim();
  if (fromQ && toQ) {
    const from = new Date(fromQ);
    const to = new Date(toQ);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      return { from: toStartOfDay(from), to: endOfDay(to) };
    }
  }

  const range = up(req.query.range || "90D");

  if (range === "MONTH") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { from, to };
  }

  const m = /^(\d+)\s*D$/.exec(range);
  const days = m ? Math.min(Math.max(Number(m[1]), 1), 3650) : 90;

  return { from: toStartOfDay(addDays(now, -days)), to: endOfDay(now) };
};

export default function analyticsRoutes({ prisma, auth }) {
  if (!prisma) throw new Error("analyticsRoutes: prisma is required");
  if (typeof auth !== "function") throw new Error("analyticsRoutes: auth middleware required");

  const router = express.Router();

  // =========================
  // GET /analytics/condition-reports
  // =========================
  router.get("/analytics/condition-reports", auth, async (req, res) => {
    try {
      const role = up(req.user?.role || "");
      const isTech = role === "TECHNICIAN";

      const { from, to } = parseRange(req);

      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      // Base where — siempre filtra por planta del usuario
      const where = {
        plantId,
        createdAt: { gte: from, lte: to },
      };
      if (isTech) where.reportedById = req.user.id;

      // Trae reportes dentro del rango con lo mínimo para analytics
      const reports = await prisma.conditionReport.findMany({
        where,
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          status: true,
          category: true,
          condition: true,
          createdAt: true,
          detectedAt: true,
          equipmentId: true,
          reportedById: true,
          correctiveExecutionId: true,
          equipment: { select: { id: true, name: true, code: true, areaId: true, area: { select: { name: true } } } },
          resolvedAt: true,
          correctiveExecution: { select: { id: true, executedAt: true } },
        },
      });

      // =========================
      // 1) Categorías (conteo)
      // =========================
      const catMap = new Map(); // category -> count
      for (const r of reports) {
        const c = r.category || "OTRO";
        catMap.set(c, (catMap.get(c) || 0) + 1);
      }
      const catLabels = [...catMap.keys()].sort((a, b) => (catMap.get(b) || 0) - (catMap.get(a) || 0));
      const catValues = catLabels.map((k) => catMap.get(k) || 0);

      // =========================
      // 2) Backlog por semana (created/resolved + status snapshot por semana)
      // - created: cuenta por createdAt
      // - resolved: usa executedAt de la correctiveExecution si existe y está dentro del rango
      // - statusWeekly: cuenta status del reporte por semana de createdAt (simple y útil)
      // =========================
      const weeks = new Set();
      const createdByWeek = new Map();   // weekKey -> count
      const resolvedByWeek = new Map();  // weekKey -> count
      const statusByWeek = new Map();    // weekKey -> {OPEN,IN_PROGRESS,RESOLVED,DISMISSED}

      const bumpStatus = (wk, st) => {
        if (!statusByWeek.has(wk)) statusByWeek.set(wk, { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0, DISMISSED: 0 });
        const obj = statusByWeek.get(wk);
        const key = up(st);
        if (obj[key] != null) obj[key] += 1;
      };

      for (const r of reports) {
        const wk = weekKey(r.createdAt);
        weeks.add(wk);

        createdByWeek.set(wk, (createdByWeek.get(wk) || 0) + 1);
        bumpStatus(wk, r.status);

        const resolvedTs = r.correctiveExecution?.executedAt || r.resolvedAt || null;
        if (resolvedTs) {
          const d = new Date(resolvedTs);
          if (!Number.isNaN(d.getTime()) && d >= from && d <= to) {
            const wk2 = weekKey(d);
            weeks.add(wk2);
            resolvedByWeek.set(wk2, (resolvedByWeek.get(wk2) || 0) + 1);
          }
        }
      }

      const weekLabels = [...weeks].sort(); // ya es YYYY-MM-DD (lunes)
      const createdSeries = weekLabels.map((w) => createdByWeek.get(w) || 0);
      const resolvedSeries = weekLabels.map((w) => resolvedByWeek.get(w) || 0);

      const openSeries = weekLabels.map((w) => (statusByWeek.get(w)?.OPEN || 0));
      const inProgressSeries = weekLabels.map((w) => (statusByWeek.get(w)?.IN_PROGRESS || 0));
      const resolvedStatusSeries = weekLabels.map((w) => (statusByWeek.get(w)?.RESOLVED || 0));
      const dismissedSeries = weekLabels.map((w) => (statusByWeek.get(w)?.DISMISSED || 0));

      // =========================
      // 3) MTTR (tiempo a resolver) por Área
      // MTTR = executedAt (correctiva) - detectedAt (reporte)
      // (solo reportes con correctiva ejecutada)
      // =========================
      const mttrArea = new Map(); // areaName -> {sumHours, n}
      for (const r of reports) {
        // Resolution time: prefer corrective execution date, fall back to resolvedAt
        const resolvedTs = r.correctiveExecution?.executedAt || r.resolvedAt || null;
        if (!resolvedTs || !r.detectedAt) continue;

        const a = new Date(r.detectedAt);
        const b = new Date(resolvedTs);
        if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) continue;

        const hours = (b.getTime() - a.getTime()) / 3600000;
        if (!Number.isFinite(hours) || hours < 0) continue;

        const areaName = r.equipment?.area?.name || "Sin área";
        if (!mttrArea.has(areaName)) mttrArea.set(areaName, { sum: 0, n: 0 });
        const obj = mttrArea.get(areaName);
        obj.sum += hours;
        obj.n += 1;
      }

      const mttrLabels = [...mttrArea.keys()].sort((a, b) => {
        const A = mttrArea.get(a); const B = mttrArea.get(b);
        const avA = A.n ? A.sum / A.n : 0;
        const avB = B.n ? B.sum / B.n : 0;
        return avB - avA;
      });

      const mttrValuesHours = mttrLabels.map((k) => {
        const obj = mttrArea.get(k);
        return obj.n ? Number((obj.sum / obj.n).toFixed(2)) : 0;
      });

      // =========================
      // 4) Top equipos con más reportes
      // =========================
      const eqMap = new Map(); // equipmentId -> count
      const eqMeta = new Map(); // equipmentId -> {name, code}
      for (const r of reports) {
        const id = r.equipmentId;
        if (!id) continue;
        eqMap.set(id, (eqMap.get(id) || 0) + 1);
        if (!eqMeta.has(id)) {
          eqMeta.set(id, {
            name: r.equipment?.name || "Equipo",
            code: r.equipment?.code || null,
          });
        }
      }

      const topEquipments = [...eqMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([equipmentId, count]) => ({
          equipmentId,
          count,
          name: eqMeta.get(equipmentId)?.name || "Equipo",
          code: eqMeta.get(equipmentId)?.code || null,
        }));

      // =========================
      // 5) Reincidencia (equipos con >=2 reportes)
      // =========================
      const recurrence = [...eqMap.entries()]
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([equipmentId, count]) => ({
          equipmentId,
          count,
          name: eqMeta.get(equipmentId)?.name || "Equipo",
          code: eqMeta.get(equipmentId)?.code || null,
        }));

      // Totales rápidos
      const totals = {
        total: reports.length,
        open: reports.filter((r) => r.status === "OPEN").length,
        inProgress: reports.filter((r) => r.status === "IN_PROGRESS").length,
        resolved: reports.filter((r) => r.status === "RESOLVED").length,
        dismissed: reports.filter((r) => r.status === "DISMISSED").length,
      };

      return res.json({
        ok: true,
        range: { from: from.toISOString(), to: to.toISOString() },
        totals,
        series: {
          byCategory: { labels: catLabels, values: catValues },
          backlogWeekly: {
            labels: weekLabels,               // lunes YYYY-MM-DD
            created: createdSeries,
            resolvedByExec: resolvedSeries,   // basado en executedAt
            statusByCreatedWeek: {
              open: openSeries,
              inProgress: inProgressSeries,
              resolved: resolvedStatusSeries,
              dismissed: dismissedSeries,
            },
          },
          mttrAvgHoursByArea: { labels: mttrLabels, values: mttrValuesHours },
          topEquipments,
          recurrence,
        },
      });
    } catch (e) {
      logger.error("analytics/condition-reports error:", e);
      return res.status(500).json({ error: "Error generando analytics" });
    }
  });

  // =========================
  // GET /analytics/executions
  // =========================
  router.get("/analytics/executions", auth, async (req, res) => {
    try {
      const role = up(req.user?.role || "");
      const isTech = role === "TECHNICIAN";
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const { from, to } = parseRange(req);

      const where = { plantId, scheduledAt: { gte: from, lte: to } };
      if (isTech) where.technicianId = req.user.id;

      const execs = await prisma.execution.findMany({
        where,
        select: {
          id: true,
          status: true,
          scheduledAt: true,
          executedAt: true,
          condition: true,
          technicianId: true,
          equipmentId: true,
          technician: { select: { id: true, name: true, code: true } },
          route: {
            select: {
              equipmentId: true,
              equipment: { select: { id: true, name: true, code: true } },
            },
          },
          equipment: { select: { id: true, name: true, code: true } },
        },
      });

      const LATE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

      const completed = execs.filter((x) => x.status === "COMPLETED");
      const pending = execs.filter((x) => x.status !== "COMPLETED");

      const isLate = (x) => {
        if (!x.scheduledAt || !x.executedAt) return true;
        return new Date(x.executedAt).getTime() > new Date(x.scheduledAt).getTime() + LATE_TOLERANCE_MS;
      };

      const onTime = completed.filter((x) => !isLate(x));
      const late = completed.filter((x) => isLate(x));

      const complianceRate = execs.length > 0 ? Number(((completed.length / execs.length) * 100).toFixed(1)) : 0;
      const onTimeRate = completed.length > 0 ? Number(((onTime.length / completed.length) * 100).toFixed(1)) : 0;

      // Technician performance
      const techMap = new Map();
      for (const x of execs) {
        const tid = x.technicianId;
        if (!tid) continue;
        if (!techMap.has(tid)) {
          techMap.set(tid, {
            technicianId: tid,
            name: x.technician?.name || "—",
            code: x.technician?.code || "",
            total: 0,
            completed: 0,
            onTime: 0,
            late: 0,
          });
        }
        const s = techMap.get(tid);
        s.total += 1;
        if (x.status === "COMPLETED") {
          s.completed += 1;
          if (isLate(x)) s.late += 1;
          else s.onTime += 1;
        }
      }
      const techPerformance = [...techMap.values()]
        .map((t) => ({
          ...t,
          complianceRate: t.total > 0 ? Number(((t.completed / t.total) * 100).toFixed(1)) : 0,
          onTimeRate: t.completed > 0 ? Number(((t.onTime / t.completed) * 100).toFixed(1)) : 0,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 20);

      // Equipment compliance
      const eqMap = new Map();
      for (const x of execs) {
        const eqId = x.equipmentId || x.route?.equipmentId;
        if (!eqId) continue;
        const meta = x.equipment || x.route?.equipment;
        if (!eqMap.has(eqId)) {
          eqMap.set(eqId, { equipmentId: eqId, name: meta?.name || "—", code: meta?.code || "", total: 0, completed: 0 });
        }
        const s = eqMap.get(eqId);
        s.total += 1;
        if (x.status === "COMPLETED") s.completed += 1;
      }
      const equipmentCompliance = [...eqMap.values()]
        .map((e) => ({
          ...e,
          complianceRate: e.total > 0 ? Number(((e.completed / e.total) * 100).toFixed(1)) : 0,
        }))
        .sort((a, b) => a.complianceRate - b.complianceRate || b.total - a.total)
        .slice(0, 20);

      // Monthly trend
      const monthMap = new Map();
      for (const x of execs) {
        const d = new Date(x.scheduledAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!monthMap.has(key)) monthMap.set(key, { total: 0, completed: 0 });
        const s = monthMap.get(key);
        s.total += 1;
        if (x.status === "COMPLETED") s.completed += 1;
      }
      const monthTrend = [...monthMap.keys()].sort().map((m) => {
        const s = monthMap.get(m);
        return { month: m, total: s.total, completed: s.completed, complianceRate: s.total > 0 ? Number(((s.completed / s.total) * 100).toFixed(1)) : 0 };
      });

      // Condition breakdown (completed only)
      const condMap = new Map();
      for (const x of completed) {
        const c = x.condition || "N/A";
        condMap.set(c, (condMap.get(c) || 0) + 1);
      }
      const condLabels = [...condMap.keys()].sort((a, b) => (condMap.get(b) || 0) - (condMap.get(a) || 0));

      return res.json({
        ok: true,
        range: { from: from.toISOString(), to: to.toISOString() },
        totals: {
          total: execs.length,
          completed: completed.length,
          pending: pending.length,
          onTime: onTime.length,
          late: late.length,
          complianceRate,
          onTimeRate,
        },
        techPerformance,
        equipmentCompliance,
        monthTrend,
        byCondition: {
          labels: condLabels,
          values: condLabels.map((k) => condMap.get(k) || 0),
        },
      });
    } catch (e) {
      logger.error("analytics/executions error:", e);
      return res.status(500).json({ error: "Error generando analytics de ejecuciones" });
    }
  });

  // =========================
  // GET /analytics/lubricants
  // =========================
  router.get("/analytics/lubricants", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const { from, to } = parseRange(req);

      const [moves, lubricants] = await Promise.all([
        prisma.lubricantMovement.findMany({
          where: {
            createdAt: { gte: from, lte: to },
            OR: [
              { lubricant: { is: { plantId } } },
              { execution: { is: { plantId } } },
            ],
          },
          select: {
            type: true,
            quantity: true,
            createdAt: true,
            lubricantId: true,
            execution: {
              select: {
                equipmentId: true,
                route: {
                  select: {
                    equipmentId: true,
                    equipment: { select: { id: true, name: true, code: true } },
                  },
                },
                equipment: { select: { id: true, name: true, code: true } },
              },
            },
          },
        }),
        prisma.lubricant.findMany({
          where: { plantId },
          select: { id: true, name: true, unit: true, stock: true, minStock: true, unitCost: true },
        }),
      ]);

      const lubMeta = new Map(lubricants.map((l) => [l.id, l]));
      const lubStats = new Map();
      const eqStats = new Map();
      const weekConsumption = new Map();

      const ensureLub = (id) => {
        if (!lubStats.has(id)) lubStats.set(id, { consumed: 0, received: 0, moveCountOut: 0, moveCountIn: 0 });
        return lubStats.get(id);
      };

      for (const mv of moves) {
        const qty = Number(mv.quantity || 0) || 0;
        if (qty <= 0) continue;
        const ls = ensureLub(mv.lubricantId);

        if (mv.type === "OUT") {
          ls.consumed += qty;
          ls.moveCountOut += 1;

          const eqId = mv.execution?.equipmentId || mv.execution?.route?.equipmentId;
          const eqMeta = mv.execution?.equipment || mv.execution?.route?.equipment;
          if (eqId) {
            if (!eqStats.has(eqId)) {
              eqStats.set(eqId, { equipmentId: eqId, name: eqMeta?.name || "—", code: eqMeta?.code || "", consumed: 0, moveCount: 0 });
            }
            const es = eqStats.get(eqId);
            es.consumed += qty;
            es.moveCount += 1;
          }

          const wk = weekKey(new Date(mv.createdAt));
          weekConsumption.set(wk, (weekConsumption.get(wk) || 0) + qty);
        } else if (mv.type === "IN") {
          ls.received += qty;
          ls.moveCountIn += 1;
        }
      }

      const daysInRange = Math.max(1, (to.getTime() - from.getTime()) / 86400000);

      const lubricantStats = [...lubStats.entries()].map(([id, s]) => {
        const meta = lubMeta.get(id);
        const stock = Number(meta?.stock || 0);
        const minStock = meta?.minStock != null ? Number(meta.minStock) : null;
        const unitCost = meta?.unitCost != null ? Number(meta.unitCost) : null;
        const avgDailyConsumption = Number((s.consumed / daysInRange).toFixed(3));
        const daysToEmpty = avgDailyConsumption > 0 ? Number((stock / avgDailyConsumption).toFixed(1)) : null;

        return {
          lubricantId: id,
          name: meta?.name || `Lubricant ${id}`,
          unit: meta?.unit || "",
          stock,
          minStock,
          underMin: minStock != null ? stock <= minStock : false,
          consumed: Number(s.consumed.toFixed(3)),
          received: Number(s.received.toFixed(3)),
          moveCountOut: s.moveCountOut,
          moveCountIn: s.moveCountIn,
          avgDailyConsumption,
          daysToEmpty,
          unitCost,
          costConsumed: unitCost != null ? Number((s.consumed * unitCost).toFixed(2)) : null,
        };
      }).sort((a, b) => b.consumed - a.consumed);

      const topEquipmentConsumers = [...eqStats.values()]
        .sort((a, b) => b.consumed - a.consumed)
        .slice(0, 20)
        .map((e) => ({ ...e, consumed: Number(e.consumed.toFixed(3)) }));

      const weekLabels = [...weekConsumption.keys()].sort();
      const totalConsumed = lubricantStats.reduce((acc, l) => acc + l.consumed, 0);
      const totalCost = lubricantStats.reduce((acc, l) => acc + (l.costConsumed || 0), 0);
      const atRiskCount = lubricantStats.filter(
        (l) => l.underMin || (l.daysToEmpty != null && l.daysToEmpty <= 14)
      ).length;

      return res.json({
        ok: true,
        range: { from: from.toISOString(), to: to.toISOString() },
        totals: {
          totalConsumed: Number(totalConsumed.toFixed(3)),
          totalCost: Number(totalCost.toFixed(2)),
          atRiskCount,
          lubricantCount: lubricantStats.length,
        },
        lubricantStats,
        topEquipmentConsumers,
        consumptionTrend: {
          labels: weekLabels,
          values: weekLabels.map((w) => Number((weekConsumption.get(w) || 0).toFixed(3))),
        },
      });
    } catch (e) {
      logger.error("analytics/lubricants error:", e);
      return res.status(500).json({ error: "Error generando analytics de lubricantes" });
    }
  });

  // =========================
  // GET /analytics/ole  — Overall Lubrication Effectiveness
  // OLE = Disponibilidad × Cumplimiento × Efectividad
  // =========================
  router.get("/analytics/ole", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const { from, to } = parseRange(req);

      const execs = await prisma.execution.findMany({
        where: { plantId, scheduledAt: { gte: from, lte: to } },
        select: {
          status: true,
          scheduledAt: true,
          executedAt: true,
          condition: true,
          equipmentId: true,
          route: { select: { equipmentId: true } },
        },
      });

      if (execs.length === 0) {
        return res.json({
          ok: true,
          range: { from: from.toISOString(), to: to.toISOString() },
          ole: null,
          availability: null,
          compliance: null,
          effectiveness: null,
          totals: { total: 0, completed: 0, onTime: 0, goodCondition: 0 },
          message: "Sin datos en el período seleccionado",
        });
      }

      const LATE_TOLERANCE_MS = 24 * 60 * 60 * 1000;
      const total = execs.length;
      const completed = execs.filter((x) => x.status === "COMPLETED");
      const onTime = completed.filter((x) => {
        if (!x.scheduledAt || !x.executedAt) return false;
        return new Date(x.executedAt).getTime() <= new Date(x.scheduledAt).getTime() + LATE_TOLERANCE_MS;
      });
      const goodCondition = completed.filter((x) => {
        const c = String(x.condition || "").toUpperCase();
        return c === "BUENO" || c === "REGULAR" || c === "";
      });

      // Disponibilidad: equipos únicos que tuvieron al menos 1 ejecución completada / equipos con al menos 1 programada
      const eqsScheduled = new Set(execs.map((x) => x.equipmentId || x.route?.equipmentId).filter(Boolean));
      const eqsCompleted = new Set(completed.map((x) => x.equipmentId || x.route?.equipmentId).filter(Boolean));
      const availability = eqsScheduled.size > 0 ? eqsCompleted.size / eqsScheduled.size : 0;

      // Cumplimiento: tareas completadas / tareas programadas
      const compliance = total > 0 ? completed.length / total : 0;

      // Efectividad: tareas completadas con condición BUENO/REGULAR / total completadas
      const effectiveness = completed.length > 0 ? goodCondition.length / completed.length : 0;

      const ole = availability * compliance * effectiveness;

      // Histórico mensual de OLE
      const monthMap = new Map();
      for (const x of execs) {
        const d = new Date(x.scheduledAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!monthMap.has(key)) monthMap.set(key, { total: 0, completed: 0, onTime: 0, good: 0 });
        const s = monthMap.get(key);
        s.total += 1;
        if (x.status === "COMPLETED") {
          s.completed += 1;
          const late = !x.scheduledAt || !x.executedAt ||
            new Date(x.executedAt).getTime() > new Date(x.scheduledAt).getTime() + LATE_TOLERANCE_MS;
          if (!late) s.onTime += 1;
          const c = String(x.condition || "").toUpperCase();
          if (c === "BUENO" || c === "REGULAR" || c === "") s.good += 1;
        }
      }

      const monthLabels = [...monthMap.keys()].sort();
      const monthOle = monthLabels.map((m) => {
        const s = monthMap.get(m);
        const av = s.total > 0 ? s.completed / s.total : 0; // simplified: compliance as proxy for availability
        const comp = s.total > 0 ? s.completed / s.total : 0;
        const eff = s.completed > 0 ? s.good / s.completed : 0;
        return {
          month: m,
          ole: Number((av * comp * eff * 100).toFixed(1)),
          compliance: Number((comp * 100).toFixed(1)),
          effectiveness: Number((eff * 100).toFixed(1)),
        };
      });

      return res.json({
        ok: true,
        range: { from: from.toISOString(), to: to.toISOString() },
        ole: Number((ole * 100).toFixed(2)),
        availability: Number((availability * 100).toFixed(2)),
        compliance: Number((compliance * 100).toFixed(2)),
        effectiveness: Number((effectiveness * 100).toFixed(2)),
        totals: {
          total,
          completed: completed.length,
          onTime: onTime.length,
          goodCondition: goodCondition.length,
          equipmentsScheduled: eqsScheduled.size,
          equipmentsCompleted: eqsCompleted.size,
        },
        benchmark: { target: 85, good: 75 },
        monthTrend: monthOle,
      });
    } catch (e) {
      logger.error("analytics/ole error:", e);
      return res.status(500).json({ error: "Error calculando OLE" });
    }
  });

  // =========================
  // POST /sync/executions  — Offline sync
  // =========================
  router.post("/sync/executions", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const items = req.body.executions;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Se requiere array 'executions'" });
      }
      if (items.length > 100) {
        return res.status(400).json({ error: "Máximo 100 ejecuciones por sync" });
      }

      const synced = [];
      const conflicts = [];
      const errors = [];

      for (const item of items) {
        const clientId = String(item.clientId || "").trim();
        if (!clientId) {
          errors.push({ item, reason: "clientId requerido" });
          continue;
        }

        try {
          // Check if already exists by clientId
          const existing = await prisma.execution.findUnique({ where: { clientId } });

          if (existing) {
            // Already synced — return current server state
            if (existing.plantId !== plantId) {
              conflicts.push({ clientId, reason: "Ejecución pertenece a otra planta" });
              continue;
            }
            synced.push({ clientId, id: existing.id, status: existing.status, alreadyExisted: true });
            continue;
          }

          // Validate required fields
          const execStatus = String(item.status || "COMPLETED").toUpperCase();
          const scheduledAt = item.scheduledAt ? new Date(item.scheduledAt) : new Date();
          const executedAt = item.executedAt ? new Date(item.executedAt) : new Date();

          // Verify the execution target (routeId or equipmentId) belongs to this plant
          if (item.routeId) {
            const route = await prisma.route.findFirst({ where: { id: Number(item.routeId), plantId } });
            if (!route) {
              conflicts.push({ clientId, reason: "Ruta no pertenece a esta planta" });
              continue;
            }
          }

          const created = await prisma.execution.create({
            data: {
              clientId,
              plantId,
              status: execStatus,
              origin: String(item.origin || "ROUTE").toUpperCase(),
              routeId: item.routeId ? Number(item.routeId) : null,
              equipmentId: item.equipmentId ? Number(item.equipmentId) : null,
              technicianId: item.technicianId ? Number(item.technicianId) : null,
              manualTitle: item.manualTitle || null,
              scheduledAt,
              executedAt: execStatus === "COMPLETED" ? executedAt : null,
              condition: item.condition || null,
              observations: item.observations || null,
              usedInputQuantity: item.usedInputQuantity != null ? Number(item.usedInputQuantity) : null,
              usedInputUnit: item.usedInputUnit || null,
              usedQuantity: item.usedQuantity != null ? Number(item.usedQuantity) : null,
            },
          });

          synced.push({ clientId, id: created.id, status: created.status, alreadyExisted: false });
        } catch (itemErr) {
          errors.push({ clientId, reason: itemErr?.message || "Error desconocido" });
        }
      }

      return res.json({
        ok: true,
        synced,
        conflicts,
        errors,
        summary: { synced: synced.length, conflicts: conflicts.length, errors: errors.length },
      });
    } catch (e) {
      logger.error("POST /sync/executions error:", e);
      return res.status(500).json({ error: "Error en sync de ejecuciones" });
    }
  });

  // =========================
  // GET /analytics/corporate  — Dashboard multi-planta
  // Solo usuarios con acceso a ≥2 plantas
  // =========================
  router.get("/analytics/corporate", auth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "No autenticado" });

      // Obtener todas las plantas del usuario
      const userPlants = await prisma.userPlant.findMany({
        where: { userId, active: true },
        include: { plant: { select: { id: true, name: true, timezone: true, active: true } } },
      });

      if (userPlants.length < 2) {
        return res.status(403).json({ error: "Se requiere acceso a múltiples plantas para esta vista" });
      }

      const { from, to } = parseRange(req);
      const plantIds = userPlants.map((up) => up.plant.id);
      const LATE_MS = 24 * 60 * 60 * 1000;

      const plantKpis = await Promise.all(
        plantIds.map(async (plantId) => {
          const plant = userPlants.find((up) => up.plant.id === plantId)?.plant;

          const [execs, openReports, atRiskLubs, oilAlerts] = await Promise.all([
            prisma.execution.findMany({
              where: { plantId, scheduledAt: { gte: from, lte: to } },
              select: { status: true, scheduledAt: true, executedAt: true, condition: true },
            }),
            prisma.conditionReport.count({
              where: { plantId, status: { in: ["OPEN", "IN_PROGRESS"] } },
            }),
            prisma.lubricant.findMany({
              where: { plantId, minStock: { not: null } },
              select: { stock: true, minStock: true },
            }).then((lubs) => lubs.filter((l) => Number(l.stock) <= Number(l.minStock)).length).catch(() => 0),
            prisma.oilSample.count({
              where: { plantId, status: { in: ["CAUTION", "CRITICAL"] } },
            }),
          ]);

          const total = execs.length;
          const completed = execs.filter((x) => x.status === "COMPLETED");
          const onTime = completed.filter((x) => {
            if (!x.scheduledAt || !x.executedAt) return false;
            return new Date(x.executedAt).getTime() <= new Date(x.scheduledAt).getTime() + LATE_MS;
          });
          const goodCond = completed.filter((x) => {
            const c = String(x.condition || "").toUpperCase();
            return c === "BUENO" || c === "REGULAR" || c === "";
          });

          const compliance = total > 0 ? completed.length / total : 0;
          const effectiveness = completed.length > 0 ? goodCond.length / completed.length : 0;
          const ole = compliance * compliance * effectiveness; // simplified (availability ≈ compliance)

          return {
            plantId,
            plantName: plant?.name || `Planta ${plantId}`,
            timezone: plant?.timezone || "America/Mexico_City",
            kpis: {
              total,
              completed: completed.length,
              pending: total - completed.length,
              onTime: onTime.length,
              compliance: Number((compliance * 100).toFixed(1)),
              effectiveness: Number((effectiveness * 100).toFixed(1)),
              ole: Number((ole * 100).toFixed(1)),
              openConditionReports: openReports,
              oilAlerts,
            },
          };
        })
      );

      // Totales consolidados
      const consolidated = {
        totalExecutions: plantKpis.reduce((a, p) => a + p.kpis.total, 0),
        totalCompleted: plantKpis.reduce((a, p) => a + p.kpis.completed, 0),
        totalPending: plantKpis.reduce((a, p) => a + p.kpis.pending, 0),
        openConditionReports: plantKpis.reduce((a, p) => a + p.kpis.openConditionReports, 0),
        oilAlerts: plantKpis.reduce((a, p) => a + p.kpis.oilAlerts, 0),
        avgCompliance: plantKpis.length > 0
          ? Number((plantKpis.reduce((a, p) => a + p.kpis.compliance, 0) / plantKpis.length).toFixed(1))
          : 0,
        avgOle: plantKpis.length > 0
          ? Number((plantKpis.reduce((a, p) => a + p.kpis.ole, 0) / plantKpis.length).toFixed(1))
          : 0,
      };

      return res.json({
        ok: true,
        range: { from: from.toISOString(), to: to.toISOString() },
        plantCount: plantIds.length,
        consolidated,
        plants: plantKpis.sort((a, b) => b.kpis.ole - a.kpis.ole),
      });
    } catch (e) {
      logger.error("analytics/corporate error:", e);
      return res.status(500).json({ error: "Error generando dashboard corporativo" });
    }
  });

  return router;
}