// src/routes/owner.routes.js
// Consola del dueño de la plataforma — /api/owner
//
// Alta de clientes y vista de todas las plantas. Solo para usuarios con isPlatformOwner;
// para cualquier otro responde 404 (no revela que existe).
//
// Correcciones respecto al "Alta cliente" anterior (/api/admin/onboarding-client):
//  - Cualquier ADMIN, incluido el admin de un cliente, podía dar de alta clientes.
//  - Quien daba de alta quedaba ligado a la planta nueva por defecto (linkRequesterToPlant = true),
//    así un cliente veía la planta de otro. Ahora no se liga a nadie más que al admin del cliente,
//    salvo que el dueño lo pida explícitamente.

import express from "express";
import { hashPassword } from "../utils/password.js";
import { logger } from "../config/logger.js";
import { logAudit } from "../services/audit.service.js";
import { createResetToken, sendResetEmail } from "../services/auth/passwordReset.js";

const DEFAULT_TIMEZONE = "America/Mexico_City";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class OwnerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const text = (v, max = 160) => String(v ?? "").trim().slice(0, max);

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("es-MX", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function intIn(v, min, max, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** Valida el alta. Exportada para pruebas. */
export function parseClientInput(body = {}) {
  const plantName = text(body.plantName, 120);
  if (!plantName) throw new OwnerError(400, "Escribe el nombre de la planta");
  const timezone = text(body.timezone) || DEFAULT_TIMEZONE;
  if (!validTimeZone(timezone)) throw new OwnerError(400, "Zona horaria inválida");
  const monthlyReportDay = intIn(body.monthlyReportDay, 1, 28, 1);
  const monthlyReportHour = intIn(body.monthlyReportHour, 0, 23, 8);
  if (monthlyReportDay == null) throw new OwnerError(400, "El día del reporte mensual debe estar entre 1 y 28");
  if (monthlyReportHour == null) throw new OwnerError(400, "La hora del reporte mensual debe estar entre 0 y 23");
  const extra = text(body.monthlyReportRecipientsExtra, 1000) || null;
  if (extra && !extra.split(",").map((e) => e.trim()).filter(Boolean).every((e) => EMAIL_RE.test(e))) {
    throw new OwnerError(400, "Hay correos inválidos en destinatarios extra");
  }

  const mode = body.adminMode === "existing" ? "existing" : "new";
  let admin;
  if (mode === "existing") {
    const userId = Number(body.adminUserId);
    if (!Number.isInteger(userId) || userId <= 0) throw new OwnerError(400, "Elige el administrador del cliente");
    admin = { mode, userId };
  } else {
    const name = text(body.adminName, 120);
    const email = text(body.adminEmail).toLowerCase();
    const password = String(body.adminPassword || "");
    const sendInvite = body.sendInvite === true;
    if (!name) throw new OwnerError(400, "Escribe el nombre del administrador");
    if (!EMAIL_RE.test(email)) throw new OwnerError(400, "Escribe un correo válido para el administrador");
    if (!sendInvite && password.length < 8) throw new OwnerError(400, "La contraseña temporal debe tener al menos 8 caracteres (o envía invitación por correo)");
    admin = { mode, name, email, password: sendInvite && !password ? "" : password, sendInvite };
  }

  return {
    plantName,
    timezone,
    monthlyReportEnabled: body.monthlyReportEnabled !== false,
    monthlyReportDay,
    monthlyReportHour,
    monthlyReportRecipientsExtra: extra,
    createBaseArea: body.createBaseArea === true,
    baseAreaName: text(body.baseAreaName, 80) || "General",
    linkMe: body.linkMe === true,
    admin,
  };
}

export default function ownerRoutes({ prisma, auth }) {
  const router = express.Router();

  const requireOwner = (req, res, next) => {
    if (req.user?.isPlatformOwner !== true) return res.status(404).json({ error: "No encontrado" });
    next();
  };
  router.use(auth, requireOwner);

  const fail = (res, e, label) => {
    if (e instanceof OwnerError) return res.status(e.status).json({ error: e.message });
    if (e?.code === "P2002") return res.status(409).json({ error: "Ya existe un usuario con ese correo" });
    logger.error(`[OWNER ${label}]`, e);
    return res.status(500).json({ error: "Ocurrió un error; intenta de nuevo" });
  };

  // ── GET /api/owner/overview ── todas las plantas con sus administradores y uso
  router.get("/overview", async (req, res) => {
    try {
      const plants = await prisma.plant.findMany({
        select: {
          id: true,
          name: true,
          timezone: true,
          active: true,
          createdAt: true,
          userPlants: {
            where: { active: true },
            select: { user: { select: { id: true, name: true, email: true, role: true, active: true, isPlatformOwner: true } } },
          },
        },
        orderBy: [{ active: "desc" }, { name: "asc" }],
      });
      const ids = plants.map((p) => p.id);
      const since = new Date(Date.now() - 30 * 86400000);
      const [eq, routes, execs] = ids.length
        ? await Promise.all([
            prisma.equipment.groupBy({ by: ["plantId"], where: { plantId: { in: ids } }, _count: { _all: true } }),
            prisma.route.groupBy({ by: ["plantId"], where: { plantId: { in: ids } }, _count: { _all: true } }),
            prisma.execution.groupBy({ by: ["plantId"], where: { plantId: { in: ids }, status: "COMPLETED", executedAt: { gte: since } }, _count: { _all: true } }),
          ])
        : [[], [], []];
      const cnt = (rows) => new Map(rows.map((r) => [r.plantId, r._count._all]));
      const eqBy = cnt(eq);
      const rtBy = cnt(routes);
      const exBy = cnt(execs);

      const items = plants.map((p) => {
        const users = p.userPlants.map((u) => u.user);
        const clientUsers = users.filter((u) => !u.isPlatformOwner);
        return {
          id: p.id,
          name: p.name,
          timezone: p.timezone,
          active: p.active,
          createdAt: p.createdAt,
          admins: clientUsers.filter((u) => u.role === "ADMIN").map(({ isPlatformOwner, ...u }) => u),
          users: clientUsers.length,
          ownerLinked: users.some((u) => u.id === req.user.id),
          equipment: eqBy.get(p.id) || 0,
          routes: rtBy.get(p.id) || 0,
          executions30d: exBy.get(p.id) || 0,
        };
      });

      // Administradores de clientes (para dar otra planta a un cliente existente)
      const admins = await prisma.user.findMany({
        where: { role: "ADMIN", isPlatformOwner: false },
        select: { id: true, name: true, email: true, active: true, userPlants: { where: { active: true }, select: { plant: { select: { id: true, name: true } } } } },
        orderBy: { name: "asc" },
      });

      return res.json({
        ok: true,
        plants: items,
        admins: admins.map((a) => ({ id: a.id, name: a.name, email: a.email, active: a.active, plants: a.userPlants.map((x) => x.plant) })),
        totals: {
          plants: items.length,
          active: items.filter((p) => p.active).length,
          equipment: items.reduce((s, p) => s + p.equipment, 0),
          executions30d: items.reduce((s, p) => s + p.executions30d, 0),
        },
      });
    } catch (e) {
      return fail(res, e, "OVERVIEW");
    }
  });

  // ── POST /api/owner/clients ── planta nueva + su administrador (nuevo o existente)
  router.post("/clients", async (req, res) => {
    try {
      const input = parseClientInput(req.body || {});
      const { admin } = input;

      if (admin.mode === "new") {
        const exists = await prisma.user.findUnique({ where: { email: admin.email }, select: { id: true } });
        if (exists) throw new OwnerError(409, "Ya existe un usuario con ese correo; usa “Cliente existente” si es el mismo cliente");
      } else {
        const u = await prisma.user.findUnique({ where: { id: admin.userId }, select: { id: true, role: true, active: true, isPlatformOwner: true } });
        if (!u || u.role !== "ADMIN" || u.isPlatformOwner) throw new OwnerError(400, "El administrador elegido no es válido");
        if (!u.active) throw new OwnerError(400, "El administrador elegido está inactivo");
      }

      const passwordHash = admin.mode === "new" && admin.password ? await hashPassword(admin.password) : null;

      const result = await prisma.$transaction(async (tx) => {
        const plant = await tx.plant.create({
          data: {
            name: input.plantName,
            timezone: input.timezone,
            active: true,
            monthlyReportEnabled: input.monthlyReportEnabled,
            monthlyReportDay: input.monthlyReportDay,
            monthlyReportHour: input.monthlyReportHour,
            monthlyReportRecipientsExtra: input.monthlyReportRecipientsExtra,
          },
          select: { id: true, name: true, timezone: true },
        });

        let baseArea = null;
        if (input.createBaseArea) {
          baseArea = await tx.equipmentArea.create({
            data: { plantId: plant.id, name: input.baseAreaName, description: "Área base creada en el alta del cliente" },
            select: { id: true, name: true },
          });
        }

        let user;
        if (admin.mode === "new") {
          user = await tx.user.create({
            data: { name: admin.name, email: admin.email, passwordHash, role: "ADMIN", active: true },
            select: { id: true, name: true, email: true },
          });
          await tx.userPlant.create({ data: { userId: user.id, plantId: plant.id, isDefault: true, active: true } });
        } else {
          user = await tx.user.findUnique({ where: { id: admin.userId }, select: { id: true, name: true, email: true } });
          await tx.userPlant.create({ data: { userId: user.id, plantId: plant.id, isDefault: false, active: true } });
        }

        // El dueño solo queda con acceso si lo pidió (soporte); nunca por defecto.
        if (input.linkMe) {
          await tx.userPlant.create({ data: { userId: req.user.id, plantId: plant.id, isDefault: false, active: true } });
        }

        return { plant, user, baseArea };
      });

      let invite = null;
      if (admin.mode === "new" && admin.sendInvite) {
        const full = await prisma.user.findUnique({ where: { id: result.user.id } });
        const r = await sendResetEmail(full, createResetToken(full, { invite: true }), { invite: true }).catch((e) => {
          logger.error("[OWNER] invitación", e);
          return { ok: false };
        });
        invite = r?.ok === false ? "failed" : "sent";
      }

      logAudit({
        plantId: result.plant.id,
        userId: req.user.id,
        action: "CREATE",
        model: "Plant",
        recordId: result.plant.id,
        changes: { after: { plant: result.plant.name, admin: result.user.email, adminMode: admin.mode, ownerLinked: input.linkMe } },
        ip: req.ip,
      });

      return res.status(201).json({ ok: true, ...result, ownerLinked: input.linkMe, invite });
    } catch (e) {
      return fail(res, e, "CREATE_CLIENT");
    }
  });

  // ── PATCH /api/owner/plants/:id ── activar/desactivar o renombrar
  router.patch("/plants/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const plant = await prisma.plant.findUnique({ where: { id }, select: { id: true, name: true, active: true } });
      if (!plant) throw new OwnerError(404, "Planta no encontrada");
      const data = {};
      if (typeof req.body?.active === "boolean") data.active = req.body.active;
      if (req.body?.name !== undefined) {
        const name = text(req.body.name, 120);
        if (!name) throw new OwnerError(400, "Escribe el nombre de la planta");
        data.name = name;
      }
      if (!Object.keys(data).length) throw new OwnerError(400, "Nada que cambiar");
      const updated = await prisma.plant.update({ where: { id }, data, select: { id: true, name: true, active: true } });
      logAudit({ plantId: id, userId: req.user.id, action: "UPDATE", model: "Plant", recordId: id, changes: { before: plant, after: updated }, ip: req.ip });
      return res.json({ ok: true, plant: updated });
    } catch (e) {
      return fail(res, e, "PATCH_PLANT");
    }
  });

  // ── PUT /api/owner/plants/:id/my-access ── darme o quitarme acceso a una planta (soporte)
  router.put("/plants/:id/my-access", async (req, res) => {
    try {
      const plantId = Number(req.params.id);
      const enable = req.body?.enable === true;
      const plant = await prisma.plant.findUnique({ where: { id: plantId }, select: { id: true } });
      if (!plant) throw new OwnerError(404, "Planta no encontrada");
      const link = await prisma.userPlant.findUnique({ where: { userId_plantId: { userId: req.user.id, plantId } } });
      if (enable) {
        if (link) await prisma.userPlant.update({ where: { id: link.id }, data: { active: true } });
        else await prisma.userPlant.create({ data: { userId: req.user.id, plantId, active: true, isDefault: false } });
      } else if (link) {
        if (link.isDefault) throw new OwnerError(400, "Es tu planta predeterminada; cambia la predeterminada antes de quitarte el acceso");
        await prisma.userPlant.delete({ where: { id: link.id } });
      }
      logAudit({ plantId, userId: req.user.id, action: "UPDATE", model: "UserPlant", recordId: `${req.user.id}:${plantId}`, changes: { after: { ownerAccess: enable } }, ip: req.ip });
      return res.json({ ok: true, enabled: enable });
    } catch (e) {
      return fail(res, e, "MY_ACCESS");
    }
  });

  return router;
}
