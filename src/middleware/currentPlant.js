export async function attachCurrentPlant(req, res, next) {
  try {
    const prisma = req.app.locals.prisma;

    const raw =
      req.headers["x-plant-id"] ||
      req.headers["X-Plant-Id"] ||
      req.query.plantId;

    const headerPlantId = raw ? Number(raw) : null;

    // 1) si viene por header/query, úsalo
    if (Number.isFinite(headerPlantId) && headerPlantId > 0) {
      req.currentPlantId = headerPlantId;
      return next();
    }

    // 2) si no hay usuario autenticado todavía, no fuerces nada
    if (!req.user?.id || !prisma) {
      req.currentPlantId = null;
      return next();
    }

    // 3) buscar planta default activa del usuario
    const membership =
      await prisma.userPlant.findFirst({
        where: {
          userId: req.user.id,
          active: true,
        },
        orderBy: [
          { isDefault: "desc" },
          { createdAt: "asc" },
        ],
        select: {
          plantId: true,
        },
      });

    req.currentPlantId = membership?.plantId ?? null;
    return next();
  } catch (e) {
    console.error("attachCurrentPlant error:", e);
    return res.status(500).json({ error: "Error leyendo plantId" });
  }
}

export function requirePlant(req, res, next) {
  if (!req.currentPlantId) {
    return res.status(400).json({ error: "PLANT_REQUIRED" });
  }
  next();
}