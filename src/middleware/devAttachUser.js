// src/middleware/devAttachUser.js
import prisma from "../prisma.js";

export async function devAttachUser(req, res, next) {
  try {
    if (req.user) return next();

    // si viene JWT, no simular
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) return next();

    const userIdRaw = req.header("x-user-id") || req.header("X-User-Id");
    const userId =
      userIdRaw != null && String(userIdRaw).trim() !== "" ? Number(userIdRaw) : null;

    const finalUserId = Number.isFinite(userId) ? userId : 1;

    const dbUser = await prisma.user.findUnique({
      where: { id: finalUserId },
      select: { id: true, role: true, active: true, technicianId: true },
    });

    if (!dbUser || dbUser.active === false) {
      return res.status(401).json({ error: "Usuario inválido/inactivo (DEV)" });
    }

    req.user = {
      id: dbUser.id,
      role: dbUser.role,
      technicianId: dbUser.technicianId ?? null,
    };

    return next();
  } catch (e) {
    console.error("devAttachUser error:", e);
    return res.status(500).json({ error: "Error attach user (DEV)" });
  }
}