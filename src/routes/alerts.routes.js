// src/routes/alerts.routes.js
import express from "express";

export default function alertsRoutes({ prisma, auth, requireRole, toStartOfDaySafe }) {
  const router = express.Router();

  // GET /api/alerts/technician-overload
  router.get(
    "/technician-overload",
    auth,
    requireRole(["ADMIN", "SUPERVISOR"]),
    async (req, res) => {
      try {
        const windowDays = Number(req.query.windowDays ?? 7);
        const overdueLookbackDays = Number(req.query.overdueLookbackDays ?? 30);
        const capacityPerDay = Number(req.query.capacityPerDay ?? 6);
        const warnRatio = Number(req.query.warnRatio ?? 1.1);
        const criticalRatio = Number(req.query.criticalRatio ?? 1.4);

        const now = new Date();
        const today = toStartOfDaySafe(now);

        const windowDaysSafe = Math.max(1, Number(windowDays || 7));
        const overdueLookbackDaysSafe = Math.max(1, Number(overdueLookbackDays || 30));

        const fromOverdue = new Date(today);
        fromOverdue.setDate(fromOverdue.getDate() - overdueLookbackDaysSafe);

        const toWindow = new Date(today);
        toWindow.setDate(toWindow.getDate() + windowDaysSafe);

        const pendingExecs = await prisma.execution.findMany({
          where: {
            status: { not: "COMPLETED" },
            scheduledAt: { gte: today, lt: toWindow },
            technicianId: { not: null },
          },
          select: { technicianId: true },
        });

        const overdueExecs = await prisma.execution.findMany({
          where: {
            status: { not: "COMPLETED" },
            scheduledAt: { gte: fromOverdue, lt: today },
            technicianId: { not: null },
          },
          select: { technicianId: true },
        });

        const techs = await prisma.technician.findMany({
          select: { id: true, name: true, code: true, status: true, specialty: true },
        });

        const techMap = new Map(techs.map((t) => [t.id, t]));
        const techIds = techs.map((t) => t.id);

        const byTech = new Map();

        for (const e of pendingExecs) {
          const id = e.technicianId;
          if (id == null) continue;
          if (!byTech.has(id)) byTech.set(id, { pending: 0, overdue: 0 });
          byTech.get(id).pending += 1;
        }

        for (const e of overdueExecs) {
          const id = e.technicianId;
          if (id == null) continue;
          if (!byTech.has(id)) byTech.set(id, { pending: 0, overdue: 0 });
          byTech.get(id).overdue += 1;
        }

        const capacity = Math.max(1, Number(capacityPerDay || 6)) * windowDaysSafe;

        const items = techIds.map((id) => {
          const t = techMap.get(id) || { id, name: "—", code: "", status: "—", specialty: "" };
          const s = byTech.get(id) || { pending: 0, overdue: 0 };

          const load = (s.pending || 0) + (s.overdue || 0);
          const ratio = capacity ? load / capacity : 0;

          let level = "OK";
          if (ratio >= criticalRatio) level = "CRITICAL";
          else if (ratio >= warnRatio) level = "WARN";

          return {
            technicianId: id,
            name: t.name,
            code: t.code,
            status: t.status,
            specialty: t.specialty,
            windowDays: windowDaysSafe,
            capacityPerDay,
            capacity,
            pending: s.pending || 0,
            overdue: s.overdue || 0,
            load,
            ratio: Number(ratio.toFixed(3)),
            level,
          };
        });

        items.sort((a, b) => b.ratio - a.ratio || b.overdue - a.overdue);

        return res.json({ ok: true, items });
      } catch (e) {
        console.error("alerts technician-overload error:", e);
        return res.status(500).json({ error: "Error technician-overload" });
      }
    }
  );

  return router;
}