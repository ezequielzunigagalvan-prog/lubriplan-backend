import jwt from "jsonwebtoken";
import prisma from "../prisma.js";

export async function requireAuth(req, res, next) {
  const t0 = Date.now();
  const stamp = () => `(+${Date.now() - t0}ms)`;

  try {
    if (req.method === "OPTIONS") return res.sendStatus(204);

    const auth = req.headers.authorization || "";
    let token = null;

    if (auth.startsWith("Bearer ")) {
      token = auth.slice("Bearer ".length).trim();
    }

    if (!token && req.headers.cookie) {
      const m = req.headers.cookie.match(/(?:^|;\s*)token=([^;]+)/);
      if (m) token = decodeURIComponent(m[1]);
    }

    if (!token) {
      console.log("[requireAuth] NO TOKEN", {
        method: req.method,
        url: req.originalUrl,
        origin: req.headers.origin,
      }, stamp());
      return res.status(401).json({ error: "Token requerido" });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      console.log("[requireAuth] JWT VERIFY FAIL", {
        method: req.method,
        url: req.originalUrl,
        msg: e.message,
      }, stamp());
      return res.status(401).json({ error: "Token inválido" });
    }

    const userId = Number(payload.sub);
    if (!Number.isFinite(userId)) {
      console.log("[requireAuth] INVALID SUB", { sub: payload.sub }, stamp());
      return res.status(401).json({ error: "Token inválido" });
    }

    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        active: true,
        technicianId: true,
      },
    });

    if (!dbUser || dbUser.active === false) {
      console.log("[requireAuth] USER INACTIVE/NOT FOUND", { userId }, stamp());
      return res.status(401).json({ error: "Usuario inválido/inactivo" });
    }

    req.user = {
      id: dbUser.id,
      role: dbUser.role,
      technicianId: dbUser.technicianId ?? null,
    };

    // =========================
    // MULTIPLANTA
    // =========================
    const rawPlantId = req.headers["x-plant-id"];
    const parsedPlantId =
      rawPlantId == null || String(rawPlantId).trim() === ""
        ? null
        : Number(rawPlantId);

    if (rawPlantId != null && !Number.isFinite(parsedPlantId)) {
      return res.status(400).json({ error: "PLANT_INVALID" });
    }

    let currentPlantId = parsedPlantId;

    if (currentPlantId) {
      const membership = await prisma.userPlant.findUnique({
        where: {
          userId_plantId: {
            userId: dbUser.id,
            plantId: currentPlantId,
          },
        },
        select: {
          active: true,
        },
      });

      if (!membership || membership.active === false) {
        return res.status(403).json({ error: "PLANT_FORBIDDEN" });
      }
    }

    // si no viene header, intentar obtener planta default activa del usuario
    if (!currentPlantId) {
      const defaultMembership = await prisma.userPlant.findFirst({
        where: {
          userId: dbUser.id,
          active: true,
        },
        orderBy: [{ isDefault: "desc" }, { plantId: "asc" }],
        select: {
          plantId: true,
        },
      });

      currentPlantId = defaultMembership?.plantId ?? null;
    }

    req.currentPlantId = currentPlantId ?? null;

    return next();
  } catch (err) {
    console.error("[requireAuth] ERROR", err);
    return res.status(401).json({ error: "Token inválido" });
  }
}
