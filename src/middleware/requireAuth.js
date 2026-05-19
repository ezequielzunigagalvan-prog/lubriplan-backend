import jwt from "jsonwebtoken";
import prisma from "../prisma.js";

export async function requireAuth(req, res, next) {
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
      return res.status(401).json({ error: "Token requerido" });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      console.log("[requireAuth] JWT VERIFY FAIL", { method: req.method, url: req.originalUrl, msg: e.message });
      return res.status(401).json({ error: "Token inválido" });
    }

    const userId = Number(payload.sub);
    if (!Number.isFinite(userId)) {
      return res.status(401).json({ error: "Token inválido" });
    }

    const rawPlantId = req.headers["x-plant-id"];
    const parsedPlantId =
      rawPlantId == null || String(rawPlantId).trim() === ""
        ? null
        : Number(rawPlantId);

    if (rawPlantId != null && !Number.isFinite(parsedPlantId)) {
      return res.status(400).json({ error: "PLANT_INVALID" });
    }

    // Single round-trip: user + plant membership in parallel
    const plantQuery =
      parsedPlantId != null
        ? prisma.userPlant.findUnique({
            where: { userId_plantId: { userId, plantId: parsedPlantId } },
            select: { active: true },
          })
        : prisma.userPlant.findFirst({
            where: { userId, active: true },
            orderBy: [{ isDefault: "desc" }, { plantId: "asc" }],
            select: { plantId: true },
          });

    const [dbUser, plantResult] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, active: true, technicianId: true },
      }),
      plantQuery,
    ]);

    if (!dbUser || dbUser.active === false) {
      console.log("[requireAuth] USER INACTIVE/NOT FOUND", { userId });
      return res.status(401).json({ error: "Usuario inválido/inactivo" });
    }

    req.user = {
      id: dbUser.id,
      role: dbUser.role,
      technicianId: dbUser.technicianId ?? null,
    };

    let currentPlantId = parsedPlantId;

    if (parsedPlantId != null) {
      if (!plantResult || plantResult.active === false) {
        return res.status(403).json({ error: "PLANT_FORBIDDEN" });
      }
    } else {
      currentPlantId = plantResult?.plantId ?? null;
    }

    req.currentPlantId = currentPlantId ?? null;
    return next();
  } catch (err) {
    console.error("[requireAuth] ERROR", err);
    return res.status(401).json({ error: "Token inválido" });
  }
}
