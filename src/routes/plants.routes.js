// routes/plants.routes.js
import express from "express";

/**
 * plantsRoutes
 * Endpoints:
 *  - GET    /api/plants                 (lista plantas del usuario)
 *  - POST   /api/plants                 (crea planta + membresía) [ADMIN]
 *  - POST   /api/plants/:id/default     (marca default para el usuario)
 *  - PATCH  /api/plants/:id             (renombrar planta) [ADMIN]
 *  - GET    /api/plants/current         (devuelve planta default o la del header x-plant-id)
 */
export default function plantsRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  const toInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  async function getUserDefaultPlantId(userId) {
    const def = await prisma.userPlant.findFirst({
      where: { userId, isDefault: true, active: true },
      select: { plantId: true },
      orderBy: { createdAt: "asc" },
    });
    if (def?.plantId) return def.plantId;

    // fallback: primera planta activa del usuario
    const first = await prisma.userPlant.findFirst({
      where: { userId, active: true },
      select: { plantId: true },
      orderBy: { createdAt: "asc" },
    });
    return first?.plantId ?? null;
  }

  // GET /api/plants
  router.get("/plants", auth, async (req, res) => {
    try {
      const userId = req.user.id;

      const rows = await prisma.userPlant.findMany({
        where: { userId, active: true },
        select: {
          isDefault: true,
          plant: { select: { id: true, name: true, timezone: true, active: true, createdAt: true } },
        },
        orderBy: [{ isDefault: "desc" }, { plant: { createdAt: "asc" } }],
      });

      const plants = rows.map((r) => ({
        ...r.plant,
        isDefault: r.isDefault,
      }));

      const defaultPlantId = plants.find((p) => p.isDefault)?.id ?? plants[0]?.id ?? null;

      return res.json({ ok: true, plants, defaultPlantId });
    } catch (e) {
      console.error("GET /plants error:", e);
      return res.status(500).json({ ok: false, error: "Error cargando plantas" });
    }
  });

  // GET /api/plants/current
  router.get("/plants/current", auth, async (req, res) => {
    try {
      const userId = req.user.id;
      const headerPlantId = toInt(req.header("x-plant-id") || req.header("X-Plant-Id"));

      // Si viene header, valida que pertenezca al usuario
      if (headerPlantId) {
        const membership = await prisma.userPlant.findUnique({
          where: { userId_plantId: { userId, plantId: headerPlantId } },
          select: { plant: { select: { id: true, name: true, timezone: true, active: true } } },
        });
        if (membership?.plant) return res.json({ ok: true, plant: membership.plant });
      }

      const plantId = await getUserDefaultPlantId(userId);
      if (!plantId) return res.status(404).json({ ok: false, error: "Sin plantas asignadas" });

      const plant = await prisma.plant.findUnique({
        where: { id: plantId },
        select: { id: true, name: true, timezone: true, active: true },
      });

      return res.json({ ok: true, plant });
    } catch (e) {
      console.error("GET /plants/current error:", e);
      return res.status(500).json({ ok: false, error: "Error obteniendo planta actual" });
    }
  });

  // POST /api/plants (ADMIN)
  router.post("/plants", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const { name, timezone } = req.body || {};
      const cleanName = String(name || "").trim();

      if (!cleanName) return res.status(400).json({ ok: false, error: "Nombre de planta requerido" });

      const tz = String(timezone || "America/Mexico_City").trim();

      const userId = req.user.id;

      // Crear planta y membresía en transacción
      const result = await prisma.$transaction(async (tx) => {
        const plant = await tx.plant.create({
          data: { name: cleanName, timezone: tz, active: true },
        });

        // Si el usuario no tiene default, haz esta default automáticamente
        const existingDefault = await tx.userPlant.findFirst({
          where: { userId, isDefault: true, active: true },
          select: { id: true },
        });

        await tx.userPlant.create({
          data: {
            userId,
            plantId: plant.id,
            isDefault: !existingDefault,
            active: true,
          },
        });

        return plant;
      });

      return res.status(201).json({ ok: true, plant: result });
    } catch (e) {
      console.error("POST /plants error:", e);
      return res.status(500).json({ ok: false, error: "Error creando planta" });
    }
  });

  // POST /api/plants/:id/default
  router.post("/plants/:id/default", auth, async (req, res) => {
    try {
      const userId = req.user.id;
      const plantId = toInt(req.params.id);

      if (!plantId) return res.status(400).json({ ok: false, error: "plantId inválido" });

      const membership = await prisma.userPlant.findUnique({
        where: { userId_plantId: { userId, plantId } },
        select: { id: true, active: true },
      });

      if (!membership?.active) return res.status(403).json({ ok: false, error: "PLANT_FORBIDDEN" });

      await prisma.$transaction([
        prisma.userPlant.updateMany({ where: { userId }, data: { isDefault: false } }),
        prisma.userPlant.update({ where: { id: membership.id }, data: { isDefault: true } }),
      ]);

      return res.json({ ok: true });
    } catch (e) {
      console.error("POST /plants/:id/default error:", e);
      return res.status(500).json({ ok: false, error: "Error cambiando planta default" });
    }
  });

  // PATCH /api/plants/:id (renombrar) [ADMIN]
  router.patch("/plants/:id", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = toInt(req.params.id);
      const { name, timezone, active } = req.body || {};

      if (!plantId) return res.status(400).json({ ok: false, error: "plantId inválido" });

      const data = {};
      if (name != null) {
        const cleanName = String(name).trim();
        if (!cleanName) return res.status(400).json({ ok: false, error: "Nombre inválido" });
        data.name = cleanName;
      }
      if (timezone != null) data.timezone = String(timezone).trim() || "America/Mexico_City";
      if (active != null) data.active = Boolean(active);

      const plant = await prisma.plant.update({
        where: { id: plantId },
        data,
        select: { id: true, name: true, timezone: true, active: true },
      });

      return res.json({ ok: true, plant });
    } catch (e) {
      console.error("PATCH /plants/:id error:", e);
      return res.status(500).json({ ok: false, error: "Error actualizando planta" });
    }
  });

  return router;
}