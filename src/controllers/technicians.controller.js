// src/controllers/technicians.controller.js
import prisma from "../prisma.js";
import { logger } from "../config/logger.js";

/* =========================
   Helpers
   ========================= */

const ACTIVE_VALUES = ["Activo", "ACTIVO", "Active", "ACTIVE"];

/** Estado guardado siempre como "Activo" / "Inactivo". */
function normalizeStatus(value, fallback = "Activo") {
  const v = String(value ?? "").trim().toUpperCase();
  if (!v) return fallback;
  if (v === "ACTIVO" || v === "ACTIVE") return "Activo";
  if (v === "INACTIVO" || v === "INACTIVE") return "Inactivo";
  return fallback;
}

/** certifications se guarda como texto JSON; al cliente siempre se envía como lista. */
function parseCertifications(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function serializeCertifications(value) {
  if (!Array.isArray(value)) return null;
  const clean = value.map((c) => String(c ?? "").trim()).filter(Boolean).slice(0, 30);
  return JSON.stringify(clean);
}

function cleanOptional(value, max) {
  const v = String(value ?? "").trim();
  return v ? v.slice(0, max) : null;
}

const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Siguiente código libre TEC-001, TEC-002… en la planta.
 * Incluye técnicos eliminados porque el código es único por planta aunque estén borrados.
 */
async function nextTechnicianCode(plantId) {
  const rows = await prisma.technician.findMany({
    where: { plantId, code: { startsWith: "TEC-" } },
    select: { code: true },
  });
  const max = rows.reduce((acc, r) => {
    const m = /^TEC-(\d+)$/.exec(r.code || "");
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return `TEC-${String(max + 1).padStart(3, "0")}`;
}

function toClient(t, extra = {}) {
  const { executions, user, ...rest } = t;
  return {
    ...rest,
    status: normalizeStatus(rest.status),
    certifications: parseCertifications(rest.certifications),
    ...extra,
  };
}

function requirePlant(req, res) {
  const plantId = req.currentPlantId;
  if (!plantId) {
    res.status(400).json({ error: "PLANT_REQUIRED" });
    return null;
  }
  return plantId;
}

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return null;
  }
  return id;
}

/* =========================
   GET /api/technicians
   ========================= */
export const findAll = async (req, res) => {
  try {
    const plantId = requirePlant(req, res);
    if (!plantId) return;

    const technicians = await prisma.technician.findMany({
      where: { plantId, deletedAt: null },
      orderBy: { id: "desc" },
      include: {
        executions: {
          where: { plantId, executedAt: { not: null }, status: "COMPLETED" },
          orderBy: [{ executedAt: "desc" }],
          take: 1,
          select: { executedAt: true },
        },
        user: {
          select: {
            id: true,
            active: true,
            conditionReports: {
              where: { plantId },
              orderBy: [{ detectedAt: "desc" }, { createdAt: "desc" }],
              take: 1,
              select: { detectedAt: true, createdAt: true },
            },
          },
        },
      },
    });

    // Carga de trabajo por técnico (3 consultas agrupadas para toda la planta).
    const ids = technicians.map((t) => t.id);
    const today = startOfToday();
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [pendingRows, overdueRows, completedRows, routeRows] = ids.length
      ? await Promise.all([
          prisma.execution.groupBy({
            by: ["technicianId"],
            where: { plantId, technicianId: { in: ids }, status: { in: ["PENDING", "OVERDUE"] } },
            _count: { _all: true },
          }),
          prisma.execution.groupBy({
            by: ["technicianId"],
            where: {
              plantId,
              technicianId: { in: ids },
              status: { in: ["PENDING", "OVERDUE"] },
              scheduledAt: { lt: today },
            },
            _count: { _all: true },
          }),
          prisma.execution.groupBy({
            by: ["technicianId"],
            where: { plantId, technicianId: { in: ids }, status: "COMPLETED", executedAt: { gte: since30d } },
            _count: { _all: true },
          }),
          prisma.route.groupBy({
            by: ["technicianId"],
            where: { plantId, technicianId: { in: ids } },
            _count: { _all: true },
          }),
        ])
      : [[], [], [], []];

    const toMap = (rows) => new Map(rows.map((r) => [r.technicianId, r._count._all]));
    const pending = toMap(pendingRows);
    const overdue = toMap(overdueRows);
    const completed = toMap(completedRows);
    const routes = toMap(routeRows);

    const result = technicians.map((t) => {
      const execDate = t.executions?.[0]?.executedAt ?? null;
      const lastReport = t.user?.conditionReports?.[0] ?? null;
      const reportDate = lastReport?.detectedAt ?? lastReport?.createdAt ?? null;

      const candidates = [execDate, reportDate]
        .filter(Boolean)
        .map((d) => new Date(d))
        .filter((d) => Number.isFinite(d.getTime()));

      const lastActivityAt = candidates.length
        ? candidates.sort((a, b) => b.getTime() - a.getTime())[0].toISOString()
        : null;

      return toClient(t, {
        lastActivityAt,
        hasAppAccess: !!t.user && t.user.active !== false,
        stats: {
          pending: pending.get(t.id) || 0,
          overdue: overdue.get(t.id) || 0,
          completed30d: completed.get(t.id) || 0,
          routes: routes.get(t.id) || 0,
        },
      });
    });

    return res.json(result);
  } catch (error) {
    logger.error("Error obteniendo técnicos:", error);
    return res.status(500).json({ error: "Error obteniendo técnicos" });
  }
};

/* =========================
   GET /api/technicians/active
   ========================= */
export async function findActive(req, res) {
  try {
    const plantId = requirePlant(req, res);
    if (!plantId) return;

    const items = await prisma.technician.findMany({
      where: { plantId, deletedAt: null, status: { in: ACTIVE_VALUES } },
      orderBy: { id: "desc" },
    });

    return res.json({ ok: true, items: items.map((t) => toClient(t)) });
  } catch (error) {
    logger.error("Error obteniendo técnicos activos:", error);
    return res.status(500).json({ error: "Error obteniendo técnicos activos" });
  }
}

/* =========================
   GET /api/technicians/next-code
   ========================= */
export async function nextCode(req, res) {
  try {
    const plantId = requirePlant(req, res);
    if (!plantId) return;
    return res.json({ ok: true, code: await nextTechnicianCode(plantId) });
  } catch (error) {
    logger.error("Error calculando código de técnico:", error);
    return res.status(500).json({ error: "Error calculando código" });
  }
}

/* =========================
   GET /api/technicians/:id
   ========================= */
export async function findById(req, res) {
  try {
    const plantId = requirePlant(req, res);
    if (!plantId) return;
    const id = parseId(req, res);
    if (!id) return;

    const tech = await prisma.technician.findFirst({ where: { id, plantId, deletedAt: null } });
    if (!tech) return res.status(404).json({ error: "Técnico no encontrado" });

    return res.json({ ok: true, item: toClient(tech) });
  } catch (error) {
    logger.error("Error obteniendo técnico:", error);
    return res.status(500).json({ error: "Error obteniendo técnico" });
  }
}

/* =========================
   POST /api/technicians
   ========================= */
export async function createTechnician(req, res) {
  try {
    const plantId = requirePlant(req, res);
    if (!plantId) return;

    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 120);
    const specialty = String(body.specialty ?? body.speciality ?? "").trim().slice(0, 80);
    const email = cleanOptional(body.email, 160);
    const phone = cleanOptional(body.phone, 40);

    if (!name || !specialty) {
      return res.status(400).json({ error: "Nombre y especialidad son obligatorios" });
    }
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: "El correo no es válido" });
    }

    const code = String(body.code || "").trim().toUpperCase().slice(0, 30) || (await nextTechnicianCode(plantId));

    const created = await prisma.technician.create({
      data: {
        plantId,
        name,
        code,
        email,
        phone,
        specialty,
        certifications: serializeCertifications(body.certifications),
        status: normalizeStatus(body.status),
        deletedAt: null,
      },
    });

    return res.status(201).json({
      ok: true,
      item: toClient(created, {
        lastActivityAt: null,
        hasAppAccess: false,
        stats: { pending: 0, overdue: 0, completed30d: 0, routes: 0 },
      }),
    });
  } catch (e) {
    logger.error("POST technician", e);
    if (e?.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un técnico con ese código en esta planta" });
    }
    return res.status(500).json({ error: "Error creando técnico" });
  }
}

/* =========================
   PUT/PATCH /api/technicians/:id
   ========================= */
export async function updateTechnician(req, res) {
  try {
    const plantId = requirePlant(req, res);
    if (!plantId) return;
    const id = parseId(req, res);
    if (!id) return;

    const exists = await prisma.technician.findFirst({ where: { id, plantId, deletedAt: null } });
    if (!exists) return res.status(404).json({ error: "Técnico no encontrado" });

    const body = req.body || {};
    const data = {};

    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 120);
      if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
      data.name = name;
    }
    if (body.code !== undefined) {
      const code = String(body.code).trim().toUpperCase().slice(0, 30);
      if (!code) return res.status(400).json({ error: "El código es obligatorio" });
      data.code = code;
    }
    const specialtyIn = body.specialty ?? body.speciality;
    if (specialtyIn !== undefined) {
      const specialty = String(specialtyIn).trim().slice(0, 80);
      if (!specialty) return res.status(400).json({ error: "La especialidad es obligatoria" });
      data.specialty = specialty;
    }
    if (body.status !== undefined) data.status = normalizeStatus(body.status, exists.status);
    if (body.email !== undefined) {
      const email = cleanOptional(body.email, 160);
      if (email && !isValidEmail(email)) return res.status(400).json({ error: "El correo no es válido" });
      data.email = email;
    }
    if (body.phone !== undefined) data.phone = cleanOptional(body.phone, 40);
    if (body.certifications !== undefined) data.certifications = serializeCertifications(body.certifications);

    const updated = await prisma.technician.update({ where: { id }, data });

    return res.json({ ok: true, item: toClient(updated) });
  } catch (e) {
    logger.error("PATCH/PUT technician", e);
    if (e?.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un técnico con ese código en esta planta" });
    }
    return res.status(500).json({ error: "Error actualizando técnico" });
  }
}

/* =========================
   DELETE /api/technicians/:id  (borrado lógico)
   Libera sus rutas, actividades pendientes y OLP sin iniciar para que no queden
   asignadas a alguien que ya no aparece en la lista. El historial completado se conserva.
   ========================= */
export async function deleteTechnician(req, res) {
  try {
    const plantId = requirePlant(req, res);
    if (!plantId) return;
    const id = parseId(req, res);
    if (!id) return;

    const exists = await prisma.technician.findFirst({ where: { id, plantId, deletedAt: null } });
    if (!exists) return res.status(404).json({ error: "Técnico no encontrado" });

    const released = await prisma.$transaction(async (tx) => {
      const routes = await tx.route.updateMany({
        where: { plantId, technicianId: id },
        data: { technicianId: null },
      });
      const activities = await tx.execution.updateMany({
        where: { plantId, technicianId: id, status: { in: ["PENDING", "OVERDUE"] } },
        data: { technicianId: null },
      });
      const orders = await tx.preventiveOrder.updateMany({
        where: { plantId, assignedTo: id, status: { in: ["DRAFT", "OPEN"] } },
        data: { assignedTo: null },
      });
      await tx.technician.update({ where: { id }, data: { deletedAt: new Date() } });
      return { routes: routes.count, activities: activities.count, orders: orders.count };
    });

    return res.json({ ok: true, released });
  } catch (e) {
    logger.error("DELETE technician", e);
    return res.status(500).json({ error: "Error eliminando técnico" });
  }
}
