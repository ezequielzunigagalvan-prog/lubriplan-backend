import express from "express";
import { z } from "zod";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { getNextWorkOrderNumber, formatWorkOrderNumber } from "../utils/numeracion.js";

const router = express.Router();

const createPlanSchema = z.object({
  assetId: z.number().int().positive(),
  code: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["PREVENTIVE", "INSPECTION"]).default("PREVENTIVE"),
  triggerType: z.enum(["TIME", "METER"]).default("TIME"),
  frequencyUnit: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]).optional(),
  frequencyEvery: z.number().int().min(1).max(365).optional(),
  scheduleMode: z.enum(["FIXED", "FLOATING"]).default("FIXED"),
  anchorDate: z.string().datetime(),
  leadDays: z.number().int().min(0).max(60).default(0),
  graceDays: z.number().int().min(0).max(60).default(0),
  priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  defaultAssigneeId: z.number().int().optional(),
  estimatedMinutes: z.number().int().positive().optional(),
  skipIfOpen: z.boolean().default(true),
  meterBaseline: z.number().optional(),
  meterIntervalHours: z.number().optional(),
  tasks: z.array(
    z.object({
      position: z.number().int().min(0),
      description: z.string().min(1),
      kind: z.enum(["CHECK", "MEASURE", "TEXT"]),
      unit: z.string().optional(),
      minValue: z.number().optional(),
      maxValue: z.number().optional(),
      required: z.boolean().default(true),
      createsCorrectiveOnFail: z.boolean().default(false),
    })
  ).max(50).default([]),
});

router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { assetId, active, type, overdue, search, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const skip = (pageNum - 1) * limitNum;

    const where = {
      plantId,
      deletedAt: null,
    };

    if (assetId) where.assetId = parseInt(assetId);
    if (active !== undefined) where.active = active === "true";
    if (type) where.type = type;
    if (search) {
      where.OR = [
        { code: { contains: search, mode: "insensitive" } },
        { title: { contains: search, mode: "insensitive" } },
      ];
    }

    let plans = await prisma.mtPlan.findMany({
      where,
      select: {
        id: true,
        code: true,
        title: true,
        type: true,
        triggerType: true,
        priority: true,
        active: true,
        nextDueAt: true,
        lastCompletedAt: true,
        assetId: true,
      },
      skip,
      take: limitNum,
      orderBy: { createdAt: "desc" },
    });

    if (overdue === "1" || overdue === "true") {
      const now = new Date();
      plans = plans.filter((p) => p.nextDueAt && new Date(p.nextDueAt) < now && p.active);
    }

    const total = await prisma.mtPlan.count({ where });

    return res.json({
      data: plans,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    logger.error("[plans GET]", err);
    return res.status(500).json({ error: "Error fetching plans" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const planId = parseInt(req.params.id);

    const plan = await prisma.mtPlan.findFirst({
      where: { id: planId, plantId, deletedAt: null },
      include: { tasks: { orderBy: { position: "asc" } } },
    });

    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    return res.json(plan);
  } catch (err) {
    logger.error("[plans/:id GET]", err);
    return res.status(500).json({ error: "Error fetching plan" });
  }
});

router.post("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const user = req.user;

    if (!["ADMIN", "SUPERVISOR"].includes(user.role)) {
      return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can create plans" });
    }

    const parsed = createPlanSchema.parse(req.body);

    const asset = await prisma.mtAsset.findFirst({
      where: { id: parsed.assetId, plantId, deletedAt: null },
      select: { id: true },
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const planCode = `PM-${String(await getNextWorkOrderNumber(plantId)).padStart(5, "0")}`;

    const plan = await prisma.mtPlan.create({
      data: {
        plantId,
        code: planCode,
        assetId: parsed.assetId,
        title: parsed.title,
        description: parsed.description,
        type: parsed.type,
        triggerType: parsed.triggerType,
        frequencyUnit: parsed.frequencyUnit,
        frequencyEvery: parsed.frequencyEvery,
        scheduleMode: parsed.scheduleMode,
        anchorDate: new Date(parsed.anchorDate),
        leadDays: parsed.leadDays,
        graceDays: parsed.graceDays,
        priority: parsed.priority,
        defaultAssigneeId: parsed.defaultAssigneeId,
        estimatedMinutes: parsed.estimatedMinutes,
        skipIfOpen: parsed.skipIfOpen,
        meterBaseline: parsed.meterBaseline,
        meterIntervalHours: parsed.meterIntervalHours,
        active: true,
        createdBy: user.id,
        tasks: {
          create: parsed.tasks,
        },
      },
      include: { tasks: true },
    });

    return res.status(201).json(plan);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message });
    }
    logger.error("[plans POST]", err);
    return res.status(500).json({ error: "Error creating plan" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const planId = parseInt(req.params.id);
    const user = req.user;

    if (!["ADMIN", "SUPERVISOR"].includes(user.role)) {
      return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can update plans" });
    }

    const plan = await prisma.mtPlan.findFirst({
      where: { id: planId, plantId, deletedAt: null },
    });

    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    const updateData = {};
    const allowedFields = [
      "title",
      "description",
      "frequencyUnit",
      "frequencyEvery",
      "scheduleMode",
      "leadDays",
      "graceDays",
      "priority",
      "defaultAssigneeId",
      "estimatedMinutes",
      "skipIfOpen",
    ];

    for (const field of allowedFields) {
      if (field in req.body) {
        updateData[field] = req.body[field];
      }
    }

    if ("anchorDate" in req.body) {
      updateData.anchorDate = new Date(req.body.anchorDate);
    }

    if ("tasks" in req.body && Array.isArray(req.body.tasks) && req.body.tasks.length <= 50) {
      await prisma.mtPlanTask.deleteMany({ where: { planId } });
      updateData.tasks = {
        create: req.body.tasks,
      };
    }

    const updated = await prisma.mtPlan.update({
      where: { id: planId },
      data: updateData,
      include: { tasks: true },
    });

    return res.json(updated);
  } catch (err) {
    logger.error("[plans PATCH]", err);
    return res.status(500).json({ error: "Error updating plan" });
  }
});

router.post("/:id/pause", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const planId = parseInt(req.params.id);
    const user = req.user;

    if (!["ADMIN", "SUPERVISOR"].includes(user.role)) {
      return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can pause plans" });
    }

    const plan = await prisma.mtPlan.findFirst({
      where: { id: planId, plantId, deletedAt: null },
    });

    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    const updated = await prisma.mtPlan.update({
      where: { id: planId },
      data: { active: false },
    });

    return res.json({ message: "Plan paused", plan: updated });
  } catch (err) {
    logger.error("[plans/:id/pause POST]", err);
    return res.status(500).json({ error: "Error pausing plan" });
  }
});

router.post("/:id/resume", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const planId = parseInt(req.params.id);
    const user = req.user;

    if (!["ADMIN", "SUPERVISOR"].includes(user.role)) {
      return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can resume plans" });
    }

    const plan = await prisma.mtPlan.findFirst({
      where: { id: planId, plantId, deletedAt: null },
    });

    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    const updated = await prisma.mtPlan.update({
      where: { id: planId },
      data: { active: true },
    });

    return res.json({ message: "Plan resumed", plan: updated });
  } catch (err) {
    logger.error("[plans/:id/resume POST]", err);
    return res.status(500).json({ error: "Error resuming plan" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const planId = parseInt(req.params.id);
    const user = req.user;

    if (!["ADMIN", "SUPERVISOR"].includes(user.role)) {
      return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can delete plans" });
    }

    const plan = await prisma.mtPlan.findFirst({
      where: { id: planId, plantId, deletedAt: null },
    });

    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    const deleted = await prisma.mtPlan.update({
      where: { id: planId },
      data: { deletedAt: new Date() },
    });

    return res.json({ message: "Plan deleted", plan: deleted });
  } catch (err) {
    logger.error("[plans DELETE]", err);
    return res.status(500).json({ error: "Error deleting plan" });
  }
});

router.get("/:id/history", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const planId = parseInt(req.params.id);

    const plan = await prisma.mtPlan.findFirst({
      where: { id: planId, plantId, deletedAt: null },
      select: { id: true },
    });

    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    const workOrders = await prisma.mtWorkOrder.findMany({
      where: { planId, plantId },
      select: {
        id: true,
        number: true,
        cycleKey: true,
        status: true,
        dueAt: true,
        finishedAt: true,
        createdAt: true,
      },
      orderBy: { dueAt: "desc" },
      take: 100,
    });

    const runs = await prisma.mtPlanRun.findMany({
      where: { planId, plantId },
      orderBy: { runAt: "desc" },
      take: 50,
    });

    const total = workOrders.length;
    const completed = workOrders.filter((w) => ["FINISHED", "VALIDATED"].includes(w.status)).length;
    const onTime = workOrders.filter(
      (w) => w.finishedAt && w.dueAt && new Date(w.finishedAt) <= new Date(w.dueAt)
    ).length;
    const compliance = total > 0 ? ((onTime / total) * 100).toFixed(1) : 0;

    return res.json({
      plan: { id: planId },
      summary: {
        total,
        completed,
        onTime,
        compliancePercent: compliance,
      },
      workOrders,
      runs,
    });
  } catch (err) {
    logger.error("[plans/:id/history GET]", err);
    return res.status(500).json({ error: "Error fetching plan history" });
  }
});

export default router;
