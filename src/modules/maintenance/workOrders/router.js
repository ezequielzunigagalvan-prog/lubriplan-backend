import express from "express";
import { z } from "zod";
import multer from "multer";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { onPlanWorkOrderFinished } from "../plans/schedule.js";
import { notifyCriticalFailure, notifyAssignment } from "../notifications/service.js";
import { startOfLocalDay } from "../scheduler/dates.js";
import { uploadBufferToCloudinary, destroyCloudinaryImage } from "../../../lib/cloudinary.js";
import {
  STATES,
  CLOSED_STATES,
  canTransition,
  availableTransitions,
  getRequiredFieldsForTransition,
  isAssignedTechnician,
  isManager,
} from "./stateMachine.js";
import { getNextWorkOrderNumber, formatWorkOrderNumber } from "../utils/numeracion.js";

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

const STATUS_VALUES = Object.values(STATES);
const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const PHOTO_KINDS = ["BEFORE", "AFTER", "OTHER"];
const EXECUTION_STATES = [STATES.IN_PROGRESS, STATES.WAITING_PARTS, STATES.WAITING_PRODUCTION];

const optionalText = (max) => z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().trim().max(max).optional());

const createWOSchema = z.object({
  type: z.enum(["CORRECTIVE", "PREVENTIVE", "INSPECTION"]),
  assetId: z.coerce.number().int().positive().optional(),
  title: z.string().trim().min(1, "El título es requerido").max(200),
  description: optionalText(5000),
  priority: z.enum(PRIORITIES).default("MEDIUM"),
  autoApprove: z.boolean().default(false),
});

const reportFailureSchema = z.object({
  assetId: z.coerce.number().int().positive(),
  title: z.string().trim().min(1, "El título es requerido").max(200),
  description: optionalText(5000),
  severity: z.enum(PRIORITIES).default("HIGH"),
});

const transitionSchema = z.object({
  to: z.enum(STATUS_VALUES),
  comment: optionalText(2000),
  assignedTo: z.coerce.number().int().positive().optional(),
  priority: z.enum(PRIORITIES).optional(),
  scheduledAt: z.preprocess((v) => (v === "" ? undefined : v), z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Fecha inválida").optional()),
  workDone: optionalText(10000),
  diagnosis: optionalText(10000),
  failureCause: optionalText(10000),
  downtimeMinutes: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().nonnegative().optional()),
  expectedVersion: z.coerce.number().int().optional(),
});

const executionSchema = z.object({
  diagnosis: optionalText(10000),
  failureCause: optionalText(10000),
  workDone: optionalText(10000),
  downtimeMinutes: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().nonnegative().optional()),
  expectedVersion: z.coerce.number().int().optional(),
});

const failureSchema = z.object({
  failureModeId: z.coerce.number().int().positive().nullable().optional(),
  mechanismId: z.coerce.number().int().positive().nullable().optional(),
  rootCauseId: z.coerce.number().int().positive().nullable().optional(),
  productionEffect: z.enum(["TOTAL_STOP", "PARTIAL_STOP", "NO_EFFECT"]).nullable().optional(),
});

const taskUpdateSchema = z.object({
  result: z.enum(["OK", "NOT_OK", "NA"]).nullable().optional(),
  valueNumber: z.preprocess((v) => (v === "" ? null : v), z.coerce.number().nullable().optional()),
  valueText: z.string().max(2000).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

/** "YYYY-MM-DD" -> medianoche de ese día en la zona de la planta (no UTC); ISO completo se respeta. */
function parseLocalDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return startOfLocalDay(new Date(`${value}T12:00:00.000Z`));
  return new Date(value);
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function zodMessage(err) {
  return err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

/** Nombres de usuarios (requestedBy, validatedBy, eventos) y técnicos (assignedTo). */
async function resolveNames(plantId, { userIds = [], technicianIds = [] }) {
  const uIds = [...new Set(userIds.filter(Boolean))];
  const tIds = [...new Set(technicianIds.filter(Boolean))];
  const [users, technicians] = await Promise.all([
    uIds.length ? prisma.user.findMany({ where: { id: { in: uIds } }, select: { id: true, name: true } }) : [],
    tIds.length
      ? prisma.technician.findMany({ where: { id: { in: tIds }, plantId }, select: { id: true, name: true, code: true, specialty: true } })
      : [],
  ]);
  return {
    user: new Map(users.map((u) => [u.id, { id: u.id, name: u.name }])),
    technician: new Map(technicians.map((t) => [t.id, t])),
  };
}

async function findWorkOrder(req, res) {
  const woId = parseId(req.params.id);
  if (!woId) {
    res.status(400).json({ error: "Invalid work order id" });
    return null;
  }
  const wo = await prisma.mtWorkOrder.findFirst({ where: { id: woId, plantId: req.currentPlantId } });
  if (!wo) {
    res.status(404).json({ error: "Work order not found" });
    return null;
  }
  return wo;
}

// GET /api/maintenance/work-orders?status=A,B&type=&priority=&assetId=&assignedTo=&mine=1&search=&page=&limit=
router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { status, priority, type, assetId, assignedTo, mine, search, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const where = { plantId };
    const statuses = String(status || "").split(",").filter((s) => STATUS_VALUES.includes(s));
    if (statuses.length === 1) where.status = statuses[0];
    else if (statuses.length > 1) where.status = { in: statuses };
    if (PRIORITIES.includes(priority)) where.priority = priority;
    if (["CORRECTIVE", "PREVENTIVE", "INSPECTION"].includes(type)) where.type = type;
    if (assetId) where.assetId = parseId(assetId) ?? -1;

    const and = [];
    if (mine === "1" || mine === "true") {
      const or = [{ requestedBy: req.user.id }];
      if (req.user.technicianId) or.push({ assignedTo: req.user.technicianId });
      and.push({ OR: or });
    } else if (assignedTo) {
      where.assignedTo = parseId(assignedTo) ?? -1;
    }
    if (search?.trim()) {
      const term = search.trim();
      const number = Number.parseInt(term.replace(/^OT-?/i, ""), 10);
      const or = [
        { title: { contains: term, mode: "insensitive" } },
        { asset: { is: { OR: [{ code: { contains: term, mode: "insensitive" } }, { name: { contains: term, mode: "insensitive" } }] } } },
      ];
      if (Number.isInteger(number)) or.push({ number });
      and.push({ OR: or });
    }
    if (and.length) where.AND = and;

    const [workOrders, total, byStatus] = await Promise.all([
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
          asset: { select: { id: true, code: true, name: true, location: true } },
          planId: true,
          assignedTo: true,
          requestedBy: true,
          scheduledAt: true,
          dueAt: true,
          startedAt: true,
          finishedAt: true,
          createdAt: true,
          version: true,
        },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        orderBy: { createdAt: "desc" },
      }),
      prisma.mtWorkOrder.count({ where }),
      prisma.mtWorkOrder.groupBy({ by: ["status"], where: { plantId }, _count: { _all: true } }),
    ]);

    const names = await resolveNames(plantId, {
      userIds: workOrders.map((w) => w.requestedBy),
      technicianIds: workOrders.map((w) => w.assignedTo),
    });

    return res.json({
      data: workOrders.map((w) => ({
        ...w,
        requester: names.user.get(w.requestedBy) || null,
        assignee: w.assignedTo ? names.technician.get(w.assignedTo) || null : null,
      })),
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      countsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    });
  } catch (err) {
    logger.error("[workOrders GET]", err);
    return res.status(500).json({ error: "Error fetching work orders" });
  }
});

const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

// GET /api/maintenance/work-orders/technician-dashboard[?technicianId=]
// Tablero del técnico: sus órdenes abiertas, lo terminado recientemente y sus indicadores.
// Un técnico ve el suyo; supervisores/admin pueden elegir qué técnico ver.
router.get("/technician-dashboard", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const requested = parseId(req.query.technicianId);
    let technicianId = req.user.technicianId ?? null;
    if (requested && requested !== technicianId) {
      if (!isManager(req.user)) return res.status(403).json({ error: "Only supervisors can view other technicians" });
      technicianId = requested;
    }

    const technicians = isManager(req.user)
      ? await prisma.technician.findMany({
          where: { plantId, deletedAt: null },
          select: { id: true, name: true, specialty: true },
          orderBy: { name: "asc" },
        })
      : [];

    if (!technicianId) {
      return res.json({ data: { technician: null, technicians, openOrders: [], recentCompleted: [], stats: null } });
    }

    const technician = await prisma.technician.findFirst({
      where: { id: technicianId, plantId, deletedAt: null },
      select: { id: true, name: true, code: true, specialty: true, phone: true, email: true, status: true },
    });
    if (!technician) return res.status(404).json({ error: "Technician not found" });

    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const select = {
      id: true, number: true, type: true, status: true, priority: true, title: true,
      scheduledAt: true, dueAt: true, startedAt: true, finishedAt: true, createdAt: true, downtimeMinutes: true,
      asset: { select: { id: true, code: true, name: true, location: true } },
      _count: { select: { tasks: true } },
    };

    const [open, completed] = await Promise.all([
      prisma.mtWorkOrder.findMany({
        where: { plantId, assignedTo: technicianId, status: { in: [STATES.ASSIGNED, ...EXECUTION_STATES] } },
        select,
      }),
      prisma.mtWorkOrder.findMany({
        where: { plantId, assignedTo: technicianId, status: { in: [STATES.FINISHED, STATES.VALIDATED] }, finishedAt: { gte: since30 } },
        select,
        orderBy: { finishedAt: "desc" },
      }),
    ]);

    // Primero lo que ya está en curso, luego por prioridad y por fecha compromiso
    const statusRank = (s) => (s === STATES.IN_PROGRESS ? 0 : s.startsWith("WAITING") ? 1 : 2);
    const dueOf = (w) => new Date(w.dueAt || w.scheduledAt || w.createdAt).getTime();
    open.sort((a, b) => statusRank(a.status) - statusRank(b.status) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || dueOf(a) - dueOf(b));

    const hoursOf = (w) => (w.startedAt && w.finishedAt ? Math.max(0, (w.finishedAt - w.startedAt) / 3600000) : 0);
    const round1 = (n) => Number(n.toFixed(1));
    const withHours = (w) => ({ ...w, hours: round1(hoursOf(w)) });

    return res.json({
      data: {
        technician,
        technicians,
        openOrders: open.map((w) => ({ ...w, overdue: Boolean((w.dueAt || w.scheduledAt) && dueOf(w) < startOfToday.getTime()) })),
        recentCompleted: completed.slice(0, 10).map(withHours),
        stats: {
          assigned: open.filter((w) => w.status === STATES.ASSIGNED).length,
          inProgress: open.filter((w) => w.status === STATES.IN_PROGRESS).length,
          waiting: open.filter((w) => w.status.startsWith("WAITING")).length,
          overdue: open.filter((w) => (w.dueAt || w.scheduledAt) && dueOf(w) < startOfToday.getTime()).length,
          completed30d: completed.length,
          hoursToday: round1(completed.filter((w) => w.finishedAt >= startOfToday).reduce((s, w) => s + hoursOf(w), 0)),
          hours30d: round1(completed.reduce((s, w) => s + hoursOf(w), 0)),
        },
      },
    });
  } catch (err) {
    logger.error("[workOrders/technician-dashboard GET]", err);
    return res.status(500).json({ error: "Error fetching technician dashboard" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const woId = parseId(req.params.id);
    if (!woId) return res.status(400).json({ error: "Invalid work order id" });

    const wo = await prisma.mtWorkOrder.findFirst({
      where: { id: woId, plantId },
      include: {
        asset: { select: { id: true, code: true, name: true, location: true, criticality: true, status: true } },
        tasks: { orderBy: { position: "asc" } },
        parts: {
          orderBy: { createdAt: "asc" },
          include: { sparePart: { select: { id: true, code: true, name: true, unit: true } } },
        },
        failure: true,
        events: { orderBy: { createdAt: "asc" } },
        photos: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!wo) return res.status(404).json({ error: "Work order not found" });

    const plan = wo.planId
      ? await prisma.mtPlan.findFirst({ where: { id: wo.planId, plantId }, select: { id: true, code: true, title: true } })
      : null;

    // Códigos de falla (la relación no está declarada en el esquema: se resuelven por id)
    const codeIds = wo.failure ? [wo.failure.failureModeId, wo.failure.mechanismId, wo.failure.rootCauseId].filter(Boolean) : [];
    const codes = codeIds.length
      ? await prisma.mtFailureCode.findMany({ where: { id: { in: codeIds }, plantId }, select: { id: true, code: true, name: true } })
      : [];
    const codeOf = (id) => codes.find((c) => c.id === id) || null;

    const names = await resolveNames(plantId, {
      userIds: [wo.requestedBy, wo.validatedBy, ...wo.events.map((e) => e.userId)],
      technicianIds: [wo.assignedTo],
    });

    const { events, ...workOrder } = wo;
    const isAssigned = isAssignedTechnician(wo, req.user);
    const canExecute = EXECUTION_STATES.includes(wo.status) && (isAssigned || isManager(req.user));

    return res.json({
      workOrder: {
        ...workOrder,
        numberFormatted: formatWorkOrderNumber(wo.number),
        plan,
        requester: names.user.get(wo.requestedBy) || null,
        assignee: wo.assignedTo ? names.technician.get(wo.assignedTo) || null : null,
        validator: wo.validatedBy ? names.user.get(wo.validatedBy) || null : null,
        failure: wo.failure
          ? {
              ...wo.failure,
              failureMode: codeOf(wo.failure.failureModeId),
              mechanism: codeOf(wo.failure.mechanismId),
              rootCause: codeOf(wo.failure.rootCauseId),
            }
          : null,
        partsCost: wo.parts.reduce((s, p) => s + Number(p.quantity) * Number(p.costPerUnitAtTime), 0),
      },
      events: events.map((e) => ({ ...e, user: names.user.get(e.userId) || null })),
      photos: wo.photos,
      permissions: {
        isAssigned,
        isManager: isManager(req.user),
        availableTransitions: availableTransitions(wo, req.user),
        canExecute,
        canEditFailure: !CLOSED_STATES.includes(wo.status) || (wo.status === STATES.FINISHED && isManager(req.user)),
      },
    });
  } catch (err) {
    logger.error("[workOrders/:id GET]", err);
    return res.status(500).json({ error: "Error fetching work order" });
  }
});

async function createWorkOrder({ plantId, user, data, comment }) {
  let asset = null;
  if (data.assetId) {
    asset = await prisma.mtAsset.findFirst({ where: { id: data.assetId, plantId, deletedAt: null }, select: { id: true, code: true, name: true } });
    if (!asset) throw Object.assign(new Error("Asset not found"), { status: 404 });
  }

  const created = await prisma.$transaction(async (tx) => {
    const number = await getNextWorkOrderNumber(plantId, tx);
    const wo = await tx.mtWorkOrder.create({
      data: { plantId, number, requestedBy: user.id, ...data },
      select: { id: true, number: true, status: true, createdAt: true, version: true },
    });
    await tx.mtWorkOrderEvent.create({
      data: { workOrderId: wo.id, plantId, toStatus: wo.status, userId: user.id, comment },
    });
    return wo;
  });

  // Falla crítica: aviso inmediato a supervisores (fuera de la transacción; si falla no afecta la OT)
  await notifyCriticalFailure(plantId, {
    ...created,
    type: data.type,
    priority: data.priority,
    title: data.title,
    assetName: asset ? `${asset.code} · ${asset.name}` : null,
  });
  return created;
}

router.post("/", async (req, res) => {
  try {
    const parsed = createWOSchema.parse(req.body);
    const autoApproved = parsed.autoApprove && isManager(req.user);

    const wo = await createWorkOrder({
      plantId: req.currentPlantId,
      user: req.user,
      data: {
        type: parsed.type,
        assetId: parsed.assetId ?? null,
        title: parsed.title,
        description: parsed.description ?? null,
        priority: parsed.priority,
        status: autoApproved ? STATES.APPROVED : STATES.REQUESTED,
      },
      comment: autoApproved ? "Creada y aprobada por el solicitante" : "Orden creada",
    });

    return res.status(201).json({ ...wo, numberFormatted: formatWorkOrderNumber(wo.number) });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: zodMessage(err) });
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error("[workOrders POST]", err);
    return res.status(500).json({ error: "Error creating work order" });
  }
});

router.post("/report-failure", async (req, res) => {
  try {
    const parsed = reportFailureSchema.parse(req.body);
    const wo = await createWorkOrder({
      plantId: req.currentPlantId,
      user: req.user,
      data: {
        type: "CORRECTIVE",
        priority: parsed.severity,
        assetId: parsed.assetId,
        title: parsed.title,
        description: parsed.description ?? null,
        status: STATES.REQUESTED,
      },
      comment: "Falla reportada",
    });

    return res.status(201).json({ ...wo, numberFormatted: formatWorkOrderNumber(wo.number), message: "Falla reportada exitosamente" });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: zodMessage(err) });
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error("[workOrders/report-failure POST]", err);
    return res.status(500).json({ error: "Error reporting failure" });
  }
});

router.post("/:id/transition", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const parsed = transitionSchema.parse(req.body);

    const wo = await findWorkOrder(req, res);
    if (!wo) return;

    const transition = canTransition(wo, parsed.to, req.user);
    if (!transition.allowed) {
      return res.status(403).json({ error: transition.reason });
    }

    const required = getRequiredFieldsForTransition(wo.status, parsed.to);
    for (const [field, msg] of Object.entries(required)) {
      if (parsed[field] === undefined) return res.status(400).json({ error: msg });
    }

    const updateData = { status: parsed.to, version: { increment: 1 } };
    const metadata = {};

    if (parsed.to === STATES.ASSIGNED) {
      const technician = await prisma.technician.findFirst({
        where: { id: parsed.assignedTo, plantId, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!technician) return res.status(404).json({ error: "Technician not found" });
      updateData.assignedTo = technician.id;
      metadata.assignedTo = technician.id;
      metadata.assignedToName = technician.name;
      if (parsed.scheduledAt) updateData.scheduledAt = parseLocalDate(parsed.scheduledAt);
    }

    if (parsed.to === STATES.IN_PROGRESS && !wo.startedAt) {
      updateData.startedAt = new Date();
    }

    if (parsed.to === STATES.FINISHED) {
      // Las tareas obligatorias del checklist deben tener resultado
      const pending = await prisma.mtWorkOrderTask.count({ where: { workOrderId: wo.id, required: true, result: null } });
      if (pending > 0) {
        return res.status(400).json({ error: `Faltan ${pending} tarea(s) obligatoria(s) del checklist por completar` });
      }
      updateData.finishedAt = new Date();
      updateData.workDone = parsed.workDone;
      if (parsed.diagnosis !== undefined) updateData.diagnosis = parsed.diagnosis;
      if (parsed.failureCause !== undefined) updateData.failureCause = parsed.failureCause;
      if (parsed.downtimeMinutes !== undefined) updateData.downtimeMinutes = parsed.downtimeMinutes;
    }

    if (wo.status === STATES.FINISHED && parsed.to === STATES.IN_PROGRESS) {
      updateData.finishedAt = null; // reabierta
    }

    if (parsed.to === STATES.VALIDATED) {
      updateData.validatedAt = new Date();
      updateData.validatedBy = req.user.id;
    }

    if (parsed.priority) updateData.priority = parsed.priority;

    const where = { id: wo.id, plantId };
    // Control de concurrencia optimista: si el cliente manda la versión, debe coincidir
    if (parsed.expectedVersion !== undefined) where.version = parsed.expectedVersion;

    const updatedWO = await prisma.$transaction(async (tx) => {
      const updated = await tx.mtWorkOrder.updateMany({ where, data: updateData });
      if (updated.count === 0) return null;

      await tx.mtWorkOrderEvent.create({
        data: {
          workOrderId: wo.id,
          plantId,
          fromStatus: wo.status,
          toStatus: parsed.to,
          userId: req.user.id,
          comment: parsed.comment,
          metadata: Object.keys(metadata).length ? metadata : undefined,
        },
      });

      if (parsed.to === STATES.FINISHED && wo.planId) {
        // Registra la realización y, en planes FLOATING, reprograma desde la fecha real de término
        await onPlanWorkOrderFinished(wo.planId, updateData.finishedAt, tx);
      }

      return tx.mtWorkOrder.findUnique({ where: { id: wo.id } });
    });

    if (!updatedWO) {
      return res.status(409).json({ error: "La orden fue modificada por alguien más. Recarga e intenta de nuevo." });
    }
    if (parsed.to === STATES.ASSIGNED) {
      await notifyAssignment(plantId, updatedWO, updatedWO.assignedTo);
    }
    return res.json(updatedWO);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: zodMessage(err) });
    logger.error("[workOrders/:id/transition POST]", err);
    return res.status(500).json({ error: "Error transitioning work order" });
  }
});

// Guarda avances de ejecución (diagnóstico, trabajo realizado, paro) sin cambiar el estado
router.patch("/:id/execution", async (req, res) => {
  try {
    const parsed = executionSchema.parse(req.body);
    const wo = await findWorkOrder(req, res);
    if (!wo) return;

    if (!isAssignedTechnician(wo, req.user) && !isManager(req.user)) {
      return res.status(403).json({ error: "Only the assigned technician or a supervisor can update execution" });
    }
    if (!EXECUTION_STATES.includes(wo.status)) {
      return res.status(409).json({ error: `Cannot update execution in ${wo.status} status` });
    }

    const updateData = {};
    for (const field of ["diagnosis", "failureCause", "workDone", "downtimeMinutes"]) {
      if (parsed[field] !== undefined) updateData[field] = parsed[field];
    }

    const where = { id: wo.id, plantId: req.currentPlantId };
    if (parsed.expectedVersion !== undefined) where.version = parsed.expectedVersion;

    const updated = await prisma.mtWorkOrder.updateMany({ where, data: { ...updateData, version: { increment: 1 } } });
    if (updated.count === 0) {
      return res.status(409).json({ error: "La orden fue modificada por alguien más. Recarga e intenta de nuevo." });
    }

    return res.json(await prisma.mtWorkOrder.findUnique({ where: { id: wo.id } }));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: zodMessage(err) });
    logger.error("[workOrders/:id/execution PATCH]", err);
    return res.status(500).json({ error: "Error updating execution" });
  }
});

// PUT /:id/failure — clasificación de la falla (ISO 14224: modo, mecanismo, causa raíz)
router.put("/:id/failure", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const parsed = failureSchema.parse(req.body);
    const wo = await findWorkOrder(req, res);
    if (!wo) return;

    if (!wo.assetId) return res.status(400).json({ error: "La orden no tiene activo: no se puede clasificar la falla" });
    if (TERMINAL_OR_LOCKED(wo, req.user)) {
      return res.status(409).json({ error: `No se puede modificar la falla en estado ${wo.status}` });
    }

    const expected = { failureModeId: "FAILURE_MODE", mechanismId: "MECHANISM", rootCauseId: "ROOT_CAUSE" };
    for (const [field, category] of Object.entries(expected)) {
      if (!parsed[field]) continue;
      const code = await prisma.mtFailureCode.findFirst({ where: { id: parsed[field], plantId, category }, select: { id: true } });
      if (!code) return res.status(400).json({ error: `${field}: el código no existe o no es de tipo ${category}` });
    }

    const data = {
      failureModeId: parsed.failureModeId ?? null,
      mechanismId: parsed.mechanismId ?? null,
      rootCauseId: parsed.rootCauseId ?? null,
      productionEffect: parsed.productionEffect ?? null,
    };
    const failure = await prisma.mtWorkOrderFailure.upsert({
      where: { workOrderId: wo.id },
      create: { workOrderId: wo.id, assetId: wo.assetId, ...data },
      update: data,
    });
    return res.json(failure);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: zodMessage(err) });
    logger.error("[workOrders/:id/failure PUT]", err);
    return res.status(500).json({ error: "Error saving failure" });
  }
});

/** La falla se puede editar mientras la OT está abierta; terminada, solo un supervisor. */
function TERMINAL_OR_LOCKED(wo, user) {
  if ([STATES.VALIDATED, STATES.REJECTED, STATES.CANCELLED].includes(wo.status)) return true;
  if (wo.status === STATES.FINISHED && !isManager(user)) return true;
  return false;
}

router.post("/:id/photos", upload.single("image"), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const kind = PHOTO_KINDS.includes(String(req.body.kind || "").toUpperCase()) ? String(req.body.kind).toUpperCase() : "OTHER";

    if (!req.file?.buffer) {
      return res.status(400).json({ error: "No image provided" });
    }

    const wo = await findWorkOrder(req, res);
    if (!wo) return;

    const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
      folder: `maintenance/${plantId}`,
      publicId: `wo_${wo.id}_${kind}_${Date.now()}`,
    });

    const photo = await prisma.mtWorkOrderPhoto.create({
      data: {
        workOrderId: wo.id,
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

router.delete("/:id/photos/:photoId", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const woId = parseId(req.params.id);
    const photoId = parseId(req.params.photoId);

    const photo = await prisma.mtWorkOrderPhoto.findFirst({
      where: { id: photoId ?? -1, workOrderId: woId ?? -1, plantId },
    });
    if (!photo) return res.status(404).json({ error: "Photo not found" });

    if (photo.uploadedBy !== req.user.id && !isManager(req.user)) {
      return res.status(403).json({ error: "Only the uploader or a supervisor can delete this photo" });
    }

    await destroyCloudinaryImage(photo.publicId);
    await prisma.mtWorkOrderPhoto.delete({ where: { id: photo.id } });

    return res.json({ message: "Photo deleted" });
  } catch (err) {
    logger.error("[workOrders/:id/photos/:photoId DELETE]", err);
    return res.status(500).json({ error: "Error deleting photo" });
  }
});

router.patch("/:id/tasks/:taskId", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const parsed = taskUpdateSchema.parse(req.body);
    const wo = await findWorkOrder(req, res);
    if (!wo) return;

    if (!EXECUTION_STATES.includes(wo.status)) {
      return res.status(409).json({ error: "Las tareas solo se registran con la orden en ejecución" });
    }
    if (!isAssignedTechnician(wo, req.user) && !isManager(req.user)) {
      return res.status(403).json({ error: "Only the assigned technician or a supervisor can update task results" });
    }

    const task = await prisma.mtWorkOrderTask.findFirst({
      where: { id: parseId(req.params.taskId) ?? -1, workOrderId: wo.id, plantId },
    });
    if (!task) return res.status(404).json({ error: "Task not found" });

    const updateData = {};
    if (parsed.valueNumber !== undefined) updateData.valueNumber = parsed.valueNumber;
    if (parsed.valueText !== undefined) updateData.valueText = parsed.valueText;
    if (parsed.note !== undefined) updateData.note = parsed.note;

    if (parsed.result !== undefined) {
      updateData.result = parsed.result;
    } else if (task.kind === "MEASURE" && Number.isFinite(parsed.valueNumber)) {
      // Mediciones: el resultado se calcula contra los límites de la tarea
      const outOfRange =
        (task.minValue != null && parsed.valueNumber < task.minValue) ||
        (task.maxValue != null && parsed.valueNumber > task.maxValue);
      updateData.result = outOfRange ? "NOT_OK" : "OK";
    } else if (task.kind === "TEXT" && parsed.valueText?.trim()) {
      updateData.result = "OK";
    }

    if (updateData.result === null) {
      updateData.doneAt = null;
      updateData.doneBy = null;
    } else if (updateData.result) {
      updateData.doneAt = new Date();
      updateData.doneBy = req.user.id;
    }

    const updated = await prisma.mtWorkOrderTask.update({ where: { id: task.id }, data: updateData });
    return res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: zodMessage(err) });
    logger.error("[workOrders/:id/tasks/:taskId PATCH]", err);
    return res.status(500).json({ error: "Error updating task" });
  }
});

export default router;
