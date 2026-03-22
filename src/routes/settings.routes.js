// src/routes/settings.routes.js
import express from "express";

export default function settingsRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  const ensureRow = async () => {
    return prisma.appSettings.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });
  };

  // GET /api/settings
  router.get("/settings", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const settings = await ensureRow();
      return res.json({ ok: true, settings });
    } catch (e) {
      console.error("GET /settings error:", e);
      return res.status(500).json({ error: "Error cargando settings" });
    }
  });

  // PATCH /api/settings
  router.patch("/settings", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      await ensureRow();

      const allowed = {
        executionEvidenceRequired: "boolean",
        preventNegativeStock: "boolean",
        lowStockWarningEnabled: "boolean",

        // ✅ nuevos switches simples
        technicianOverloadEnabled: "boolean",
        predictiveAlertsEnabled: "boolean",
        aiSummaryEnabled: "boolean",

        // avanzados
        overloadWindowDays: "int",
        overloadOverdueLookbackDays: "int",
        overloadCapacityPerDay: "int",
        overloadWarnRatio: "float",
        overloadCriticalRatio: "float",
      };

      const data = {};

      for (const [k, type] of Object.entries(allowed)) {
        if (req.body?.[k] === undefined) continue;

        const v = req.body[k];

        if (type === "boolean") {
          if (typeof v !== "boolean") {
            return res.status(400).json({ error: `${k} debe ser boolean` });
          }
          data[k] = v;
          continue;
        }

        if (type === "int") {
          const n = Number(v);
          if (!Number.isFinite(n)) {
            return res.status(400).json({ error: `${k} debe ser number` });
          }
          data[k] = Math.trunc(n);
          continue;
        }

        if (type === "float") {
          const n = Number(v);
          if (!Number.isFinite(n)) {
            return res.status(400).json({ error: `${k} debe ser number` });
          }
          data[k] = n;
        }
      }

      // validación lógica
      if (
        data.overloadWarnRatio !== undefined &&
        data.overloadCriticalRatio !== undefined &&
        Number(data.overloadWarnRatio) >= Number(data.overloadCriticalRatio)
      ) {
        return res.status(400).json({
          error: "overloadWarnRatio debe ser menor que overloadCriticalRatio",
        });
      }

      const settings = await prisma.appSettings.update({
        where: { id: 1 },
        data,
      });

      return res.json({ ok: true, settings });
    } catch (e) {
      console.error("PATCH /settings error:", e);
      return res.status(500).json({ error: "Error guardando settings" });
    }
  });

  return router;
}