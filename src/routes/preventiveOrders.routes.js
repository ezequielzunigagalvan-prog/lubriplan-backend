// src/routes/preventiveOrders.routes.js
import { Router } from "express";
import { logger } from "../config/logger.js";

export default function preventiveOrdersRoutes({ prisma, auth }) {
  const router = Router();

  // GET /api/maintenance/preventive-orders
  router.get("/", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const filters = req.query;
      const where = { plantId };

      if (filters.status) where.status = filters.status;
      if (filters.assetId) where.assetId = parseInt(filters.assetId);

      const orders = await prisma.preventiveOrder?.findMany({
        where,
        orderBy: { scheduledDate: "desc" },
        take: parseInt(filters.limit) || 50,
        skip: parseInt(filters.offset) || 0,
        include: {
          asset: { select: { id: true, name: true, code: true } },
          technician: { select: { id: true, name: true } },
        },
      }) || [];

      return res.json(orders);
    } catch (e) {
      logger.error("GET preventive-orders", e);
      return res.status(500).json({ error: "Error fetching preventive orders" });
    }
  });

  // GET /api/maintenance/preventive-orders/:id
  router.get("/:id", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid ID" });
      }

      const order = await prisma.preventiveOrder?.findFirst({
        where: { id, plantId },
        include: {
          asset: true,
          technician: true,
          checklistItems: { orderBy: { sequence: "asc" } },
        },
      });

      if (!order) {
        return res.status(404).json({ error: "Preventive order not found" });
      }

      const totalItems = order.checklistItems?.length || 0;
      const completedItems = order.checklistItems?.filter((item) => item.completed)?.length || 0;
      const completionPercentage = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

      return res.json({ ...order, totalItems, completedItems, completionPercentage });
    } catch (e) {
      logger.error("GET preventive-order/:id", e);
      return res.status(500).json({ error: "Error fetching preventive order" });
    }
  });

  return router;
}
