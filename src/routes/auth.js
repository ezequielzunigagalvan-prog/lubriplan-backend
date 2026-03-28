import express from "express";
import prisma from "../prisma.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/requireAuth.js"; // 👈 ajusta ruta si aplica
import { requireRole } from "../middleware/requireRole.js"; // 👈 ajusta ruta si aplica

const router = express.Router();

// ===== SET PASSWORD (ADMIN ONLY) =====
router.post("/set-password", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email y password requeridos" });
    }

    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) return res.status(404).json({ error: "Usuario no existe" });

    const hash = await bcrypt.hash(password, 10);

    const updated = await prisma.user.update({
      where: { email: email.trim().toLowerCase() },
      data: { passwordHash: hash },
      select: { id: true, email: true, role: true, active: true },
    });

    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error set-password" });
  }
});

// ===== LOGIN (PUBLIC) =====
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email y password requeridos" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { technician: true },
    });

    if (!user) return res.status(401).json({ error: "Credenciales inválidas" });
    if (!user.active) return res.status(403).json({ error: "Usuario inactivo" });
    if (!user.passwordHash) return res.status(403).json({ error: "Usuario sin contraseña" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    console.log("BCRYPT MATCH:", ok);

    if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

    const userPlants = await prisma.userPlant.findMany({
      where: { userId: user.id, active: true },
      select: {
        plantId: true,
        isDefault: true,
        plant: {
          select: { id: true, name: true, timezone: true, active: true, createdAt: true },
        },
      },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });

    const plants = userPlants.map((r) => ({
      ...r.plant,
      isDefault: r.isDefault,
    }));

    const defaultPlantId = plants.find((p) => p.isDefault)?.id ?? plants[0]?.id ?? null;

    const token = jwt.sign(
      {
        sub: user.id,
        role: user.role,
        technicianId: user.technicianId ?? null,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "16h" }
    );

    return res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        technicianId: user.technicianId,
        technician: user.technician,
      },
      plants,
      defaultPlantId,
    });
  } catch (e) {
    console.error("login error:", e);
    return res.status(500).json({ error: "Error en login" });
  }
});

export default router;
