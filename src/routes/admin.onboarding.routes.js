import express from "express";
import { hashPassword } from "../utils/password.js";

const DEFAULT_TIMEZONE = "America/Mexico_City";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function toOptionalBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat("es-MX", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function toIntInRange(value, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.trunc(parsed);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function isValidEmailList(value) {
  if (!value) return true;
  const emails = value.split(",").map((e) => e.trim()).filter(Boolean);
  return emails.length > 0 && emails.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

export default function adminOnboardingRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  router.post(
    "/onboarding-client",
    auth,
    requireRole(["ADMIN"]),
    async (req, res) => {
      try {
        const plantName = normalizeText(req.body?.plantName);
        const timezoneRaw = normalizeText(req.body?.timezone) || DEFAULT_TIMEZONE;
        const adminName = normalizeText(req.body?.adminName);
        const adminEmail = normalizeEmail(req.body?.adminEmail);
        const adminPassword = String(req.body?.adminPassword || "");
        const monthlyReportEnabled = toOptionalBool(req.body?.monthlyReportEnabled, true);
        const monthlyReportDay = toIntInRange(req.body?.monthlyReportDay, 1, 28, 1);
        const monthlyReportHour = toIntInRange(req.body?.monthlyReportHour, 0, 23, 8);
        const monthlyReportRecipientsExtra =
          normalizeText(req.body?.monthlyReportRecipientsExtra) || null;
        const linkRequesterToPlant = toOptionalBool(req.body?.linkRequesterToPlant, true);
        const createBaseArea = toOptionalBool(req.body?.createBaseArea, false);
        const baseAreaName = normalizeText(req.body?.baseAreaName) || "General";

        if (!plantName) {
          return res.status(400).json({ error: "plantName es obligatorio" });
        }

        if (!adminName || !adminEmail || !adminPassword) {
          return res.status(400).json({
            error: "adminName, adminEmail y adminPassword son obligatorios",
          });
        }

        if (adminPassword.length < 8) {
          return res.status(400).json({
            error: "La password temporal debe tener al menos 8 caracteres",
          });
        }

        if (!isValidTimeZone(timezoneRaw)) {
          return res.status(400).json({ error: "Timezone inválida" });
        }

        if (monthlyReportDay == null) {
          return res.status(400).json({ error: "monthlyReportDay debe estar entre 1 y 28" });
        }

        if (monthlyReportHour == null) {
          return res.status(400).json({ error: "monthlyReportHour debe estar entre 0 y 23" });
        }

        if (monthlyReportRecipientsExtra && !isValidEmailList(monthlyReportRecipientsExtra)) {
          return res.status(400).json({
            error: "monthlyReportRecipientsExtra contiene emails inválidos",
          });
        }

        const existingUser = await prisma.user.findUnique({
          where: { email: adminEmail },
          select: { id: true },
        });

        if (existingUser) {
          return res.status(409).json({ error: "Ya existe un usuario con ese correo" });
        }

        const requesterId = Number(req.user?.id || 0) || null;

        const result = await prisma.$transaction(async (tx) => {
          const plant = await tx.plant.create({
            data: {
              name: plantName,
              timezone: timezoneRaw,
              active: true,
              monthlyReportEnabled,
              monthlyReportDay,
              monthlyReportHour,
              monthlyReportRecipientsExtra,
            },
            select: {
              id: true,
              name: true,
              timezone: true,
              active: true,
              monthlyReportEnabled: true,
              monthlyReportDay: true,
              monthlyReportHour: true,
              monthlyReportRecipientsExtra: true,
            },
          });

          let baseArea = null;
          if (createBaseArea) {
            baseArea = await tx.equipmentArea.create({
              data: {
                plantId: plant.id,
                name: baseAreaName,
                description: "Area base creada durante onboarding",
              },
              select: { id: true, name: true },
            });
          }

          const passwordHash = await hashPassword(adminPassword);

          const user = await tx.user.create({
            data: {
              name: adminName,
              email: adminEmail,
              passwordHash,
              role: "ADMIN",
              active: true,
            },
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              active: true,
            },
          });

          await tx.userPlant.create({
            data: {
              userId: user.id,
              plantId: plant.id,
              isDefault: true,
              active: true,
            },
          });

          let requesterLinked = false;
          if (linkRequesterToPlant && requesterId && requesterId !== user.id) {
            const requesterHasDefault = await tx.userPlant.findFirst({
              where: { userId: requesterId, active: true, isDefault: true },
              select: { id: true },
            });

            await tx.userPlant.create({
              data: {
                userId: requesterId,
                plantId: plant.id,
                isDefault: !requesterHasDefault,
                active: true,
              },
            });
            requesterLinked = true;
          }

          return { plant, user, baseArea, requesterLinked };
        });

        return res.status(201).json({
          ok: true,
          plant: result.plant,
          user: result.user,
          baseArea: result.baseArea,
          requesterLinked: result.requesterLinked,
        });
      } catch (error) {
        console.error("POST /api/admin/onboarding-client error:", error);
        return res.status(500).json({
          error: error?.message || "Error creando el onboarding del cliente",
        });
      }
    }
  );

  return router;
}
