// src/routes/workOrders.routes.js
import { Router } from "express";
import { validatePlantId, validateNumericId } from "../middleware/validateRequest.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateTransition, WORK_ORDER_STATES } from "../utils/workOrderStateManager.js";
import { findOneWithPlantId, findManyWithPlantId } from "../utils/dbHelpers.js";

export default function workOrdersRoutes({ prisma, auth, requireRole }) {
  const router = Router();

  // GET /api/maintenance/work-orders
  router.get(
    "/",
    auth,
    validatePlantId,
    asyncHandler(async (req, res) => {
      const filters = req.query;
      const where = {};

      if (filters.status) where.status = filters.status;
      if (filters.assignedTechnicianId) where.assignedTechnicianId = parseInt(filters.assignedTechnicianId);
      if (filters.assetId) where.assetId = parseInt(filters.assetId);

      const workOrders = await findManyWithPlantId(
        prisma.workOrder,
        req.currentPlantId,
        where,
        {
          take: parseInt(filters.limit) || 50,
          skip: parseInt(filters.offset) || 0,
          include: { asset: true, assignedTechnician: true, createdBy: true },
        }
      );

      return res.json(workOrders);
    })
  );

  // GET /api/maintenance/work-orders/:id
  router.get(
    "/:id",
    auth,
    validatePlantId,
    validateNumericId("id"),
    asyncHandler(async (req, res) => {
      const workOrder = await findOneWithPlantId(
        prisma.workOrder,
        req.params.id,
        req.currentPlantId,
        { include: { asset: true, assignedTechnician: true, createdBy: true } }
      );

      return res.json(workOrder);
    })
  );

  // PATCH /api/maintenance/work-orders/:id/status
  router.patch(
    "/:id/status",
    auth,
    validatePlantId,
    validateNumericId("id"),
    asyncHandler(async (req, res) => {
      const { status, assignedTechnicianId, estimatedDate, estimatedHours, notes } = req.body;

      if (!status) {
        throw new Error("Status is required");
      }

      const workOrder = await findOneWithPlantId(
        prisma.workOrder,
        req.params.id,
        req.currentPlantId,
        { select: { id: true, status: true } }
      );

      const currentStatus = workOrder.status || WORK_ORDER_STATES.REQUESTED;
      const validation = validateTransition(currentStatus, status);

      if (!validation.valid) {
        return res.status(400).json(validation);
      }

      const updateData = { status };
      if (assignedTechnicianId) updateData.assignedTechnicianId = parseInt(assignedTechnicianId);
      if (estimatedDate) updateData.estimatedDate = new Date(estimatedDate);
      if (estimatedHours) updateData.estimatedHours = parseFloat(estimatedHours);
      if (notes) updateData.notes = notes;

      const updated = await prisma.workOrder?.update({
        where: { id: req.params.id },
        data: updateData,
        include: { asset: true, assignedTechnician: true },
      });

      return res.json(updated);
    })
  );

  // POST /api/maintenance/work-orders/:id/approve
  router.post(
    "/:id/approve",
    auth,
    validatePlantId,
    validateNumericId("id"),
    asyncHandler(async (req, res) => {
      await findOneWithPlantId(prisma.workOrder, req.params.id, req.currentPlantId);

      const { assignedTechnicianId, estimatedDate, estimatedHours, notes } = req.body;

      const updateData = {
        status: WORK_ORDER_STATES.APPROVED,
        approvedAt: new Date(),
        approvedBy: req.user?.id,
      };

      if (assignedTechnicianId) updateData.assignedTechnicianId = parseInt(assignedTechnicianId);
      if (estimatedDate) updateData.estimatedDate = new Date(estimatedDate);
      if (estimatedHours) updateData.estimatedHours = parseFloat(estimatedHours);
      if (notes) updateData.notes = notes;

      const updated = await prisma.workOrder?.update({
        where: { id: req.params.id },
        data: updateData,
        include: { asset: true, assignedTechnician: true },
      });

      return res.json(updated);
    })
  );

  // POST /api/maintenance/work-orders/:id/reject
  router.post(
    "/:id/reject",
    auth,
    validatePlantId,
    validateNumericId("id"),
    asyncHandler(async (req, res) => {
      await findOneWithPlantId(prisma.workOrder, req.params.id, req.currentPlantId);

      const { reason } = req.body;

      const updated = await prisma.workOrder?.update({
        where: { id: req.params.id },
        data: {
          status: WORK_ORDER_STATES.REJECTED,
          rejectedAt: new Date(),
          rejectedBy: req.user?.id,
          rejectionReason: reason || null,
        },
        include: { asset: true, assignedTechnician: true },
      });

      return res.json(updated);
    })
  );

  return router;
}
