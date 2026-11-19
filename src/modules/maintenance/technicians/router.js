import express from "express";
import { z } from "zod";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

const router = express.Router();

// Nota: Technician y User.technicianId son compartidos con LubriPlan. El vínculo usuario↔técnico
// sigue las mismas reglas que LubriPlan (/admin/users/:id/link-technician): solo ADMIN,
// solo usuarios con rol TECHNICIAN, un técnico por usuario.

const STATUSES = ["Activo", "Inactivo"];
const OPEN = ["APPROVED", "ASSIGNED", "IN_PROGRESS", "WAITING_PARTS", "WAITING_PRODUCTION"];
const DONE = ["FINISHED", "VALIDATED"];
const DAY = 24 * 60 * 60 * 1000;

const isManager = (user) => ["ADMIN", "SUPERVISOR"].includes(user?.role);
const emptyToUndefined = (v) => (v === "" || v === null ? undefined : v);

const technicianFields = {
  name: z.string().trim().min(1, "El nombre es requerido").max(120),
  code: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  email: z.preprocess(emptyToUndefined, z.string().trim().email("Correo inválido").optional()),
  phone: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  // El frontend histórico manda "speciality"; la columna es "specialty"
  specialty: z.preprocess(emptyToUndefined, z.string().trim().max(60).optional()),
  speciality: z.preprocess(emptyToUndefined, z.string().trim().max(60).optional()),
  status: z.enum(STATUSES).optional(),
  certifications: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
};
const createSchema = z.object(technicianFields);
const updateSchema = z.object(technicianFields).partial();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function zodMessage(err) {
  return err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

function parseCertifications(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const serialize = (t) => ({ ...t, certifications: parseCertifications(t.certifications) });

/** Siguiente código libre TEC-001, TEC-002… de la planta. */
async function nextTechnicianCode(plantId) {
  const count = await prisma.technician.count({ where: { plantId } });
  for (let n = count + 1; n < count + 1000; n++) {
    const code = `TEC-${String(n).padStart(3, "0")}`;
    const taken = await prisma.technician.findFirst({ where: { plantId, code }, select: { id: true } });
    if (!taken) return code;
  }
  return `TEC-${Date.now()}`;
}

async function findTechnician(req, res) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid technician id" });
    return null;
  }
  const technician = await prisma.technician.findFirst({ where: { id, plantId: req.currentPlantId, deletedAt: null } });
  if (!technician) {
    res.status(404).json({ error: "Technician not found" });
    return null;
  }
  return technician;
}

// GET /technicians?search=&status=&page=&limit=
router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { search, status, page = 1, limit = 100 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

    const where = { plantId, deletedAt: null };
    if (STATUSES.includes(status)) where.status = status;
    if (search?.trim()) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { code: { contains: term, mode: "insensitive" } },
      ];
    }

    const [technicians, total] = await Promise.all([
      prisma.technician.findMany({
        where,
        select: {
          id: true, name: true, code: true, email: true, phone: true, specialty: true, status: true,
          certifications: true, createdAt: true,
          user: { select: { id: true, name: true, email: true } },
        },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        orderBy: { name: "asc" },
      }),
      prisma.technician.count({ where }),
    ]);

    const ids = technicians.map((t) => t.id);
    const openCounts = ids.length
      ? await prisma.mtWorkOrder.groupBy({ by: ["assignedTo"], where: { plantId, assignedTo: { in: ids }, status: { in: OPEN } }, _count: { _all: true } })
      : [];
    const openOf = new Map(openCounts.map((r) => [r.assignedTo, r._count._all]));

    return res.json({
      data: technicians.map((t) => ({ ...serialize(t), openOrders: openOf.get(t.id) || 0 })),
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    logger.error("[technicians GET]", err);
    return res.status(500).json({ error: "Error fetching technicians" });
  }
});

// GET /technicians/linkable-users — usuarios TECHNICIAN de la planta que se pueden vincular
router.get("/linkable-users", async (req, res) => {
  try {
    const memberships = await prisma.userPlant.findMany({
      where: { plantId: req.currentPlantId, active: true, user: { active: true, role: "TECHNICIAN" } },
      select: {
        user: { select: { id: true, name: true, email: true, technicianId: true, technician: { select: { id: true, name: true } } } },
      },
    });
    const users = memberships.map((m) => m.user).sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ data: users });
  } catch (err) {
    logger.error("[technicians/linkable-users GET]", err);
    return res.status(500).json({ error: "Error fetching users" });
  }
});

// GET /technicians/experience-matrix?days=365
// Experiencia real por técnico y equipo: OTs terminadas y horas trabajadas en el periodo.
router.get("/experience-matrix", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const days = Math.min(1825, Math.max(30, parseInt(req.query.days, 10) || 365));
    const since = new Date(Date.now() - days * DAY);

    const [technicians, orders] = await Promise.all([
      prisma.technician.findMany({
        where: { plantId, deletedAt: null, status: "Activo" },
        select: { id: true, name: true, code: true, specialty: true, certifications: true },
        orderBy: { name: "asc" },
      }),
      prisma.mtWorkOrder.findMany({
        where: { plantId, status: { in: DONE }, finishedAt: { gte: since }, assignedTo: { not: null } },
        select: { assignedTo: true, type: true, startedAt: true, finishedAt: true, asset: { select: { id: true, code: true, name: true } } },
      }),
    ]);

    const assets = new Map();
    const cells = new Map(); // `${techId}|${assetId}` -> { orders, corrective, preventive, hours }
    for (const wo of orders) {
      const assetId = wo.asset?.id ?? 0;
      if (!assets.has(assetId)) assets.set(assetId, wo.asset ? { id: wo.asset.id, code: wo.asset.code, name: wo.asset.name } : { id: 0, code: "—", name: "Sin activo" });
      const key = `${wo.assignedTo}|${assetId}`;
      const cell = cells.get(key) || { orders: 0, corrective: 0, preventive: 0, hours: 0 };
      cell.orders++;
      if (wo.type === "CORRECTIVE") cell.corrective++;
      else cell.preventive++;
      if (wo.startedAt && wo.finishedAt) cell.hours += Math.max(0, (wo.finishedAt - wo.startedAt) / 3600000);
      cells.set(key, cell);
    }

    const columns = [...assets.values()].sort((a, b) => a.code.localeCompare(b.code));
    const rows = technicians.map((t) => {
      const byAsset = Object.fromEntries(
        columns
          .map((a) => [a.id, cells.get(`${t.id}|${a.id}`)])
          .filter(([, c]) => c)
          .map(([id, c]) => [id, { ...c, hours: Number(c.hours.toFixed(1)) }])
      );
      const totals = Object.values(byAsset).reduce(
        (s, c) => ({ orders: s.orders + c.orders, corrective: s.corrective + c.corrective, preventive: s.preventive + c.preventive, hours: s.hours + c.hours }),
        { orders: 0, corrective: 0, preventive: 0, hours: 0 }
      );
      return { ...serialize(t), byAsset, totals: { ...totals, hours: Number(totals.hours.toFixed(1)) } };
    });

    return res.json({ data: { days, assets: columns, technicians: rows } });
  } catch (err) {
    logger.error("[technicians/experience-matrix GET]", err);
    return res.status(500).json({ error: "Error building experience matrix" });
  }
});

// GET /technicians/:id/profile — ficha, usuario vinculado, indicadores y órdenes recientes
router.get("/:id/profile", async (req, res) => {
  try {
    const technician = await findTechnician(req, res);
    if (!technician) return;
    const plantId = req.currentPlantId;
    const since30 = new Date(Date.now() - 30 * DAY);

    const [user, open, finished, recent, planLinks, defaultPlans] = await Promise.all([
      prisma.user.findFirst({ where: { technicianId: technician.id }, select: { id: true, name: true, email: true, role: true, active: true } }),
      prisma.mtWorkOrder.groupBy({ by: ["status"], where: { plantId, assignedTo: technician.id, status: { in: OPEN } }, _count: { _all: true } }),
      prisma.mtWorkOrder.findMany({
        where: { plantId, assignedTo: technician.id, status: { in: DONE } },
        select: { startedAt: true, finishedAt: true, dueAt: true, scheduledAt: true },
      }),
      prisma.mtWorkOrder.findMany({
        where: { plantId, assignedTo: technician.id },
        select: {
          id: true, number: true, title: true, type: true, status: true, priority: true, createdAt: true, finishedAt: true, startedAt: true,
          asset: { select: { id: true, code: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 15,
      }),
      prisma.mtPlanTechnician.findMany({
        where: { technicianId: technician.id, plan: { plantId, deletedAt: null } },
        select: { role: true, plan: { select: { id: true, code: true, title: true, active: true, nextDueAt: true } } },
      }),
      prisma.mtPlan.findMany({
        where: { plantId, deletedAt: null, defaultAssigneeId: technician.id },
        select: { id: true, code: true, title: true, active: true, nextDueAt: true },
      }),
    ]);

    const hoursOf = (w) => (w.startedAt && w.finishedAt ? Math.max(0, (w.finishedAt - w.startedAt) / 3600000) : 0);
    const finished30 = finished.filter((w) => w.finishedAt >= since30);
    const withDue = finished.filter((w) => w.dueAt || w.scheduledAt);
    const onTime = withDue.filter((w) => {
      const limit = new Date(w.dueAt || w.scheduledAt);
      limit.setHours(23, 59, 59, 999);
      return w.finishedAt <= limit;
    }).length;
    const openBy = Object.fromEntries(open.map((r) => [r.status, r._count._all]));

    const plans = new Map();
    for (const p of defaultPlans) plans.set(p.id, { ...p, role: "DEFAULT_ASSIGNEE" });
    for (const l of planLinks) if (!plans.has(l.plan.id)) plans.set(l.plan.id, { ...l.plan, role: l.role });

    return res.json({
      data: {
        technician: serialize(technician),
        user,
        stats: {
          openOrders: Object.values(openBy).reduce((a, b) => a + b, 0),
          inProgress: openBy.IN_PROGRESS || 0,
          completedTotal: finished.length,
          completed30d: finished30.length,
          hours30d: Number(finished30.reduce((s, w) => s + hoursOf(w), 0).toFixed(1)),
          onTimeRate: withDue.length ? Math.round((onTime / withDue.length) * 100) : null,
        },
        recentOrders: recent,
        plans: [...plans.values()],
      },
    });
  } catch (err) {
    logger.error("[technicians/:id/profile GET]", err);
    return res.status(500).json({ error: "Error fetching technician profile" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const technician = await findTechnician(req, res);
    if (!technician) return;
    return res.json(serialize(technician));
  } catch (err) {
    logger.error("[technicians/:id GET]", err);
    return res.status(500).json({ error: "Error fetching technician" });
  }
});

router.post("/", async (req, res) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can create technicians" });
    const plantId = req.currentPlantId;
    const parsed = createSchema.parse(req.body);

    const code = parsed.code || (await nextTechnicianCode(plantId));
    const technician = await prisma.technician.create({
      data: {
        plantId,
        name: parsed.name,
        code,
        email: parsed.email ?? null,
        phone: parsed.phone ?? null,
        specialty: parsed.specialty || parsed.speciality || "General",
        certifications: JSON.stringify(parsed.certifications || []),
        status: parsed.status || "Activo",
      },
    });

    return res.status(201).json(serialize(technician));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: zodMessage(err) });
    if (err.code === "P2002") return res.status(409).json({ error: "Ya existe un técnico con ese código en la planta" });
    logger.error("[technicians POST]", err);
    return res.status(500).json({ error: "Error creating technician" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can edit technicians" });
    const technician = await findTechnician(req, res);
    if (!technician) return;
    const parsed = updateSchema.parse(req.body);

    const data = {};
    if (parsed.name !== undefined) data.name = parsed.name;
    if (parsed.code !== undefined) data.code = parsed.code;
    if (parsed.status !== undefined) data.status = parsed.status;
    if (parsed.specialty !== undefined || parsed.speciality !== undefined) data.specialty = parsed.specialty || parsed.speciality;
    if (parsed.certifications !== undefined) data.certifications = JSON.stringify(parsed.certifications);
    // email/phone: "" o null los borra
    for (const field of ["email", "phone"]) {
      if (field in req.body) data[field] = parsed[field] ?? null;
    }

    if (data.status === "Inactivo" && technician.status !== "Inactivo") {
      const open = await prisma.mtWorkOrder.count({ where: { plantId: req.currentPlantId, assignedTo: technician.id, status: { in: OPEN } } });
      if (open > 0) return res.status(409).json({ error: `No se puede desactivar: tiene ${open} orden(es) abiertas asignadas. Reasígnalas primero.` });
    }

    const updated = await prisma.technician.update({ where: { id: technician.id }, data });
    return res.json(serialize(updated));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: zodMessage(err) });
    if (err.code === "P2002") return res.status(409).json({ error: "Ya existe un técnico con ese código en la planta" });
    logger.error("[technicians PATCH]", err);
    return res.status(500).json({ error: "Error updating technician" });
  }
});

// PUT /technicians/:id/user  body: { userId: number | null }
router.put("/:id/user", async (req, res) => {
  try {
    if (req.user?.role !== "ADMIN") return res.status(403).json({ error: "Solo un administrador puede vincular usuarios" });
    const technician = await findTechnician(req, res);
    if (!technician) return;

    const current = await prisma.user.findFirst({ where: { technicianId: technician.id }, select: { id: true, name: true } });
    const rawUserId = req.body?.userId;

    // Desvincular
    if (rawUserId === null || rawUserId === undefined || rawUserId === "") {
      if (current) await prisma.user.update({ where: { id: current.id }, data: { technicianId: null } });
      return res.json({ data: { user: null } });
    }

    const userId = parseId(rawUserId);
    if (!userId) return res.status(400).json({ error: "userId inválido" });
    if (current && current.id !== userId) {
      return res.status(409).json({ error: `Este técnico ya está vinculado a ${current.name}. Desvincúlalo primero.` });
    }

    const membership = await prisma.userPlant.findFirst({
      where: { userId, plantId: req.currentPlantId, active: true },
      select: { user: { select: { id: true, name: true, email: true, role: true, active: true, technicianId: true } } },
    });
    const user = membership?.user;
    if (!user || !user.active) return res.status(404).json({ error: "El usuario no existe o no pertenece a esta planta" });
    if (user.role !== "TECHNICIAN") return res.status(400).json({ error: "Solo se pueden vincular usuarios con rol TECHNICIAN" });
    if (user.technicianId && user.technicianId !== technician.id) {
      return res.status(409).json({ error: `${user.name} ya está vinculado a otro técnico. Desvincúlalo primero.` });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { technicianId: technician.id },
      select: { id: true, name: true, email: true, role: true, active: true },
    });
    return res.json({ data: { user: updated } });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Ese técnico ya está vinculado a otro usuario" });
    logger.error("[technicians/:id/user PUT]", err);
    return res.status(500).json({ error: "Error linking user" });
  }
});

// DELETE /technicians/:id — desactivación (soft delete); bloqueada si tiene OTs abiertas
router.delete("/:id", async (req, res) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can deactivate technicians" });
    const technician = await findTechnician(req, res);
    if (!technician) return;

    const open = await prisma.mtWorkOrder.count({ where: { plantId: req.currentPlantId, assignedTo: technician.id, status: { in: OPEN } } });
    if (open > 0) {
      return res.status(409).json({ error: `No se puede desactivar: tiene ${open} orden(es) abiertas asignadas. Reasígnalas primero.` });
    }

    const updated = await prisma.technician.update({
      where: { id: technician.id },
      data: { status: "Inactivo", deletedAt: new Date() },
    });
    return res.json({ message: "Technician deactivated", technician: serialize(updated) });
  } catch (err) {
    logger.error("[technicians DELETE]", err);
    return res.status(500).json({ error: "Error deleting technician" });
  }
});

export default router;
