import express from "express";
import { hashPassword } from "../utils/password.js";

const DEFAULT_TIMEZONE = "America/Mexico_City";
const GLOBAL_SETTINGS_SCHEMA = {
  executionEvidenceRequired: "boolean",
  preventNegativeStock: "boolean",
  lowStockWarningEnabled: "boolean",
  technicianOverloadEnabled: "boolean",
  predictiveAlertsEnabled: "boolean",
  aiSummaryEnabled: "boolean",
  criticalActivityEmailEnabled: "boolean",
  conditionReportEmailEnabled: "boolean",
  overdueSummaryEmailEnabled: "boolean",
  monthlyReportEmailEnabled: "boolean",
  overloadWindowDays: "int",
  overloadOverdueLookbackDays: "int",
  overloadCapacityPerDay: "int",
  overloadWarnRatio: "float",
  overloadCriticalRatio: "float",
};

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

function pickGlobalSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const data = {};

  for (const [key, type] of Object.entries(GLOBAL_SETTINGS_SCHEMA)) {
    if (source[key] === undefined) continue;
    const value = source[key];

    if (type === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`${key} debe ser boolean`);
      }
      data[key] = value;
      continue;
    }

    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`${key} debe ser number`);
    }

    data[key] = type === "int" ? Math.trunc(num) : num;
  }

  if (
    data.overloadWarnRatio !== undefined &&
    data.overloadCriticalRatio !== undefined &&
    Number(data.overloadWarnRatio) >= Number(data.overloadCriticalRatio)
  ) {
    throw new Error("overloadWarnRatio debe ser menor que overloadCriticalRatio");
  }

  return data;
}

export default function adminOnboardingRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  router.post(
    "/onboarding-client",
    auth,
    requireRole(["ADMIN"]),
    async (req, res) => {
      try {
        const companyName = normalizeText(req.body?.companyName);
        const plantNameRaw = normalizeText(req.body?.plantName);
        const plantName = plantNameRaw || companyName;
        const timezoneRaw = normalizeText(req.body?.timezone) || DEFAULT_TIMEZONE;
        const adminName = normalizeText(req.body?.adminName);
        const adminEmail = normalizeEmail(req.body?.adminEmail);
        const adminPassword = String(req.body?.adminPassword || "");
        const monthlyReportEnabled = toOptionalBool(
          req.body?.monthlyReportEnabled,
          true
        );
        const monthlyReportDay = toIntInRange(
          req.body?.monthlyReportDay,
          1,
          28,
          1
        );
        const monthlyReportHour = toIntInRange(
          req.body?.monthlyReportHour,
          0,
          23,
          8
        );
        const monthlyReportRecipientsExtra =
          normalizeText(req.body?.monthlyReportRecipientsExtra) || null;
        const applyGlobalSettings = toOptionalBool(
          req.body?.applyGlobalSettings,
          false
        );
        const linkRequesterToPlant = toOptionalBool(
          req.body?.linkRequesterToPlant,
          true
        );
        const createBaseArea = toOptionalBool(req.body?.createBaseArea, false);
        const baseAreaName = normalizeText(req.body?.baseAreaName) || "General";

        if (!plantName) {
          return res.status(400).json({
            error: "plantName o companyName es obligatorio",
          });
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
          return res.status(400).json({ error: "Timezone invalida" });
        }

        if (monthlyReportDay == null) {
          return res
            .status(400)
            .json({ error: "monthlyReportDay debe estar entre 1 y 28" });
        }

        if (monthlyReportHour == null) {
          return res
            .status(400)
            .json({ error: "monthlyReportHour debe estar entre 0 y 23" });
        }

        const existingUser = await prisma.user.findUnique({
          where: { email: adminEmail },
          select: { id: true },
        });

        if (existingUser) {
          return res.status(409).json({
            error: "Ya existe un usuario con ese correo",
          });
        }

        let globalSettingsData = {};
        if (applyGlobalSettings) {
          globalSettingsData = pickGlobalSettings(req.body?.settings);
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
              where: {
                userId: requesterId,
                active: true,
                isDefault: true,
              },
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

          let settings = null;
          if (applyGlobalSettings && Object.keys(globalSettingsData).length > 0) {
            settings = await tx.appSettings.upsert({
              where: { id: 1 },
              create: { id: 1, ...globalSettingsData },
              update: globalSettingsData,
            });
          }

          return {
            plant,
            user,
            baseArea,
            settingsApplied: Boolean(settings),
            requesterLinked,
          };
        });

        return res.status(201).json({
          ok: true,
          companyName: companyName || null,
          plant: result.plant,
          user: result.user,
          baseArea: result.baseArea,
          settingsApplied: result.settingsApplied,
          settingsSkipped:
            !applyGlobalSettings ||
            Object.keys(globalSettingsData).length === 0,
          requesterLinked: result.requesterLinked,
          note:
            "Los ajustes avanzados siguen siendo globales en la version actual.",
        });
      } catch (error) {
        console.error("POST /api/admin/onboarding-client error:", error);
        return res.status(500).json({
          error:
            error?.message || "Error creando el onboarding del cliente",
        });
      }
    }
  );

  return router;
}
