// src/routes/auditLog.routes.js
import express from "express";

export default function auditLogRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // GET /api/audit-log
  router.get("/audit-log", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const model = req.query.model ? String(req.query.model) : null;
      const userId = req.query.userId ? Number(req.query.userId) : null;
      const action = req.query.action ? String(req.query.action).toUpperCase() : null;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit || 25)));
      const page  = Math.max(1, Number(req.query.page || 1));
      const offset = (page - 1) * limit;

      // Accept dateFrom/dateTo (frontend) or from/to (legacy)
      const fromStr = req.query.dateFrom || req.query.from || null;
      const toStr   = req.query.dateTo   || req.query.to   || null;
      const fromRaw = fromStr ? new Date(fromStr) : null;
      const toRaw   = toStr   ? new Date(toStr)   : null;

      const where = {
        plantId,
        ...(model ? { model } : {}),
        ...(action ? { action } : {}),
        ...(Number.isFinite(userId) ? { userId } : {}),
        ...(fromRaw || toRaw
          ? {
              createdAt: {
                ...(fromRaw ? { gte: fromRaw } : {}),
                ...(toRaw   ? { lte: toRaw   } : {}),
              },
            }
          : {}),
      };

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        }),
        prisma.auditLog.count({ where }),
      ]);

      const pages = Math.max(1, Math.ceil(total / limit));
      return res.json({ ok: true, logs, total, page, pages });
    } catch (e) {
      console.error("GET /audit-log error:", e);
      return res.status(500).json({ error: "Error cargando audit log" });
    }
  });

  // GET /api/equipment/by-code/:code  — QR scan lookup
  router.get("/equipment/by-code/:code", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const code = String(req.params.code || "").trim();
      if (!code) return res.status(400).json({ error: "Código requerido" });

      const equipment = await prisma.equipment.findFirst({
        where: { plantId, code },
        include: {
          area: { select: { id: true, name: true } },
        },
      });

      if (!equipment) return res.status(404).json({ error: "Equipo no encontrado" });

      const now = new Date();
      const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
      const windowEnd = new Date(now); windowEnd.setDate(windowEnd.getDate() + 7);

      const [pendingExecs, lastExec, lastConditionReport, lastOilSample] = await Promise.all([
        prisma.execution.findMany({
          where: {
            plantId,
            OR: [{ equipmentId: equipment.id }, { route: { is: { equipmentId: equipment.id } } }],
            status: { not: "COMPLETED" },
            scheduledAt: { lte: windowEnd },
          },
          orderBy: { scheduledAt: "asc" },
          take: 10,
          select: {
            id: true, status: true, scheduledAt: true, origin: true,
            manualTitle: true,
            route: { select: { id: true, name: true, method: true, lubricantType: true } },
            technician: { select: { id: true, name: true, code: true } },
          },
        }),
        prisma.execution.findFirst({
          where: {
            plantId,
            OR: [{ equipmentId: equipment.id }, { route: { is: { equipmentId: equipment.id } } }],
            status: "COMPLETED",
          },
          orderBy: { executedAt: "desc" },
          select: { id: true, executedAt: true, condition: true, technician: { select: { name: true } } },
        }),
        prisma.conditionReport.findFirst({
          where: { plantId, equipmentId: equipment.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, condition: true, category: true, description: true, status: true, createdAt: true },
        }),
        prisma.oilSample.findFirst({
          where: { plantId, equipmentId: equipment.id },
          orderBy: { sampledAt: "desc" },
          select: { id: true, sampledAt: true, status: true, viscosity40: true, ironPpm: true },
        }),
      ]);

      return res.json({
        ok: true,
        equipment,
        pendingExecs,
        lastExec,
        lastConditionReport,
        lastOilSample,
      });
    } catch (e) {
      console.error("GET /equipment/by-code/:code error:", e);
      return res.status(500).json({ error: "Error buscando equipo por código" });
    }
  });

  return router;
}
