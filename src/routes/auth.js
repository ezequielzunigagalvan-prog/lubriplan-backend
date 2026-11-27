import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import prisma from "../prisma.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { logger } from "../config/logger.js";
import { validate } from "../middleware/validate.js";
import { loginSchema, setPasswordSchema } from "../schemas/index.js";
import { createResetToken, verifyResetToken, sendResetEmail } from "../services/auth/passwordReset.js";
import { resolveTechnicianId } from "../services/technicianProfile.js";

const router = express.Router();

// Rate limiter por email (previene ataques contra cuenta específica)
const loginRateLimiterByEmail = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.email?.toLowerCase() || ipKeyGenerator(req),
  message: { error: "Demasiados intentos. Intenta nuevamente en 15 minutos." },
});

// Rate limiter por IP (previene ataques distribuidos)
const loginRateLimiterByIP = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // máximo 20 intentos por IP en 15 minutos (más permisivo que por email)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  skip: (req) => !req.ip, // si no hay IP, no limitar
  message: { error: "Demasiadas solicitudes desde esta IP. Intenta nuevamente en 15 minutos." },
});

// Combinar ambos limitadores
const loginRateLimiter = [loginRateLimiterByIP, loginRateLimiterByEmail];

// ===== SET PASSWORD (ADMIN ONLY) =====
router.post("/set-password", requireAuth, requireRole(["ADMIN"]), validate(setPasswordSchema), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email y password requeridos" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
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
    logger.error(e);
    return res.status(500).json({ error: "Error set-password" });
  }
});

/**
 * @swagger
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Iniciar sesión
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 1
 *     responses:
 *       200:
 *         description: Login exitoso — devuelve JWT y lista de plantas
 *       401:
 *         description: Credenciales inválidas
 *       429:
 *         description: Demasiados intentos
 */
// ===== LOGIN (PUBLIC) =====
router.post("/login", loginRateLimiter, validate(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email y password requeridos" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      // include: { technician: true }, // Temporarily disabled - technician table not yet populated
    });

    if (!user) return res.status(401).json({ error: "Credenciales inválidas" });
    if (!user.active) return res.status(403).json({ error: "Usuario inactivo" });
    if (!user.passwordHash) return res.status(403).json({ error: "Usuario sin contraseña" });

    const ok = await bcrypt.compare(password, user.passwordHash);
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
    // Técnico multiplanta: su perfil en la planta con la que entra.
    const loginTechnicianId =
      String(user.role).toUpperCase() === "TECHNICIAN" && defaultPlantId
        ? await resolveTechnicianId(prisma, { userId: user.id, homeTechnicianId: user.technicianId ?? null, plantId: defaultPlantId })
        : user.technicianId ?? null;

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
        isPlatformOwner: user.isPlatformOwner === true,
        technicianId: loginTechnicianId,
        technician: user.technician,
      },
      plants,
      defaultPlantId,
    });
  } catch (e) {
    logger.error("login error:", e);
    return res.status(500).json({ error: "Error en login" });
  }
});

// ===== RECUPERACIÓN DE CONTRASEÑA (PÚBLICO) =====
const forgotLimiter = [
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKeyGenerator,
    message: { error: "Demasiadas solicitudes. Intenta nuevamente en 15 minutos." },
  }),
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.body?.email || "").trim().toLowerCase() || ipKeyGenerator(req),
    message: { error: "Demasiadas solicitudes para este correo. Intenta más tarde." },
  }),
];

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  message: { error: "Demasiados intentos. Intenta nuevamente en 15 minutos." },
});

const FORGOT_REPLY = {
  ok: true,
  message: "Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña.",
};

// POST /api/auth/forgot-password { email }
// Siempre responde lo mismo, exista o no el correo, para no revelar qué cuentas existen.
router.post("/forgot-password", forgotLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Ingresa un correo válido." });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, active: true, passwordHash: true },
    });

    if (user && user.active !== false) {
      const token = createResetToken(user);
      // Sin await: la respuesta tarda lo mismo exista o no la cuenta.
      sendResetEmail(user, token)
        .then((r) => {
          if (!r?.ok) logger.warn("[auth] Correo de recuperación no enviado", { userId: user.id, reason: r?.reason });
        })
        .catch((e) => logger.error("[auth] Error enviando correo de recuperación", { userId: user.id, msg: e?.message }));
    }

    return res.json(FORGOT_REPLY);
  } catch (e) {
    logger.error("forgot-password error:", e);
    return res.json(FORGOT_REPLY);
  }
});

// POST /api/auth/reset-password/check { token } — para avisar antes de escribir si el enlace ya no sirve
router.post("/reset-password/check", resetLimiter, async (req, res) => {
  const user = await verifyResetToken(prisma, req.body?.token).catch(() => null);
  if (!user) return res.status(400).json({ ok: false, error: "El enlace no es válido o ya venció. Solicita uno nuevo." });
  return res.json({ ok: true, email: user.email });
});

// POST /api/auth/reset-password { token, password }
router.post("/reset-password", resetLimiter, async (req, res) => {
  try {
    const password = String(req.body?.password || "");
    if (password.length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    }
    if (password.length > 128) {
      return res.status(400).json({ error: "La contraseña es demasiado larga." });
    }

    const user = await verifyResetToken(prisma, req.body?.token);
    if (!user) {
      return res.status(400).json({ error: "El enlace no es válido o ya venció. Solicita uno nuevo." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    logger.info("[auth] Contraseña restablecida por enlace", { userId: user.id });

    return res.json({ ok: true });
  } catch (e) {
    logger.error("reset-password error:", e);
    return res.status(500).json({ error: "No se pudo restablecer la contraseña." });
  }
});

// GET /api/auth/me — datos del usuario para la planta activa.
// Para técnicos, technicianId es su perfil en ESA planta (pueden trabajar en varias).
router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true, role: true, isPlatformOwner: true },
    });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
    const technicianId = req.user.technicianId ?? null;
    const technician = technicianId
      ? await prisma.technician.findFirst({ where: { id: technicianId, plantId: { gt: 0 } }, select: { id: true, name: true, code: true, plantId: true } })
      : null;
    return res.json({ ok: true, user: { ...user, technicianId, technician }, plantId: req.currentPlantId ?? null });
  } catch (e) {
    logger.error("GET /auth/me error:", e);
    return res.status(500).json({ error: "Error obteniendo el usuario" });
  }
});

export default router;
