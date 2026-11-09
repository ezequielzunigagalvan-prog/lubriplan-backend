// src/routes/assetHistory.routes.js
import { Router } from "express";
import { logger } from "../config/logger.js";

export default function assetHistoryRoutes({ prisma, auth }) {
  const router = Router();

  // GET /api/maintenance/assets/:id/history
  router.get("/:id/history", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const assetId = parseInt(req.params.id);
      if (!Number.isFinite(assetId)) return res.status(400).json({ error: "Invalid ID" });

      const days = parseInt(req.query.days) || 90;
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);

      // Get maintenance events
      const maintenanceEvents = await prisma.workOrder?.findMany({
        where: { assetId, plantId, createdAt: { gte: fromDate } },
        orderBy: { createdAt: "desc" },
        take: 100,
      }) || [];

      // Get failures
      const failureEvents = await prisma.failure?.findMany({
        where: { assetId, plantId, date: { gte: fromDate } },
        orderBy: { date: "desc" },
        take: 50,
      }) || [];

      // Combine and sort events
      const events = [
        ...maintenanceEvents.map((wo) => ({
          date: wo.createdAt,
          type: "MAINTENANCE",
          description: wo.description || `Work Order ${wo.id}`,
          workOrderId: wo.id,
          technician: "TBD",
          cost: wo.estimatedCost || 0,
        })),
        ...failureEvents.map((f) => ({
          date: f.date,
          type: "FAILURE",
          description: f.failureMode || f.cause,
          failureId: f.id,
          technician: "TBD",
          cost: f.estimatedCost || 0,
        })),
      ].sort((a, b) => b.date - a.date);

      return res.json({
        assetId,
        dateRange: { from: fromDate.toISOString(), to: new Date().toISOString(), days },
        events,
        totalEvents: events.length,
      });
    } catch (e) {
      logger.error("GET asset/:id/history", e);
      return res.status(500).json({ error: "Error loading asset history" });
    }
  });

  return router;
}
