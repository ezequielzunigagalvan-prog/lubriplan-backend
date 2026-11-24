// src/routes/users.js
// Usuarios y su acceso por planta (solo ADMIN).
//
//  - Un usuario puede tener acceso a varias plantas (p. ej. un supervisor a cargo de dos o más).
//  - Un técnico puede trabajar en varias plantas: tiene un perfil de técnico en cada una
//    (ver services/technicianProfile.js). Su perfil principal es el de la planta predeterminada.
//
// Correcciones respecto a la versión anterior:
//  - Ya no se puede desactivar ni quitar el rol al último administrador activo.
//  - Correo con formato válido; contraseña de 8 caracteres o más (igual que la recuperación).
//  - Técnico "Activo" sin importar mayúsculas (antes "ACTIVO" no se encontraba).
//  - El administrador puede fijar una contraseña o enviar un enlace para crearla.
//  - Al dejar de ser técnico se liberan sus perfiles para poder ligarlos a otra cuenta.

import express from "express";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { hashPassword } from "../utils/password.js";
import { logger } from "../config/logger.js";
import { createResetToken, sendResetEmail } from "../services/auth/passwordReset.js";
import { ensureTechnicianProfile, listTechnicianProfiles, ProfileError } from "../services/technicianProfile.js";

const router = express.Router();
const admin = [requireAuth, requireRole(["ADMIN"])];
const ROLES = ["ADMIN", "SUPERVISOR", "TECHNICIAN"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

const isActiveTech = (s) => ["ACTIVO", "ACTIVE"].includes(String(s || "").trim().toUpperCase());

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(res, e, label) {
  if (e instanceof HttpError || e instanceof ProfileError) return res.status(e.status || 400).json({ error: e.message });
  if (e?.code === "P2002") return res.status(409).json({ error: "Ya existe un registro con ese valor (correo o código)" });
  logger.error(label, e);
  return res.status(500).json({ error: "Ocurrió un error; intenta de nuevo" });
}

async function activeAdminCount(excludeId = null) {
  return prisma.user.count({ where: { role: "ADMIN", active: true, ...(excludeId ? { id: { not: excludeId } } : {}) } });
}

/* ───────── Serialización ───────── */
const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  passwordHash: true,
  technicianId: true,
  createdAt: true,
  updatedAt: true,
  userPlants: {
    where: { active: true },
    orderBy: [{ isDefault: "desc" }, { plantId: "asc" }],
    select: { plantId: true, isDefault: true, plant: { select: { id: true, name: true } } },
  },
};

async function serializeUsers(users) {
  const techUsers = users.filter((u) => u.role === "TECHNICIAN");
  const profiles = techUsers.length
    ? await prisma.technician.findMany({
        where: {
          deletedAt: null,
          plantId: { gt: 0 },
          OR: [{ userId: { in: techUsers.map((u) => u.id) } }, { id: { in: techUsers.map((u) => u.technicianId).filter(Boolean) } }],
        },
        select: { id: true, plantId: true, code: true, name: true, status: true, userId: true },
      })
    : [];
  return users.map((u) => {
    const mine = profiles.filter((p) => p.userId === u.id || p.id === u.technicianId);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      hasPassword: Boolean(u.passwordHash),
      technicianId: u.technicianId,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      plants: u.userPlants.map((up) => ({
        plantId: up.plantId,
        name: up.plant?.name || `Planta ${up.plantId}`,
        isDefault: up.isDefault,
        technician: (() => {
          const t = mine.find((p) => p.plantId === up.plantId);
          return t ? { id: t.id, code: t.code, name: t.name, status: t.status } : null;
        })(),
      })),
    };
  });
}

/* ───────── Validación del acceso (plantas + perfiles de técnico) ───────── */
/**
 * plants: [{ plantId, isDefault }]
 * technicians: { [plantId]: { technicianId? , code? } }  (solo rol TECHNICIAN)
 */
async function parseAccess(body) {
  const list = Array.isArray(body?.plants) ? body.plants : [];
  const plants = [];
  const seen = new Set();
  for (const p of list) {
    const plantId = Number(p?.plantId);
    if (!Number.isInteger(plantId) || plantId <= 0) throw new HttpError(400, "Planta inválida");
    if (p?.active === false) continue; // compatibilidad con el formato anterior
    if (seen.has(plantId)) continue;
    seen.add(plantId);
    plants.push({ plantId, isDefault: Boolean(p?.isDefault) });
  }
  if (!plants.length) throw new HttpError(400, "Asigna al menos una planta");
  const defaults = plants.filter((p) => p.isDefault);
  if (defaults.length === 0) plants[0].isDefault = true;
  else if (defaults.length > 1) throw new HttpError(400, "Solo una planta puede ser la predeterminada");

  const existing = await prisma.plant.findMany({ where: { id: { in: plants.map((p) => p.plantId) }, active: true }, select: { id: true } });
  const ok = new Set(existing.map((p) => p.id));
  const bad = plants.filter((p) => !ok.has(p.plantId));
  if (bad.length) throw new HttpError(400, "Una de las plantas no existe o está inactiva");

  const technicians = body?.technicians && typeof body.technicians === "object" ? body.technicians : {};
  return { plants, technicians };
}

/** Aplica el acceso dentro de una transacción. Devuelve los perfiles creados. */
async function applyAccess(tx, user, role, { plants, technicians }) {
  await tx.userPlant.deleteMany({ where: { userId: user.id } });
  await tx.userPlant.createMany({
    data: plants.map((p) => ({ userId: user.id, plantId: p.plantId, active: true, isDefault: p.isDefault })),
  });

  if (role !== "TECHNICIAN") {
    // Deja de ser técnico: libera sus perfiles para poder ligarlos a otra cuenta.
    await tx.technician.updateMany({ where: { userId: user.id, plantId: { gt: 0 } }, data: { userId: null } });
    if (user.technicianId) await tx.user.update({ where: { id: user.id }, data: { technicianId: null } });
    return { created: [] };
  }

  const created = [];
  let homeId = null;
  for (const p of plants) {
    const spec = technicians[p.plantId] || technicians[String(p.plantId)] || {};
    const r = await ensureTechnicianProfile(tx, {
      user,
      plantId: p.plantId,
      technicianId: spec.technicianId ? Number(spec.technicianId) : null,
      code: spec.code || null,
    });
    if (r.created) created.push({ plantId: p.plantId, id: r.id });
    if (p.isDefault) homeId = r.id;
  }
  // El perfil principal (User.technicianId, único) es el de la planta predeterminada.
  if (homeId && homeId !== user.technicianId) {
    await tx.user.updateMany({ where: { technicianId: homeId, id: { not: user.id } }, data: { technicianId: null } });
    await tx.user.update({ where: { id: user.id }, data: { technicianId: homeId } });
  }
  return { created };
}

/* ───────── Rutas ───────── */

// Lista: usuarios con acceso a la planta actual, o a cualquiera de mis plantas (scope=all).
router.get("/", ...admin, async (req, res) => {
  try {
    if (!req.currentPlantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
    let plantFilter = [req.currentPlantId];
    if (req.query.scope === "all") {
      const mine = await prisma.userPlant.findMany({ where: { userId: req.user.id, active: true }, select: { plantId: true } });
      plantFilter = mine.map((m) => m.plantId);
    }
    const users = await prisma.user.findMany({
      where: { userPlants: { some: { plantId: { in: plantFilter }, active: true } } },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: USER_SELECT,
    });
    return res.json({ ok: true, items: await serializeUsers(users) });
  } catch (e) {
    return fail(res, e, "GET /users");
  }
});

// Opciones para el formulario: plantas activas y, por planta, técnicos sin cuenta para ligar.
router.get("/options", ...admin, async (req, res) => {
  try {
    const [plants, techs] = await Promise.all([
      prisma.plant.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
      prisma.technician.findMany({
        where: { deletedAt: null, plantId: { gt: 0 } },
        orderBy: [{ plantId: "asc" }, { name: "asc" }],
        select: { id: true, plantId: true, name: true, code: true, status: true, userId: true, user: { select: { id: true } } },
      }),
    ]);
    const forUser = Number(req.query.userId) || null;
    const technicians = techs
      .filter((t) => isActiveTech(t.status))
      .map((t) => {
        const ownerId = t.userId ?? t.user?.id ?? null;
        return { id: t.id, plantId: t.plantId, name: t.name, code: t.code, linkedUserId: ownerId };
      })
      .filter((t) => !t.linkedUserId || t.linkedUserId === forUser);
    return res.json({ ok: true, plants, technicians });
  } catch (e) {
    return fail(res, e, "GET /users/options");
  }
});

// Compatibilidad con la pantalla anterior.
router.get("/technicians/available", ...admin, async (req, res) => {
  try {
    if (!req.currentPlantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
    const items = await prisma.technician.findMany({
      where: { plantId: req.currentPlantId, deletedAt: null, user: null, userId: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true, status: true },
    });
    return res.json({ ok: true, items: items.filter((t) => isActiveTech(t.status)) });
  } catch (e) {
    return fail(res, e, "GET /users/technicians/available");
  }
});

router.post("/", ...admin, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "TECHNICIAN").trim().toUpperCase();
    const password = req.body?.password ? String(req.body.password) : "";
    const sendInvite = Boolean(req.body?.sendInvite);

    if (!name) throw new HttpError(400, "Escribe el nombre");
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Escribe un correo válido");
    if (!ROLES.includes(role)) throw new HttpError(400, "Rol no válido");
    if (password && password.length < MIN_PASSWORD) throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) throw new HttpError(409, "Ya existe un usuario con ese correo");

    // Sin plantas indicadas: la planta actual (comportamiento anterior).
    const body = Array.isArray(req.body?.plants) && req.body.plants.length
      ? req.body
      : {
          ...req.body,
          plants: [{ plantId: req.currentPlantId, isDefault: true }],
          technicians: req.body?.technicianId ? { [req.currentPlantId]: { technicianId: req.body.technicianId } } : req.body?.technicians,
        };
    const access = await parseAccess(body);
    const passwordHash = password ? await hashPassword(password) : null;

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { name, email, role, active: true, passwordHash },
        select: { id: true, name: true, email: true, technicianId: true, passwordHash: true },
      });
      await applyAccess(tx, created, role, access);
      return created;
    });

    let invite = null;
    if (!password && sendInvite) {
      const r = await sendResetEmail(user, createResetToken(user, { invite: true }), { invite: true }).catch((err) => ({ ok: false, error: err?.message }));
      invite = r?.ok === false ? "No se pudo enviar el correo de bienvenida" : "sent";
    }
    const [out] = await serializeUsers([await prisma.user.findUnique({ where: { id: user.id }, select: USER_SELECT })]);
    logger.info("[USERS] Usuario creado", { by: req.user.id, userId: user.id, role });
    return res.status(201).json({ ok: true, user: out, invite });
  } catch (e) {
    return fail(res, e, "POST /users");
  }
});

router.patch("/:id", ...admin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const current = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, role: true, active: true, technicianId: true } });
    if (!current) throw new HttpError(404, "El usuario no existe");

    const name = req.body?.name === undefined ? current.name : String(req.body.name || "").trim();
    const email = req.body?.email === undefined ? current.email : String(req.body.email || "").trim().toLowerCase();
    const role = req.body?.role === undefined ? current.role : String(req.body.role || "").trim().toUpperCase();
    if (!name) throw new HttpError(400, "Escribe el nombre");
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Escribe un correo válido");
    if (!ROLES.includes(role)) throw new HttpError(400, "Rol no válido");
    if (role !== current.role) {
      if (req.user.id === id) throw new HttpError(400, "No puedes cambiar tu propio rol");
      if (current.role === "ADMIN" && current.active && (await activeAdminCount(id)) === 0) {
        throw new HttpError(400, "Es el único administrador activo: asigna otro administrador antes de cambiarle el rol");
      }
    }
    if (email !== current.email && (await prisma.user.findUnique({ where: { email }, select: { id: true } }))) {
      throw new HttpError(409, "Ya existe un usuario con ese correo");
    }

    const accessGiven = Array.isArray(req.body?.plants);
    const access = accessGiven ? await parseAccess(req.body) : null;
    if (role === "TECHNICIAN" && current.role !== "TECHNICIAN" && !access) {
      throw new HttpError(400, "Para cambiarlo a técnico indica sus plantas y su perfil de técnico en cada una");
    }

    await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data: { name, email, role }, select: { id: true, name: true, email: true, technicianId: true } });
      if (access) await applyAccess(tx, updated, role, access);
      else if (role !== "TECHNICIAN" && current.role === "TECHNICIAN") {
        await tx.technician.updateMany({ where: { userId: id, plantId: { gt: 0 } }, data: { userId: null } });
        await tx.user.update({ where: { id }, data: { technicianId: null } });
      }
    });
    const [out] = await serializeUsers([await prisma.user.findUnique({ where: { id }, select: USER_SELECT })]);
    return res.json({ ok: true, user: out });
  } catch (e) {
    return fail(res, e, "PATCH /users/:id");
  }
});

// Acceso por planta (y perfiles de técnico). Acepta también el formato anterior { plants: [{ plantId, active, isDefault }] }.
async function putAccess(req, res) {
  try {
    const id = Number(req.params.id);
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, role: true, technicianId: true } });
    if (!user) throw new HttpError(404, "El usuario no existe");
    const access = await parseAccess(req.body);
    await prisma.$transaction((tx) => applyAccess(tx, user, user.role, access));
    const [out] = await serializeUsers([await prisma.user.findUnique({ where: { id }, select: USER_SELECT })]);
    return res.json({ ok: true, user: out });
  } catch (e) {
    return fail(res, e, "PUT /users/:id/access");
  }
}
router.put("/:id/access", ...admin, putAccess);
router.put("/:id/plants", ...admin, putAccess);

router.patch("/:id/status", ...admin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const raw = req.body?.active;
    const active = raw === true || raw === "true" || raw === 1 ? true : raw === false || raw === "false" || raw === 0 ? false : null;
    if (active === null) throw new HttpError(400, "Indica si el usuario queda activo o inactivo");
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, active: true } });
    if (!user) throw new HttpError(404, "El usuario no existe");
    if (!active) {
      if (req.user.id === id) throw new HttpError(400, "No puedes desactivarte a ti mismo");
      if (user.role === "ADMIN" && (await activeAdminCount(id)) === 0) throw new HttpError(400, "Es el único administrador activo: no se puede desactivar");
    }
    await prisma.user.update({ where: { id }, data: { active } });
    return res.json({ ok: true, active });
  } catch (e) {
    return fail(res, e, "PATCH /users/:id/status");
  }
});

// El administrador fija una contraseña nueva.
router.post("/:id/password", ...admin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const password = String(req.body?.password || "");
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new HttpError(404, "El usuario no existe");
    await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });
    logger.info("[USERS] Contraseña fijada por administrador", { by: req.user.id, userId: id });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, e, "POST /users/:id/password");
  }
});

// Envía al usuario un enlace para crear o restablecer su contraseña.
router.post("/:id/password-link", ...admin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, active: true, passwordHash: true } });
    if (!user) throw new HttpError(404, "El usuario no existe");
    if (!user.active) throw new HttpError(400, "El usuario está inactivo: actívalo primero");
    const invite = !user.passwordHash;
    const r = await sendResetEmail(user, createResetToken(user, { invite }), { invite });
    if (r?.ok === false) throw new HttpError(502, "No se pudo enviar el correo. Revisa la configuración de correo o fija la contraseña manualmente.");
    return res.json({ ok: true, invite });
  } catch (e) {
    return fail(res, e, "POST /users/:id/password-link");
  }
});

// Perfiles de técnico del usuario (uno por planta).
router.get("/:id/technician-profiles", ...admin, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: Number(req.params.id) }, select: { id: true, technicianId: true } });
    if (!user) throw new HttpError(404, "El usuario no existe");
    return res.json({ ok: true, items: await listTechnicianProfiles(prisma, user) });
  } catch (e) {
    return fail(res, e, "GET /users/:id/technician-profiles");
  }
});

export default router;
