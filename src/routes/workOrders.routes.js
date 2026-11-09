// src/routes/workOrders.routes.js
import { Router } from "express";
import { logger } from "../config/logger.js";

export default function workOrdersRoutes({ prisma, auth, requireRole }) {
  const router = Router();

  // GET /api/maintenance/work-orders
  router.get("/", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const filters = req.query;
      const where = { plantId };

      // Add filters
      if (filters.status) where.status = filters.status;
      if (filters.assignedTechnicianId) where.assignedTechnicianId = parseInt(filters.assignedTechnicianId);
      if (filters.assetId) where.assetId = parseInt(filters.assetId);

      const workOrders = await prisma.workOrder?.findMany({
        where,
        orderBy: { id: "desc" },
        take: parseInt(filters.limit) || 50,
        skip: parseInt(filters.offset) || 0,
        include: {
          asset: true,
          assignedTechnician: true,
          createdBy: true,
        },
      }) || [];

      return res.json(workOrders);
    } catch (e) {
      logger.error("GET work-orders", e);
      return res.status(500).json({ error: "Error fetching work orders" });
    }
  });

  // GET /api/maintenance/work-orders/:id
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

      const workOrder = await prisma.workOrder?.findFirst({
        where: { id, plantId },
        include: {
          asset: true,
          assignedTechnician: true,
          createdBy: true,
        },
      });

      if (!workOrder) {
        return res.status(404).json({ error: "Work order not found" });
      }

      return res.json(workOrder);
    } catch (e) {
      logger.error("GET work-order/:id", e);
      return res.status(500).json({ error: "Error fetching work order" });
    }
  });

  // PATCH /api/maintenance/work-orders/:id/status
  router.patch("/:id/status", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid ID" });
      }

      const { status, assignedTechnicianId, estimatedDate, estimatedHours, notes } = req.body;

      if (!status) {
        return res.status(400).json({ error: "Status is required" });
      }

      // Validate state transition
      const VALID_TRANSITIONS = {
        "REQUESTED": ["PENDING_APPROVAL", "PENDING_AUTHORIZATION"],
        "PENDING_APPROVAL": ["APPROVED", "REJECTED"],
        "PENDING_AUTHORIZATION": ["APPROVED", "REJECTED"],
        "APPROVED": ["ASSIGNED"],
        "ASSIGNED": ["IN_PROGRESS"],
        "IN_PROGRESS": ["FINISHED", "WAITING_PARTS"],
        "WAITING_PARTS": ["IN_PROGRESS", "FINISHED"],
        "FINISHED": ["VALIDATED", "REJECTED"],
      };

      const workOrder = await prisma.workOrder?.findFirst({
        where: { id, plantId },
      });

      if (!workOrder) {
        return res.status(404).json({ error: "Work order not found" });
      }

      const currentStatus = workOrder.status || "REQUESTED";
      const validTransitions = VALID_TRANSITIONS[currentStatus] || [];

      if (!validTransitions.includes(status)) {
        return res.status(400).json({
          error: `Cannot transition from ${currentStatus} to ${status}`,
          validTransitions,
        });
      }

      const updateData = { status };
      if (assignedTechnicianId) updateData.assignedTechnicianId = parseInt(assignedTechnicianId);
      if (estimatedDate) updateData.estimatedDate = new Date(estimatedDate);
      if (estimatedHours) updateData.estimatedHours = parseFloat(estimatedHours);
      if (notes) updateData.notes = notes;

      const updated = await prisma.workOrder?.update({
        where: { id },
        data: updateData,
        include: {
          asset: true,
          assignedTechnician: true,
        },
      });

      return res.json(updated);
    } catch (e) {
      logger.error("PATCH work-order/:id/status", e);
      return res.status(500).json({ error: "Error updating work order status" });
    }
  });

  // POST /api/maintenance/work-orders/:id/approve
  router.post("/:id/approve", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid ID" });
      }

      const { assignedTechnicianId, estimatedDate, estimatedHours, notes } = req.body;

      const workOrder = await prisma.workOrder?.findFirst({
        where: { id, plantId },
      });

      if (!workOrder) {
        return res.status(404).json({ error: "Work order not found" });
      }

      const updateData = {
        status: "APPROVED",
        approvedAt: new Date(),
        approvedBy: req.user?.id,
      };

      if (assignedTechnicianId) updateData.assignedTechnicianId = parseInt(assignedTechnicianId);
      if (estimatedDate) updateData.estimatedDate = new Date(estimatedDate);
      if (estimatedHours) updateData.estimatedHours = parseFloat(estimatedHours);
      if (notes) updateData.notes = notes;

      const updated = await prisma.workOrder?.update({
        where: { id },
        data: updateData,
        include: {
          asset: true,
          assignedTechnician: true,
        },
      });

      return res.json(updated);
    } catch (e) {
      logger.error("POST work-order/:id/approve", e);
      return res.status(500).json({ error: "Error approving work order" });
    }
  });

  // POST /api/maintenance/work-orders/:id/reject
  router.post("/:id/reject", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid ID" });
      }

      const { reason } = req.body;

      const workOrder = await prisma.workOrder?.findFirst({
        where: { id, plantId },
      });

      if (!workOrder) {
        return res.status(404).json({ error: "Work order not found" });
      }

      const updated = await prisma.workOrder?.update({
        where: { id },
        data: {
          status: "REJECTED",
          rejectedAt: new Date(),
          rejectedBy: req.user?.id,
          rejectionReason: reason || null,
        },
        include: {
          asset: true,
          assignedTechnician: true,
        },
      });

      return res.json(updated);
    } catch (e) {
      logger.error("POST work-order/:id/reject", e);
      return res.status(500).json({ error: "Error rejecting work order" });
    }
  });

  return router;
}
