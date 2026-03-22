// src/routes/analytics.routes.js
import express from "express";

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

      // Base where
      const where = {
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

        const execAt = r.correctiveExecution?.executedAt || null;
        if (execAt) {
          const d = new Date(execAt);
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
        const execAt = r.correctiveExecution?.executedAt || null;
        if (!execAt || !r.detectedAt) continue;

        const a = new Date(r.detectedAt);
        const b = new Date(execAt);
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
      console.error("analytics/condition-reports error:", e);
      return res.status(500).json({ error: "Error generando analytics" });
    }
  });

  return router;
}