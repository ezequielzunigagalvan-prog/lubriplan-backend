import express from "express";
import { z } from "zod";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { getNextPlanCode } from "../utils/numeracion.js";
import { executePlan, completePlanExecution, getPlanRoadmap } from "./planExecution.js";
import { getOverduePlans, getUpcomingPlans } from "./planScheduler.js";
import { computeNextDueAt } from "./schedule.js";
import { startOfLocalDay } from "../scheduler/dates.js";

const router = express.Router();

const MANAGER_ROLES = ["ADMIN", "SUPERVISOR"];
// Campos que, al cambiar, obligan a recalcular la próxima fecha
const SCHEDULE_FIELDS = ["anchorDate", "frequencyUnit", "frequencyEvery", "scheduleMode", "triggerType"];

const isManager = (user) => MANAGER_ROLES.includes(user?.role);

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function zodMessage(err) {
  return err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

// "" / null -> undefined, para que los campos opcionales vacíos no rompan la validación
const emptyToUndefined = (v) => (v === "" || v === null ? undefined : v);
const optionalNumber = (schema) => z.preprocess(emptyToUndefined, schema.optional());

const taskSchema = z.object({
  position: z.coerce.number().int().min(0),
  description: z.string().trim().min(1, "La descripción de la tarea es requerida"),
  kind: z.enum(["CHECK", "MEASURE", "TEXT"]),
  unit: z.preprocess(emptyToUndefined, z.string().trim().optional()),
  minValue: optionalNumber(z.coerce.number()),
  maxValue: optionalNumber(z.coerce.number()),
  required: z.boolean().default(true),
  createsCorrectiveOnFail: z.boolean().default(false),
});

const planFields = {
  assetId: z.coerce.number().int().positive(),
  title: z.string().trim().min(1, "El título es requerido").max(200),
  description: z.preprocess(emptyToUndefined, z.string().trim().max(5000).optional()),
  type: z.enum(["PREVENTIVE", "INSPECTION"]),
  triggerType: z.enum(["TIME", "METER"]),
  frequencyUnit: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
  frequencyEvery: z.coerce.number().int().min(1).max(365),
  scheduleMode: z.enum(["FIXED", "FLOATING"]),
  anchorDate: z
    .string()
    .refine((v) => /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v)), "Debe ser YYYY-MM-DD o fecha ISO"),
  leadDays: z.coerce.number().int().min(0).max(60),
  graceDays: z.coerce.number().int().min(0).max(60),
  priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  defaultAssigneeId: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().nullable().optional()),
  estimatedMinutes: optionalNumber(z.coerce.number().int().positive()),
  skipIfOpen: z.boolean(),
  meterBaseline: optionalNumber(z.coerce.number()),
  meterIntervalHours: optionalNumber(z.coerce.number().positive()),
  tasks: z.array(taskSchema).max(50),
};

const createPlanSchema = z
  .object({
    ...planFields,
    type: planFields.type.default("PREVENTIVE"),
    triggerType: planFields.triggerType.default("TIME"),
    frequencyUnit: planFields.frequencyUnit.optional(),
    frequencyEvery: planFields.frequencyEvery.optional(),
    scheduleMode: planFields.scheduleMode.default("FIXED"),
    leadDays: planFields.leadDays.default(0),
    graceDays: planFields.graceDays.default(0),
    priority: planFields.priority.default("MEDIUM"),
    skipIfOpen: planFields.skipIfOpen.default(true),
    tasks: planFields.tasks.default([]),
  })
  .refine((p) => p.triggerType !== "TIME" || (p.frequencyUnit && p.frequencyEvery), {
    message: "Los planes por tiempo requieren frecuencia (unidad y cada cuánto)",
    path: ["frequencyUnit"],
  });

const updatePlanSchema = z.object({ ...planFields, active: z.boolean() }).partial();

/** "2026-11-17" -> medianoche de ese día en la zona de la planta; ISO completo se respeta. */
function parseAnchorDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return startOfLocalDay(new Date(`${value}T12:00:00.000Z`));
  return new Date(value);
}

const taskRows = (tasks) =>
  tasks.map((t, idx) => ({
    position: t.position ?? idx,
    description: t.description,
    kind: t.kind,
    unit: t.unit ?? null,
    minValue: t.minValue ?? null,
    maxValue: t.maxValue ?? null,
    required: t.required,
    createsCorrectiveOnFail: t.createsCorrectiveOnFail,
  }));

const planDetailInclude = {
  asset: { select: { id: true, code: true, name: true } },
  tasks: { orderBy: { position: "asc" } },
  technicians: { include: { technician: { select: { id: true, name: true, code: true, specialty: true } } } },
  spareParts: { include: { sparePart: { select: { id: true, code: true, name: true, unit: true, costPerUnit: true } } } },
};

async function findPlan(planId, plantId) {
  return prisma.mtPlan.findFirst({ where: { id: planId, plantId, deletedAt: null } });
}

/** Valida y carga el plan de la planta desde :id; responde 400/404 si no aplica. */
async function loadPlanOr404(req, res) {
  const planId = parseId(req.params.id);
  if (!planId) {
    res.status(400).json({ error: "Invalid plan id" });
    return null;
  }
  const plan = await findPlan(planId, req.currentPlantId);
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return null;
  }
  return plan;
}

// GET /api/maintenance/plans?assetId=&active=&type=&overdue=&search=&page=&limit=
router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { assetId, active, type, overdue, search, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const where = { plantId, deletedAt: null };
    if (assetId) where.assetId = parseId(assetId) ?? -1;
    if (active === "true" || active === "false") where.active = active === "true";
    if (type === "PREVENTIVE" || type === "INSPECTION") where.type = type;
    if (overdue === "1" || overdue === "true") {
      where.active = true;
      where.nextDueAt = { lt: new Date() };
    }
    if (search?.trim()) {
      where.OR = [
        { code: { contains: search.trim(), mode: "insensitive" } },
        { title: { contains: search.trim(), mode: "insensitive" } },
      ];
    }

    const [plans, total] = await Promise.all([
      prisma.mtPlan.findMany({
        where,
        select: {
          id: true,
          code: true,
          title: true,
          type: true,
          triggerType: true,
          priority: true,
          active: true,
          frequencyUnit: true,
          frequencyEvery: true,
          scheduleMode: true,
          anchorDate: true,
          leadDays: true,
          nextDueAt: true,
          lastGeneratedAt: true,
          lastCompletedAt: true,
          assetId: true,
          asset: { select: { id: true, code: true, name: true } },
          _count: { select: { tasks: true, technicians: true, spareParts: true } },
        },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        orderBy: { createdAt: "desc" },
      }),
      prisma.mtPlan.count({ where }),
    ]);

    return res.json({ data: plans, total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) {
    logger.error("[plans GET]", err);
    return res.status(500).json({ error: "Error fetching plans" });
  }
});

// ---- Rutas estáticas (antes de /:id) ----

router.get("/search/assets", async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    const where = { plantId: req.currentPlantId, deletedAt: null };
    if (q) where.OR = [{ code: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }];

    const assets = await prisma.mtAsset.findMany({
      where,
      select: { id: true, code: true, name: true, location: true, level: true },
      take: Math.min(100, parseInt(limit, 10) || 20),
    });
    return res.json(assets);
  } catch (err) {
    logger.error("[plans/search/assets GET]", err);
    return res.status(500).json({ error: "Error searching assets" });
  }
});

router.get("/search/technicians", async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    const where = { plantId: req.currentPlantId, deletedAt: null };
    if (q) where.OR = [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }];

    const technicians = await prisma.technician.findMany({
      where,
      select: { id: true, name: true, code: true, email: true },
      take: Math.min(100, parseInt(limit, 10) || 20),
    });
    return res.json(technicians);
  } catch (err) {
    logger.error("[plans/search/technicians GET]", err);
    return res.status(500).json({ error: "Error searching technicians" });
  }
});

router.get("/search/spareparts", async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    const where = { plantId: req.currentPlantId, status: "ACTIVE" };
    if (q) where.OR = [{ code: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }];

    const spares = await prisma.mtSparePart.findMany({
      where,
      select: { id: true, code: true, name: true, costPerUnit: true },
      take: Math.min(100, parseInt(limit, 10) || 20),
    });
    return res.json(spares);
  } catch (err) {
    logger.error("[plans/search/spareparts GET]", err);
    return res.status(500).json({ error: "Error searching spare parts" });
  }
});

router.get("/list/overdue", async (req, res) => {
  try {
    return res.json(await getOverduePlans(req.currentPlantId));
  } catch (err) {
    logger.error("[plans/overdue GET]", err);
    return res.status(500).json({ error: "Error fetching overdue plans" });
  }
});

router.get("/list/upcoming", async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 7));
    return res.json(await getUpcomingPlans(req.currentPlantId, days));
  } catch (err) {
    logger.error("[plans/upcoming GET]", err);
    return res.status(500).json({ error: "Error fetching upcoming plans" });
  }
});

router.post("/execution/:id/complete", async (req, res) => {
  try {
    const executionId = parseId(req.params.id);
    if (!executionId) return res.status(400).json({ error: "Invalid execution id" });

    const execution = await completePlanExecution(executionId, req.currentPlantId, req.body);
    if (!execution) return res.status(404).json({ error: "Execution not found" });
    return res.json(execution);
  } catch (err) {
    logger.error("[plans/execution/:id/complete POST]", err);
    return res.status(500).json({ error: "Error completing plan execution" });
  }
});

// ---- CRUD ----

router.get("/:id", async (req, res) => {
  try {
    const planId = parseId(req.params.id);
    if (!planId) return res.status(400).json({ error: "Invalid plan id" });

    const plan = await prisma.mtPlan.findFirst({
      where: { id: planId, plantId: req.currentPlantId, deletedAt: null },
      include: planDetailInclude,
    });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    return res.json(plan);
  } catch (err) {
    logger.error("[plans/:id GET]", err);
    return res.status(500).json({ error: "Error fetching plan" });
  }
});

router.post("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!isManager(req.user)) {
      return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can create plans" });
    }

    const parsed = createPlanSchema.parse(req.body);

    const asset = await prisma.mtAsset.findFirst({
      where: { id: parsed.assetId, plantId, deletedAt: null },
      select: { id: true },
    });
    if (!asset) return res.status(404).json({ error: "Asset not found" });

    const plan = await prisma.$transaction(async (tx) => {
      const data = {
        plantId,
        code: await getNextPlanCode(plantId, tx),
        assetId: parsed.assetId,
        title: parsed.title,
        description: parsed.description ?? null,
        type: parsed.type,
        triggerType: parsed.triggerType,
        frequencyUnit: parsed.frequencyUnit ?? null,
        frequencyEvery: parsed.frequencyEvery ?? null,
        scheduleMode: parsed.scheduleMode,
        anchorDate: parseAnchorDate(parsed.anchorDate),
        leadDays: parsed.leadDays,
        graceDays: parsed.graceDays,
        priority: parsed.priority,
        defaultAssigneeId: parsed.defaultAssigneeId ?? null,
        estimatedMinutes: parsed.estimatedMinutes ?? null,
        skipIfOpen: parsed.skipIfOpen,
        meterBaseline: parsed.meterBaseline ?? null,
        meterIntervalHours: parsed.meterIntervalHours ?? null,
        active: true,
        createdBy: req.user.id,
      };
      data.nextDueAt = computeNextDueAt(data);
      if (parsed.tasks.length > 0) data.tasks = { create: taskRows(parsed.tasks) };

      return tx.mtPlan.create({ data, include: planDetailInclude });
    });

    return res.status(201).json(plan);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: zodMessage(err) });
    logger.error("[plans POST]", err);
    return res.status(500).json({ error: "Error creating plan" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!isManager(req.user)) {
      return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can update plans" });
    }

    const plan = await loadPlanOr404(req, res);
    if (!plan) return;

    const { tasks, anchorDate, ...fields } = updatePlanSchema.parse(req.body);
    const updateData = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (anchorDate) updateData.anchorDate = parseAnchorDate(anchorDate);
    // Campos opcionales que el formulario manda vacíos para borrarlos
    for (const field of ["description", "estimatedMinutes", "defaultAssigneeId"]) {
      if (field in req.body && (req.body[field] === "" || req.body[field] === null)) updateData[field] = null;
    }

    if (updateData.assetId && updateData.assetId !== plan.assetId) {
      const asset = await prisma.mtAsset.findFirst({ where: { id: updateData.assetId, plantId, deletedAt: null }, select: { id: true } });
      if (!asset) return res.status(404).json({ error: "Asset not found" });
    }

    // Recalcular la próxima fecha si cambió la programación o si se reactiva el plan
    const scheduleChanged = SCHEDULE_FIELDS.some((f) => f in updateData);
    const reactivated = updateData.active === true && !plan.active;
    if (scheduleChanged || reactivated) {
      updateData.nextDueAt = computeNextDueAt({ ...plan, ...updateData });
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (Array.isArray(tasks)) {
        await tx.mtPlanTask.deleteMany({ where: { planId: plan.id } });
        if (tasks.length > 0) {
          await tx.mtPlanTask.createMany({ data: taskRows(tasks).map((t) => ({ ...t, planId: plan.id })) });
        }
      }
      return tx.mtPlan.update({ where: { id: plan.id }, data: updateData, include: planDetailInclude });
    });

    return res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: zodMessage(err) });
    logger.error("[plans PATCH]", err);
    return res.status(500).json({ error: "Error updating plan" });
  }
});

async function setActive(req, res, active) {
  try {
    if (!isManager(req.user)) {
      return res.status(403).json({ error: `Only ADMIN/SUPERVISOR can ${active ? "resume" : "pause"} plans` });
    }
    const plan = await loadPlanOr404(req, res);
    if (!plan) return;

    const data = { active };
    // Al reanudar, la programación arranca desde hoy (no se generan los ciclos de la pausa)
    if (active && !plan.active) data.nextDueAt = computeNextDueAt({ ...plan, active: true });

    const updated = await prisma.mtPlan.update({ where: { id: plan.id }, data });
    return res.json({ message: active ? "Plan resumed" : "Plan paused", plan: updated });
  } catch (err) {
    logger.error(`[plans/:id/${active ? "resume" : "pause"} POST]`, err);
    return res.status(500).json({ error: `Error ${active ? "resuming" : "pausing"} plan` });
  }
}

router.post("/:id/pause", (req, res) => setActive(req, res, false));
router.post("/:id/resume", (req, res) => setActive(req, res, true));

router.delete("/:id", async (req, res) => {
  try {
    if (!isManager(req.user)) {
      return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can delete plans" });
    }
    const plan = await loadPlanOr404(req, res);
    if (!plan) return;

    const deleted = await prisma.mtPlan.update({
      where: { id: plan.id },
      data: { deletedAt: new Date(), active: false },
      select: { id: true, code: true, deletedAt: true },
    });
    return res.json({ message: "Plan deleted", plan: deleted });
  } catch (err) {
    logger.error("[plans DELETE]", err);
    return res.status(500).json({ error: "Error deleting plan" });
  }
});

router.get("/:id/history", async (req, res) => {
  try {
    const plan = await loadPlanOr404(req, res);
    if (!plan) return;

    const [workOrders, runs] = await Promise.all([
      prisma.mtWorkOrder.findMany({
        where: { planId: plan.id, plantId: req.currentPlantId },
        select: { id: true, number: true, cycleKey: true, status: true, dueAt: true, finishedAt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.mtPlanRun.findMany({
        where: { planId: plan.id, plantId: req.currentPlantId },
        orderBy: { runAt: "desc" },
        take: 50,
      }),
    ]);

    const total = workOrders.length;
    const completed = workOrders.filter((w) => ["FINISHED", "VALIDATED"].includes(w.status)).length;
    const onTime = workOrders.filter((w) => w.finishedAt && w.dueAt && new Date(w.finishedAt) <= new Date(w.dueAt)).length;

    return res.json({
      plan: { id: plan.id, code: plan.code, nextDueAt: plan.nextDueAt },
      summary: {
        total,
        completed,
        onTime,
        compliancePercent: total > 0 ? Number(((onTime / total) * 100).toFixed(1)) : null,
      },
      workOrders,
      runs,
    });
  } catch (err) {
    logger.error("[plans/:id/history GET]", err);
    return res.status(500).json({ error: "Error fetching plan history" });
  }
});

router.get("/:id/roadmap", async (req, res) => {
  try {
    const plan = await loadPlanOr404(req, res);
    if (!plan) return;
    return res.json(await getPlanRoadmap(plan.id, req.currentPlantId));
  } catch (err) {
    logger.error("[plans/:id/roadmap GET]", err);
    return res.status(500).json({ error: "Error fetching plan roadmap" });
  }
});

// POST /:id/execute — genera ahora una OT a partir del plan (no altera su programación)
router.post("/:id/execute", async (req, res) => {
  try {
    if (!isManager(req.user)) {
      return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can generate work orders from plans" });
    }
    const plan = await loadPlanOr404(req, res);
    if (!plan) return;

    const result = await executePlan(plan.id, req.currentPlantId, req.user.id, req.body);
    return res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error("[plans/:id/execute POST]", err);
    return res.status(500).json({ error: "Error executing plan" });
  }
});

// ---- Técnicos y refacciones del plan (siempre verificando que todo sea de la planta) ----

router.post("/:id/technicians", async (req, res) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can edit plans" });
    const plan = await loadPlanOr404(req, res);
    if (!plan) return;

    const technicianId = parseId(req.body.technicianId);
    const role = ["EXECUTOR", "REVIEWER", "INSPECTOR"].includes(req.body.role) ? req.body.role : "EXECUTOR";
    if (!technicianId) return res.status(400).json({ error: "technicianId is required" });

    const technician = await prisma.technician.findFirst({
      where: { id: technicianId, plantId: req.currentPlantId, deletedAt: null },
      select: { id: true },
    });
    if (!technician) return res.status(404).json({ error: "Technician not found" });

    const assignment = await prisma.mtPlanTechnician.upsert({
      where: { planId_technicianId: { planId: plan.id, technicianId } },
      create: { planId: plan.id, technicianId, role },
      update: { role },
      include: { technician: { select: { id: true, name: true, code: true } } },
    });
    return res.status(201).json(assignment);
  } catch (err) {
    logger.error("[plans/:id/technicians POST]", err);
    return res.status(500).json({ error: "Error assigning technician" });
  }
});

router.delete("/:id/technicians/:technicianId", async (req, res) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can edit plans" });
    const plan = await loadPlanOr404(req, res);
    if (!plan) return;

    const technicianId = parseId(req.params.technicianId);
    const { count } = await prisma.mtPlanTechnician.deleteMany({ where: { planId: plan.id, technicianId: technicianId ?? -1 } });
    if (count === 0) return res.status(404).json({ error: "Technician not assigned to this plan" });
    return res.json({ message: "Technician removed" });
  } catch (err) {
    logger.error("[plans/:id/technicians/:technicianId DELETE]", err);
    return res.status(500).json({ error: "Error removing technician" });
  }
});

router.post("/:id/spareparts", async (req, res) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can edit plans" });
    const plan = await loadPlanOr404(req, res);
    if (!plan) return;

    const sparePartId = parseId(req.body.sparePartId);
    const quantityRequired = Number(req.body.quantityRequired ?? 1);
    if (!sparePartId) return res.status(400).json({ error: "sparePartId is required" });
    if (!Number.isFinite(quantityRequired) || quantityRequired <= 0) {
      return res.status(400).json({ error: "quantityRequired must be greater than 0" });
    }

    const sparePart = await prisma.mtSparePart.findFirst({
      where: { id: sparePartId, plantId: req.currentPlantId },
      select: { id: true },
    });
    if (!sparePart) return res.status(404).json({ error: "Spare part not found" });

    const assignment = await prisma.mtPlanSparePart.upsert({
      where: { planId_sparePartId: { planId: plan.id, sparePartId } },
      create: { planId: plan.id, sparePartId, quantityRequired },
      update: { quantityRequired },
      include: { sparePart: { select: { id: true, code: true, name: true } } },
    });
    return res.status(201).json(assignment);
  } catch (err) {
    logger.error("[plans/:id/spareparts POST]", err);
    return res.status(500).json({ error: "Error assigning spare part" });
  }
});

router.delete("/:id/spareparts/:sparePartId", async (req, res) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can edit plans" });
    const plan = await loadPlanOr404(req, res);
    if (!plan) return;

    const sparePartId = parseId(req.params.sparePartId);
    const { count } = await prisma.mtPlanSparePart.deleteMany({ where: { planId: plan.id, sparePartId: sparePartId ?? -1 } });
    if (count === 0) return res.status(404).json({ error: "Spare part not assigned to this plan" });
    return res.json({ message: "Spare part removed" });
  } catch (err) {
    logger.error("[plans/:id/spareparts/:sparePartId DELETE]", err);
    return res.status(500).json({ error: "Error removing spare part" });
  }
});

export default router;
