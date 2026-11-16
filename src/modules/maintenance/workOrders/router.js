import express from "express";
import { z } from "zod";
import multer from "multer";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { uploadBufferToCloudinary, destroyCloudinaryImage } from "../../../lib/cloudinary.js";
import { canTransition, getRequiredFieldsForTransition } from "./stateMachine.js";
import { getNextWorkOrderNumber, formatWorkOrderNumber } from "../utils/numeracion.js";
import { isAssignedTo } from "../permissions.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowed.includes(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Image format not allowed"));
    }
    return cb(null, true);
  },
});

const createWOSchema = z.object({
  type: z.enum(["CORRECTIVE", "PREVENTIVE", "INSPECTION"]),
  assetId: z.number().int().positive().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  autoApprove: z.boolean().default(false),
  status: z.string().optional(), // Ignore status from frontend
  comments: z.string().optional(), // Store comments separately if needed
}).strict(false);

const transitionSchema = z.object({
  to: z.enum(["REQUESTED", "REJECTED", "APPROVED", "ASSIGNED", "IN_PROGRESS", "WAITING_PARTS", "WAITING_PRODUCTION", "FINISHED", "VALIDATED", "CANCELLED"]),
  comment: z.string().optional(),
  assignedTo: z.number().int().optional(),
  priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).optional(),
  scheduledAt: z.string().datetime().optional(),
  expectedVersion: z.number().int().default(0),
});

const executionSchema = z.object({
  diagnosis: z.string().optional(),
  failureCause: z.string().optional(),
  workDone: z.string().min(1),
  downtimeMinutes: z.number().int().nonnegative().optional(),
  expectedVersion: z.number().int().default(0),
});

router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { status, priority, type, assetId, assignedTo, mine, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const skip = (pageNum - 1) * limitNum;

    const where = { plantId };
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (type) where.type = type;
    if (assetId) where.assetId = parseInt(assetId);

    if (mine === "1" || mine === "true") {
      where.OR = [
        { assignedTo: req.user.id },
        { requestedBy: req.user.id },
      ];
    } else if (assignedTo) {
      where.assignedTo = parseInt(assignedTo);
    }

    const [workOrders, total] = await Promise.all([
      prisma.mtWorkOrder.findMany({
        where,
        select: {
          id: true,
          number: true,
          type: true,
          status: true,
          priority: true,
          title: true,
          assetId: true,
          assignedTo: true,
          requestedBy: true,
          scheduledAt: true,
          createdAt: true,
        },
        skip,
        take: limitNum,
        orderBy: { createdAt: "desc" },
      }),
      prisma.mtWorkOrder.count({ where }),
    ]);

    return res.json({
      data: workOrders,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    logger.error("[workOrders GET]", err);
    return res.status(500).json({ error: "Error fetching work orders" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const woId = parseInt(req.params.id);

    const wo = await prisma.mtWorkOrder.findFirst({
      where: { id: woId, plantId },
    });

    if (!wo) {
      return res.status(404).json({ error: "Work order not found" });
    }

    const [events, photos] = await Promise.all([
      prisma.mtWorkOrderEvent.findMany({
        where: { workOrderId: woId, plantId },
        orderBy: { createdAt: "asc" },
      }),
      prisma.mtWorkOrderPhoto.findMany({
        where: { workOrderId: woId, plantId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return res.json({ workOrder: wo, events, photos });
  } catch (err) {
    logger.error("[workOrders/:id GET]", err);
    return res.status(500).json({ error: "Error fetching work order" });
  }
});

router.post("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const parsed = createWOSchema.parse(req.body);

    const number = await getNextWorkOrderNumber(plantId);

    const wo = await prisma.mtWorkOrder.create({
      data: {
        plantId,
        number,
        type: parsed.type,
        assetId: parsed.assetId,
        title: parsed.title,
        description: parsed.description,
        priority: parsed.priority,
        requestedBy: req.user.id,
        status: parsed.autoApprove && ["ADMIN", "SUPERVISOR"].includes(req.user.role) ? "APPROVED" : "REQUESTED",
      },
      select: {
        id: true,
        number: true,
        status: true,
        createdAt: true,
      },
    });

    if (wo.status === "APPROVED") {
      await prisma.mtWorkOrderEvent.create({
        data: {
          workOrderId: wo.id,
          plantId,
          toStatus: "APPROVED",
          userId: req.user.id,
          comment: "Auto-approved by requester",
        },
      });
    }

    return res.status(201).json({ ...wo, number: formatWorkOrderNumber(wo.number) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message });
    }
    logger.error("[workOrders POST]", err);
    return res.status(500).json({ error: "Error creating work order" });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const woId = parseInt(req.params.id);
    const { status, assignedTechnicianId, estimatedDate, estimatedHours, notes } = req.body;

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    const wo = await prisma.mtWorkOrder.findFirst({
      where: { id: woId, plantId },
    });

    if (!wo) {
      return res.status(404).json({ error: "Work order not found" });
    }

    const updateData = { status };
    if (assignedTechnicianId) updateData.assignedTo = parseInt(assignedTechnicianId);
    if (estimatedDate) updateData.scheduledAt = new Date(estimatedDate);

    const updated = await prisma.mtWorkOrder.update({
      where: { id: woId },
      data: updateData,
      include: {
        asset: true,
        events: true,
      },
    });

    console.log("[workOrders PATCH /status] Updated WO", woId, "to status", status);
    return res.json(updated);
  } catch (err) {
    logger.error("[workOrders PATCH /status]", err);
    return res.status(500).json({ error: "Error updating work order status" });
  }
});

router.post("/:id/transition", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const woId = parseInt(req.params.id);
    const parsed = transitionSchema.parse(req.body);

    const wo = await prisma.mtWorkOrder.findFirst({
      where: { id: woId, plantId },
    });

    if (!wo) {
      return res.status(404).json({ error: "Work order not found" });
    }

    const transition = canTransition(wo, parsed.to, req.user);
    if (!transition.allowed) {
      return res.status(403).json({ error: transition.reason });
    }

    const requiredFields = getRequiredFieldsForTransition(wo.status, parsed.to);
    for (const [field, msg] of Object.entries(requiredFields)) {
      if (!(field in req.body)) {
        return res.status(400).json({ error: msg });
      }
    }

    if (parsed.to === "ASSIGNED" && !parsed.assignedTo) {
      return res.status(400).json({ error: "assignedTo is required" });
    }

    if (parsed.to === "FINISHED" && !req.body.workDone) {
      return res.status(400).json({ error: "workDone is required" });
    }

    const updateData = {
      status: parsed.to,
      version: { increment: 1 },
    };

    if (parsed.to === "ASSIGNED") {
      updateData.assignedTo = parsed.assignedTo;
      if (parsed.scheduledAt) updateData.scheduledAt = new Date(parsed.scheduledAt);
    }

    if (parsed.to === "IN_PROGRESS" && !wo.startedAt) {
      updateData.startedAt = new Date();
    }

    if (parsed.to === "FINISHED") {
      updateData.finishedAt = new Date();
      updateData.workDone = req.body.workDone;
      if (req.body.diagnosis) updateData.diagnosis = req.body.diagnosis;
      if (req.body.failureCause) updateData.failureCause = req.body.failureCause;
      if (Number.isFinite(req.body.downtimeMinutes)) updateData.downtimeMinutes = req.body.downtimeMinutes;
    }

    if (parsed.to === "VALIDATED") {
      updateData.validatedAt = new Date();
      updateData.validatedBy = req.user.id;
    }

    if (parsed.priority) {
      updateData.priority = parsed.priority;
    }

    const updated = await prisma.mtWorkOrder.updateMany({
      where: { id: woId, plantId, version: parsed.expectedVersion },
      data: updateData,
    });

    if (updated.count === 0) {
      return res.status(409).json({ error: "CONFLICT: Work order version mismatch or concurrent edit" });
    }

    const updatedWO = await prisma.mtWorkOrder.findUnique({
      where: { id: woId },
    });

    if (parsed.to === "FINISHED" && wo.planId) {
      await prisma.mtPlan.update({
        where: { id: wo.planId },
        data: { lastCompletedAt: new Date() },
      });
    }

    await prisma.mtWorkOrderEvent.create({
      data: {
        workOrderId: woId,
        plantId,
        fromStatus: wo.status,
        toStatus: parsed.to,
        userId: req.user.id,
        comment: parsed.comment,
        metadata: parsed.to === "IN_PROGRESS" ? { startedAt: new Date().toISOString() } : null,
      },
    });

    return res.json(updatedWO);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message });
    }
    logger.error("[workOrders/:id/transition POST]", err);
    return res.status(500).json({ error: "Error transitioning work order" });
  }
});

router.patch("/:id/execution", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const woId = parseInt(req.params.id);
    const parsed = executionSchema.parse(req.body);

    const wo = await prisma.mtWorkOrder.findFirst({
      where: { id: woId, plantId },
    });

    if (!wo) {
      return res.status(404).json({ error: "Work order not found" });
    }

    if (!isAssignedTo(wo, req.user)) {
      return res.status(403).json({ error: "Only assigned technician can update execution" });
    }

    const allowedStatuses = ["IN_PROGRESS", "WAITING_PARTS", "WAITING_PRODUCTION"];
    if (!allowedStatuses.includes(wo.status)) {
      return res.status(409).json({ error: `Cannot update execution in ${wo.status} status` });
    }

    const updateData = {};
    if (parsed.diagnosis) updateData.diagnosis = parsed.diagnosis;
    if (parsed.failureCause) updateData.failureCause = parsed.failureCause;
    if (parsed.workDone) updateData.workDone = parsed.workDone;
    if (Number.isFinite(parsed.downtimeMinutes)) updateData.downtimeMinutes = parsed.downtimeMinutes;

    const updated = await prisma.mtWorkOrder.updateMany({
      where: { id: woId, plantId, version: parsed.expectedVersion },
      data: { ...updateData, version: { increment: 1 } },
    });

    if (updated.count === 0) {
      return res.status(409).json({ error: "CONFLICT: Work order version mismatch" });
    }

    const result = await prisma.mtWorkOrder.findUnique({
      where: { id: woId },
    });

    return res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message });
    }
    logger.error("[workOrders/:id/execution PATCH]", err);
    return res.status(500).json({ error: "Error updating execution" });
  }
});

router.post("/:id/photos", upload.single("image"), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const woId = parseInt(req.params.id);
    const { kind = "OTHER" } = req.body;

    if (!req.file?.buffer) {
      return res.status(400).json({ error: "No image provided" });
    }

    const wo = await prisma.mtWorkOrder.findFirst({
      where: { id: woId, plantId },
    });

    if (!wo) {
      return res.status(404).json({ error: "Work order not found" });
    }

    const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
      folder: `maintenance/${plantId}`,
      publicId: `wo_${woId}_${kind}_${Date.now()}`,
    });

    const photo = await prisma.mtWorkOrderPhoto.create({
      data: {
        workOrderId: woId,
        plantId,
        kind,
        url: uploaded.secure_url,
        publicId: uploaded.public_id,
        uploadedBy: req.user.id,
      },
    });

    return res.status(201).json(photo);
  } catch (err) {
    logger.error("[workOrders/:id/photos POST]", err);
    const message = String(err?.message || "").trim();
    const status = /Cloudinary no esta configurado/i.test(message) ? 503 : 500;
    return res.status(status).json({ error: message || "Error uploading photo" });
  }
});

router.post("/report-failure", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { assetId, title, description, severity = "HIGH" } = req.body;

    if (!title || !assetId) {
      return res.status(400).json({ error: "title and assetId are required" });
    }

    const number = await getNextWorkOrderNumber(plantId);

    const wo = await prisma.mtWorkOrder.create({
      data: {
        plantId,
        number,
        type: "CORRECTIVE",
        priority: severity,
        assetId: parseInt(assetId),
        title,
        description: description || "",
        requestedBy: req.user.id,
        status: "REQUESTED",
      },
      select: {
        id: true,
        number: true,
        status: true,
        createdAt: true,
      },
    });

    return res.status(201).json({
      ...wo,
      number: formatWorkOrderNumber(wo.number),
      message: "Falla reportada exitosamente"
    });
  } catch (err) {
    logger.error("[workOrders/report-failure POST]", err);
    return res.status(500).json({ error: "Error reporting failure" });
  }
});

router.delete("/:id/photos/:photoId", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const woId = parseInt(req.params.id);
    const photoId = parseInt(req.params.photoId);

    const photo = await prisma.mtWorkOrderPhoto.findFirst({
      where: { id: photoId, workOrderId: woId, plantId },
    });

    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    await destroyCloudinaryImage(photo.publicId);

    await prisma.mtWorkOrderPhoto.delete({
      where: { id: photoId },
    });

    return res.json({ message: "Photo deleted" });
  } catch (err) {
    logger.error("[workOrders/:id/photos/:photoId DELETE]", err);
    return res.status(500).json({ error: "Error deleting photo" });
  }
});

router.patch("/:id/tasks/:taskId", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const woId = parseInt(req.params.id);
    const taskId = parseInt(req.params.taskId);

    const wo = await prisma.mtWorkOrder.findFirst({
      where: { id: woId, plantId },
    });

    if (!wo) {
      return res.status(404).json({ error: "Work order not found" });
    }

    if (wo.status !== "IN_PROGRESS") {
      return res.status(409).json({ error: "Only IN_PROGRESS work orders can have tasks updated" });
    }

    if (wo.assignedTo !== req.user.id && !["ADMIN", "SUPERVISOR"].includes(req.user.role)) {
      return res.status(403).json({ error: "Only assigned technician can update task results" });
    }

    const task = await prisma.mtWorkOrderTask.findFirst({
      where: { id: taskId, workOrderId: woId, plantId },
    });

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    const updateData = {
      doneAt: new Date(),
      doneBy: req.user.id,
    };

    if ("result" in req.body) {
      updateData.result = req.body.result;
    } else if (task.kind === "MEASURE" && Number.isFinite(req.body.valueNumber)) {
      if (
        (task.minValue != null && req.body.valueNumber < task.minValue) ||
        (task.maxValue != null && req.body.valueNumber > task.maxValue)
      ) {
        updateData.result = "NOT_OK";
      } else {
        updateData.result = "OK";
      }
    }

    if ("valueNumber" in req.body) {
      updateData.valueNumber = req.body.valueNumber;
    }
    if ("valueText" in req.body) {
      updateData.valueText = req.body.valueText;
    }
    if ("note" in req.body) {
      updateData.note = req.body.note;
    }

    const updated = await prisma.mtWorkOrderTask.update({
      where: { id: taskId },
      data: updateData,
    });

    return res.json(updated);
  } catch (err) {
    logger.error("[workOrders/:id/tasks/:taskId PATCH]", err);
    return res.status(500).json({ error: "Error updating task" });
  }
});

export default router;
