// src/routes/users.js
import express from "express";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { hashPassword } from "../utils/password.js";

const router = express.Router();

/**
 * GET /users/technicians/available
 * ADMIN only
 * MULTI-PLANTA
 */
router.get("/technicians/available", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const currentPlantId = req.currentPlantId;
    if (!currentPlantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const items = await prisma.technician.findMany({
      where: {
        plantId: currentPlantId,
        deletedAt: null,
        user: null,
        status: "Activo",
      },
      orderBy: { id: "desc" },
      select: { id: true, name: true, code: true, status: true },
    });

    return res.json({ ok: true, items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error obteniendo técnicos disponibles" });
  }
});

/**
 * GET /users/plants/available
 * ADMIN only
 * MULTI-PLANTA
 * Se usa para alta de usuario nuevo
 */
router.get("/plants/available", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const items = await prisma.plant.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        active: true,
        timezone: true,
      },
    });

    return res.json({
      ok: true,
      items: items.map((plant) => ({
        plantId: plant.id,
        assigned: false,
        active: false,
        isDefault: false,
        plant,
      })),
    });
  } catch (e) {
    console.error("GET /users/plants/available error:", e);
    return res.status(500).json({ error: "Error obteniendo plantas disponibles" });
  }
});

/**
 * GET /users
 * ADMIN only
 * MULTI-PLANTA
 */
router.get("/", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const currentPlantId = req.currentPlantId;
    if (!currentPlantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const itemsRaw = await prisma.user.findMany({
      where: {
        userPlants: {
          some: {
            plantId: currentPlantId,
            active: true,
          },
        },
      },
      orderBy: { id: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        passwordHash: true,
        technicianId: true,
        createdAt: true,
        updatedAt: true,

        technician: {
          select: {
            id: true,
            name: true,
            code: true,
            status: true,
            executions: {
              where: {
                plantId: currentPlantId,
              },
              orderBy: { scheduledAt: "desc" },
              take: 1,
              select: {
                id: true,
                scheduledAt: true,
                executedAt: true,
                status: true,
                route: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },

        userPlants: {
          where: {
            active: true,
          },
          select: {
            plantId: true,
            isDefault: true,
            active: true,
            plant: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: [{ isDefault: "desc" }, { plantId: "asc" }],
        },
      },
    });

    const items = itemsRaw.map((u) => {
      const lastExecution = u?.technician?.executions?.[0] || null;

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
        technician: u.technician
          ? {
              id: u.technician.id,
              name: u.technician.name,
              code: u.technician.code,
              status: u.technician.status,
            }
          : null,
        userPlants: u.userPlants || [],
        lastActivityAt:
          lastExecution?.executedAt ||
          lastExecution?.scheduledAt ||
          null,
        lastActivityStatus: lastExecution?.status || null,
        lastActivityRouteName: lastExecution?.route?.name || null,
      };
    });

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("GET /users error:", e);
    return res.status(500).json({ error: "Error obteniendo usuarios" });
  }
});

/**
 * POST /users
 * ADMIN only
 * Body: { name, email, role, technicianId? }
 *
 * MULTI-PLANTA:
 * El usuario se asigna automáticamente a la planta actual del admin creador
 */
router.post("/", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const currentPlantId = req.currentPlantId;
    if (!currentPlantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "TECHNICIAN").trim().toUpperCase();
    const passwordRaw = req.body?.password;

    if (!name || !email) {
      return res.status(400).json({ error: "Nombre y email requeridos" });
    }

    let passwordHash = null;
    if (passwordRaw !== undefined && passwordRaw !== null && String(passwordRaw) !== "") {
      const password = String(passwordRaw);
      if (password.length < 6) {
        return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
      }
      passwordHash = await hashPassword(password);
    }

    const VALID = ["ADMIN", "SUPERVISOR", "TECHNICIAN"];
    const finalRole = VALID.includes(role) ? role : "TECHNICIAN";

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) {
      return res.status(409).json({ error: "Email ya existe" });
    }

    let technicianId = req.body?.technicianId ?? null;

    if (technicianId !== null && technicianId !== undefined && technicianId !== "") {
      technicianId = Number(technicianId);
      if (!Number.isFinite(technicianId)) {
        return res.status(400).json({ error: "technicianId inválido" });
      }
    } else {
      technicianId = null;
    }

    if (finalRole === "TECHNICIAN") {
      if (technicianId == null) {
        return res.status(400).json({ error: "Para rol TECHNICIAN debes seleccionar un técnico" });
      }

      const tech = await prisma.technician.findFirst({
        where: {
          id: technicianId,
          plantId: currentPlantId,
          deletedAt: null,
          status: "Activo",
        },
      });

      if (!tech) {
        return res.status(400).json({ error: "Técnico no existe" });
      }

      const alreadyLinked = await prisma.user.findFirst({
        where: { technicianId },
      });

      if (alreadyLinked) {
        return res.status(409).json({ error: "Ese técnico ya tiene usuario asignado" });
      }
    } else {
      technicianId = null;
    }

    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name,
          email,
          role: finalRole,
          active: true,
          technicianId,
          passwordHash,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          active: true,
          technicianId: true,
          createdAt: true,
        },
      });

      await tx.userPlant.create({
        data: {
          userId: created.id,
          plantId: currentPlantId,
          active: true,
          isDefault: true,
        },
      });

      return created;
    });

    return res.json({ ok: true, user: result });
  } catch (e) {
    console.error("POST /users error:", e);

    if (e?.code === "P2002") {
      return res.status(409).json({ error: "Conflicto: valor duplicado" });
    }

    return res.status(500).json({ error: "Error creando usuario" });
  }
});

/**
 * GET /users/:id/plants
 * ADMIN only
 */
router.get("/:id/plants", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!user) {
      return res.status(404).json({ error: "Usuario no existe" });
    }

    const plants = await prisma.plant.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        active: true,
        timezone: true,
      },
    });

    const userPlants = await prisma.userPlant.findMany({
      where: { userId: id },
      select: {
        plantId: true,
        active: true,
        isDefault: true,
      },
    });

    const relMap = new Map(userPlants.map((up) => [Number(up.plantId), up]));

    const items = plants.map((plant) => {
      const rel = relMap.get(Number(plant.id));

      return {
        plantId: plant.id,
        assigned: !!rel,
        active: rel ? !!rel.active : false,
        isDefault: rel ? !!rel.isDefault : false,
        plant: {
          id: plant.id,
          name: plant.name,
          active: plant.active,
          timezone: plant.timezone,
        },
      };
    });

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("GET /users/:id/plants error:", e);
    return res.status(500).json({ error: "Error obteniendo plantas del usuario" });
  }
});

router.put("/:id/plants", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true },
    });

    if (!user) {
      return res.status(404).json({ error: "Usuario no existe" });
    }

    const plants = Array.isArray(req.body?.plants) ? req.body.plants : null;
    if (!plants) {
      return res.status(400).json({ error: "plants requerido" });
    }

    const normalized = plants.map((p) => ({
      plantId: Number(p?.plantId),
      active: Boolean(p?.active),
      isDefault: Boolean(p?.isDefault),
    }));

    if (normalized.some((p) => !Number.isFinite(p.plantId))) {
      return res.status(400).json({ error: "plantId inválido" });
    }

    const activePlants = normalized.filter((p) => p.active);
    if (activePlants.length === 0) {
      return res.status(400).json({ error: "Debe existir al menos una planta activa" });
    }

    const defaultPlants = activePlants.filter((p) => p.isDefault);
    if (defaultPlants.length !== 1) {
      return res.status(400).json({ error: "Debe existir exactamente una planta por defecto" });
    }

    const plantIds = normalized.map((p) => p.plantId);

    const existingPlants = await prisma.plant.findMany({
      where: {
        id: { in: plantIds },
        active: true,
      },
      select: { id: true },
    });

    const existingIds = new Set(existingPlants.map((p) => p.id));
    const invalid = plantIds.filter((id) => !existingIds.has(id));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Plantas inválidas: ${invalid.join(", ")}` });
    }

    await prisma.$transaction(async (tx) => {
      await tx.userPlant.deleteMany({
        where: { userId: id },
      });

      await tx.userPlant.createMany({
        data: normalized.map((p) => ({
          userId: id,
          plantId: p.plantId,
          active: p.active,
          isDefault: p.active ? p.isDefault : false,
        })),
      });
    });

    const updated = await prisma.userPlant.findMany({
      where: { userId: id },
      orderBy: [{ isDefault: "desc" }, { plantId: "asc" }],
      select: {
        plantId: true,
        active: true,
        isDefault: true,
        plant: {
          select: {
            id: true,
            name: true,
            timezone: true,
            active: true,
          },
        },
      },
    });

    return res.json({
      ok: true,
      items: updated,
    });
  } catch (e) {
    console.error("PUT /users/:id/plants error:", e);
    return res.status(500).json({ error: "Error actualizando plantas del usuario" });
  }
});

/**
 * PATCH /users/:id
 * ADMIN only
 * Body (opcionales): { name?, email?, role?, technicianId? }
 */
router.patch("/:id", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

    const VALID = ["ADMIN", "SUPERVISOR", "TECHNICIAN"];

    const current = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        technicianId: true,
      },
    });

    if (!current) return res.status(404).json({ error: "Usuario no existe" });

    const nameRaw = req.body?.name;
    const emailRaw = req.body?.email;
    const roleRaw = req.body?.role;
    const techRaw = req.body?.technicianId;

    const nextName =
      nameRaw === undefined ? current.name : String(nameRaw || "").trim();

    const nextEmail =
      emailRaw === undefined ? current.email : String(emailRaw || "").trim().toLowerCase();

    const nextRole =
      roleRaw === undefined
        ? String(current.role).toUpperCase()
        : String(roleRaw || "").trim().toUpperCase();

    if (!nextName) return res.status(400).json({ error: "Nombre requerido" });
    if (!nextEmail) return res.status(400).json({ error: "Email requerido" });
    if (!VALID.includes(nextRole)) return res.status(400).json({ error: "Rol inválido" });

    if (nextEmail !== current.email) {
      const exists = await prisma.user.findUnique({ where: { email: nextEmail } });
      if (exists) return res.status(409).json({ error: "Email ya existe" });
    }

    let nextTechnicianId = current.technicianId ?? null;

    if (techRaw !== undefined) {
      if (techRaw === null || techRaw === "" || techRaw === "null") {
        nextTechnicianId = null;
      } else {
        const parsed = Number(techRaw);
        if (!Number.isFinite(parsed)) {
          return res.status(400).json({ error: "technicianId inválido" });
        }
        nextTechnicianId = parsed;
      }
    }

    if (nextRole !== "TECHNICIAN") {
      nextTechnicianId = null;
    } else {
      if (nextTechnicianId == null) {
        return res.status(400).json({ error: "Para rol TECHNICIAN debes seleccionar un técnico" });
      }

      const currentPlantId = req.currentPlantId;
      if (!currentPlantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const tech = await prisma.technician.findFirst({
        where: {
          id: nextTechnicianId,
          plantId: currentPlantId,
          deletedAt: null,
          status: "Activo",
        },
      });

      if (!tech) {
        return res.status(400).json({ error: "Técnico no existe" });
      }

      const linked = await prisma.user.findFirst({
        where: { technicianId: nextTechnicianId },
        select: { id: true },
      });

      if (linked && linked.id !== id) {
        return res.status(409).json({ error: "Ese técnico ya tiene usuario asignado" });
      }
    }

    if (req.user?.id === id && nextRole !== current.role) {
      return res.status(400).json({ error: "No puedes cambiar tu propio rol" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        name: nextName,
        email: nextEmail,
        role: nextRole,
        technicianId: nextTechnicianId,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        technicianId: true,
        createdAt: true,
      },
    });

    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error("PATCH /users/:id error:", e);

    if (e?.code === "P2002") {
      return res.status(409).json({ error: "Conflicto: valor duplicado" });
    }

    return res.status(500).json({ error: "Error actualizando usuario" });
  }
});

/**
 * PATCH /users/:id/status
 * ADMIN only
 * Body: { active: boolean }
 */
router.patch("/:id/status", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

    const rawActive = req.body?.active;
    const active =
      rawActive === true ||
      rawActive === "true" ||
      rawActive === 1 ||
      rawActive === "1"
        ? true
        : rawActive === false ||
            rawActive === "false" ||
            rawActive === 0 ||
            rawActive === "0"
          ? false
          : null;

    if (active === null) {
      return res.status(400).json({ error: "active inv?lido" });
    }

    if (req.user?.id === id && active === false) {
      return res.status(400).json({ error: "No puedes desactivarte a ti mismo" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { active },
      select: { id: true, name: true, email: true, role: true, active: true },
    });

    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error("PATCH /users/:id/status error:", e);
    return res.status(500).json({ error: "Error actualizando estado" });
  }
});

export default router;
