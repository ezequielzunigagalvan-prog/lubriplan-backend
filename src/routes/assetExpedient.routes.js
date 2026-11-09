// src/routes/assetExpedient.routes.js
import { Router } from "express";
import { logger } from "../config/logger.js";

export default function assetExpedientRoutes({ prisma, auth }) {
  const router = Router();

  // GET /api/maintenance/assets/:id/expedient
  // Returns complete asset history including work orders, failures, spare parts, etc.
  router.get("/:id/expedient", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const assetId = parseInt(req.params.id);
      if (!Number.isFinite(assetId)) {
        return res.status(400).json({ error: "Invalid asset ID" });
      }

      // Get asset
      const asset = await prisma.asset?.findFirst({
        where: { id: assetId, plantId },
      });

      if (!asset) {
        return res.status(404).json({ error: "Asset not found" });
      }

      // Get maintenance orders/work orders
      const maintenanceOrders = await prisma.workOrder?.findMany({
        where: { assetId, plantId },
        orderBy: { createdAt: "desc" },
        include: {
          assignedTechnician: {
            select: { id: true, name: true },
          },
        },
        take: 50,
      }) || [];

      // Get failure history
      const failureHistory = await prisma.failure?.findMany({
        where: { assetId, plantId },
        orderBy: { date: "desc" },
        take: 50,
      }) || [];

      // Get spare parts associated
      const spareParts = await prisma.sparePartInventory?.findMany({
        where: { assetId, plantId },
        orderBy: { createdAt: "desc" },
      }) || [];

      // Get preventive maintenance orders
      const preventiveOrders = await prisma.preventiveOrder?.findMany({
        where: { assetId, plantId },
        orderBy: { scheduledDate: "desc" },
        take: 30,
      }) || [];

      // Calculate aggregates
      const totalWorkOrders = await prisma.workOrder?.count({
        where: { assetId, plantId },
      }) || 0;

      const preventiveCount = await prisma.preventiveOrder?.count({
        where: { assetId, plantId, type: "PREVENTIVE" },
      }) || 0;

      const correctiveCount = totalWorkOrders - preventiveCount;

      // Get cost data
      const costAggregation = await prisma.workOrder?.aggregate({
        where: { assetId, plantId, status: "FINISHED" },
        _sum: { estimatedCost: true },
      });

      const accumulatedCost = costAggregation?._sum?.estimatedCost || 0;

      // Calculate downtime
      const downtimeAggregation = await prisma.execution?.aggregate({
        where: { assetId, plantId, status: "COMPLETED" },
        _sum: { downtime: true },
      });

      const totalDowntime = downtimeAggregation?._sum?.downtime || 0;

      // Get last intervention
      const lastIntervention = await prisma.workOrder?.findFirst({
        where: { assetId, plantId, status: "FINISHED" },
        orderBy: { completedAt: "desc" },
        select: { completedAt: true },
      });

      const expedient = {
        // Asset info
        id: asset.id,
        code: asset.code,
        name: asset.name,
        manufacturer: asset.manufacturer,
        model: asset.model,
        serialNumber: asset.serialNumber,
        installationDate: asset.installationDate,
        criticality: asset.criticality,
        state: asset.state,
        responsible: asset.responsible,

        // Aggregated metrics
        totalWorkOrders,
        preventiveOrders: preventiveCount,
        correctiveOrders: correctiveCount,
        totalFailures: failureHistory.length,
        totalDowntime: Math.round(totalDowntime * 100) / 100,
        accumulatedCost: Math.round(accumulatedCost * 100) / 100,
        lastIntervention: lastIntervention?.completedAt?.toISOString() || null,

        // Detailed data
        maintenanceOrders: maintenanceOrders.map((wo) => ({
          id: wo.id,
          order: wo.workOrderCode || `WO-${wo.id}`,
          date: wo.createdAt?.toISOString(),
          type: wo.type || "CORRECTIVE",
          status: wo.status,
          technician: wo.assignedTechnician?.name || "Unassigned",
          description: wo.description,
          cost: wo.estimatedCost || 0,
        })),

        failureHistory: failureHistory.map((f) => ({
          id: f.id,
          date: f.date?.toISOString(),
          failureCode: f.failureCode,
          mode: f.failureMode,
          cause: f.cause,
          downtime: f.downtime || 0,
          cost: f.estimatedCost || 0,
          severity: f.severity,
        })),

        spareParts: spareParts.map((sp) => ({
          id: sp.id,
          part: sp.sparePartName || sp.name,
          code: sp.partCode,
          quantity: sp.quantity,
          unitCost: sp.unitCost,
          date: sp.createdAt?.toISOString(),
        })),

        monthlyCosts: [], // Can be calculated if needed
        photos: [], // Can be linked from work orders
        interventions: preventiveOrders.map((po) => ({
          id: po.id,
          date: po.scheduledDate?.toISOString(),
          type: po.type,
          description: po.description,
          technician: po.technician?.name || "TBD",
          hours: po.estimatedHours || 0,
          status: po.status,
        })),
      };

      return res.json(expedient);
    } catch (e) {
      logger.error("GET asset/:id/expedient", e);
      return res.status(500).json({ error: "Error loading asset expedient" });
    }
  });

  return router;
}
