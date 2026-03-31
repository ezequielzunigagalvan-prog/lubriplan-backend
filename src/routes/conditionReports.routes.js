// src/routes/conditionReports.routes.js
import express from "express";
import multer from "multer";
import path from "path";

import { notifyManagers } from "../notifications/notify.js";
import { sseHub } from "../realtime/sseHub.js";
import { sendConditionAlertEmail } from "../services/email/email.service.js";

// =========================
// Multer config
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/condition-reports"),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || ".jpg").toLowerCase();
    cb(null, `cr_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`);
  },
});

const upload = multer({ storage });

// helpers
const up = (v) => String(v || "").trim().toUpperCase();

const normCondition = (v) => {
  const s = up(v);
  if (s === "CR?TICO") return "CRITICO";
  return s;
};

export default function conditionReportsRoutes({ prisma, auth }) {
  if (!prisma) throw new Error("conditionReportsRoutes: prisma is required");
  if (typeof auth !== "function") {
    throw new Error("conditionReportsRoutes: 'auth' middleware is required (pass requireAuth).");
  }

  const router = express.Router();

  // =========================
  // GET /condition-reports
  // ADMIN/SUP: todos de la planta actual
  // TECH: solo los suyos de la planta actual
  // =========================
  router.get("/condition-reports", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const role = up(req.user?.role || "");
      const isTech = role === "TECHNICIAN";

      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : null;
      const status = req.query.status ? up(req.query.status) : null;
      const equipmentId = req.query.equipmentId ? Number(req.query.equipmentId) : null;

      const where = {
        plantId,
      };

      if (isTech) where.reportedById = req.user.id;
      if (Number.isFinite(equipmentId)) where.equipmentId = equipmentId;
      if (status) where.status = status;

      if (from || to) {
        where.detectedAt = {};
        if (from) where.detectedAt.gte = new Date(from);
        if (to) where.detectedAt.lte = new Date(to);
      }

      const items = await prisma.conditionReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: {
          plant: true,
          equipment: {
            include: {
              area: true,
            },
          },
          reportedBy: { select: { id: true, name: true, role: true, email: true } },
          correctiveExecution: true,
        },
      });

      return res.json({ items });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Error listando reportes" });
    }
  });

  // =========================
  // POST /condition-reports (multipart/form-data)
  // fields: equipmentId, condition, category?, description, detectedAt, evidence(file)
  // =========================
  router.post("/condition-reports", auth, upload.single("evidence"), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "No autenticado" });

      const equipmentId = Number(req.body.equipmentId);
      const condition = normCondition(req.body.condition);
      const category = req.body.category ? up(req.body.category) : null;
      const description = String(req.body.description || "").trim();
      const detectedAt = String(req.body.detectedAt || "").trim();

      if (!Number.isFinite(equipmentId) || equipmentId <= 0) {
        return res.status(400).json({ error: "Falta equipmentId" });
      }
      if (!description) return res.status(400).json({ error: "Falta description" });
      if (!detectedAt) return res.status(400).json({ error: "Falta detectedAt" });

      const validConditions = ["BUENO", "REGULAR", "MALO", "CRITICO"];
      if (!validConditions.includes(condition)) {
        return res.status(400).json({ error: "Condici?n inv?lida" });
      }

      const validCategories = ["FUGA", "RUIDO", "VIBRACION", "TEMPERATURA", "CONTAMINACION", "OTRO"];
      if (category && !validCategories.includes(category)) {
        return res.status(400).json({ error: "Categor?a inv?lida" });
      }

      const evidenceImage = req.file
        ? `/uploads/condition-reports/${req.file.filename}`
        : String(req.body?.evidenceImage || "").trim() || null;

      const eq = await prisma.equipment.findFirst({
        where: { id: equipmentId, plantId },
        include: {
          area: true,
          plant: true,
        },
      });

      if (!eq) {
        return res.status(404).json({ error: "Equipo no encontrado en la planta actual" });
      }

      const detectedAtDate = new Date(detectedAt);
      if (Number.isNaN(detectedAtDate.getTime())) {
        return res.status(400).json({ error: "detectedAt invalido" });
      }

      const item = await prisma.conditionReport.create({
        data: {
          plantId, // ? importante para multi-planta
          equipmentId,
          reportedById: userId,
          condition,
          category,
          description,
          detectedAt: detectedAtDate,
          evidenceImage,
          status: "OPEN",
        },
        include: {
          plant: true,
          equipment: {
            include: {
              area: true,
            },
          },
          reportedBy: { select: { id: true, name: true, email: true, role: true } },
          correctiveExecution: true,
        },
      });

      // Notifica managers en sistema
      await notifyManagers(prisma, {
        plantId,
        type: "CONDITION_REPORTED",
        title: "Condición anormal reportada",
        message: `${item.equipment?.name || "Equipo"}${
          item.equipment?.code ? ` (${item.equipment.code})` : ""
        } · ${item.condition}`,
        link: "/condition-reports?status=OPEN",
      });

      // Correo a admin/supervisor de la planta
      // no rompe el flujo principal si falla
      try {
        await sendConditionAlertEmail({
          prisma,
          payload: {
            plantId,
            plantName: item.plant?.name || eq.plant?.name || "Planta",
            reportId: item.id,
            equipmentName: item.equipment?.name || eq.name || "Equipo",
            equipmentCode: item.equipment?.code || eq.code || "",
            areaName:
              item.equipment?.area?.name ||
              eq.area?.name ||
              item.equipment?.location ||
              eq.location ||
              "—",
            reportedByName: item.reportedBy?.name || req.user?.name || "Usuario",
            severity: item.condition,
            category: item.category || "OTRO",
            description: item.description,
            observation: item.description,
            evidenceImage: item.evidenceImage,
            detectedAt: item.detectedAt,
            link: `${process.env.APP_BASE_URL || "http://localhost:5173"}/condition-reports?status=OPEN`,
          },
        });
      } catch (emailErr) {
        console.error("Error enviando correo de condición anormal:", emailErr);
      }

      // SSE
      sseHub.broadcast("condition-report.created", {
        plantId,
        reportId: item.id,
        equipmentId: item.equipmentId,
        condition: item.condition,
        status: item.status,
        detectedAt: item.detectedAt,
      });

      sseHub.broadcast("condition-report.status-updated", {
        plantId,
        reportId: item.id,
        equipmentId: item.equipmentId,
        status: item.status,
      });

      return res.json({ item });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Error creando reporte" });
    }
  });

  // =========================
  // POST /condition-reports/:id/dismiss
  // ADMIN/SUP
  // =========================
  router.post("/condition-reports/:id/dismiss", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const role = up(req.user?.role || "");
      const can = role === "ADMIN" || role === "SUPERVISOR";
      if (!can) return res.status(403).json({ error: "Sin permiso" });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const report = await prisma.conditionReport.findFirst({
        where: {
          id,
          plantId,
        },
        include: {
          plant: true,
          equipment: {
            include: {
              area: true,
            },
          },
        },
      });

      if (!report) return res.status(404).json({ error: "Reporte no encontrado" });

      if (report.status === "RESOLVED") {
        return res.status(400).json({ error: "No puedes descartar un reporte ya resuelto" });
      }

      if (report.status === "DISMISSED") {
        return res.status(400).json({ error: "Este reporte ya fue descartado" });
      }

      const updated = await prisma.conditionReport.update({
        where: { id },
        data: {
          status: "DISMISSED",
          dismissedAt: new Date(),
          dismissedById: req.user.id,
        },
        include: {
          plant: true,
          equipment: {
            include: {
              area: true,
            },
          },
        },
      });

      await notifyManagers(prisma, {
        plantId,
        type: "CONDITION_DISMISSED",
        title: "Reporte descartado",
        message: `${updated.equipment?.name || "Equipo"}${
          updated.equipment?.code ? ` (${updated.equipment.code})` : ""
        } · Reporte #${updated.id}`,
        link: "/condition-reports?status=DISMISSED",
      });

      sseHub.broadcast("condition-report.dismissed", {
        plantId,
        reportId: updated.id,
        equipmentId: updated.equipmentId,
        status: updated.status,
      });

      sseHub.broadcast("condition-report.status-updated", {
        plantId,
        reportId: updated.id,
        equipmentId: updated.equipmentId,
        status: updated.status,
      });

      return res.json({ item: updated });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Error descartando reporte" });
    }
  });

  // =========================
  // POST /condition-reports/:id/corrective-execution
  // ADMIN/SUP
  // crea SOLO ejecución manual, NO ruta
  // =========================
  router.post("/condition-reports/:id/corrective-execution", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const role = up(req.user?.role || "");
      const can = role === "ADMIN" || role === "SUPERVISOR";
      if (!can) return res.status(403).json({ error: "Sin permiso" });

      const reportId = Number(req.params.id);
      if (!Number.isFinite(reportId)) {
        return res.status(400).json({ error: "ID inválido" });
      }

      const { scheduledAt, technicianId, instructions } = req.body || {};

      if (!scheduledAt) {
        return res.status(400).json({ error: "scheduledAt es requerido" });
      }

      const sched = new Date(scheduledAt);
      if (Number.isNaN(sched.getTime())) {
        return res.status(400).json({ error: "scheduledAt inválido" });
      }

      const techId =
        technicianId != null && technicianId !== "" ? Number(technicianId) : null;

      if (techId != null && !Number.isFinite(techId)) {
        return res.status(400).json({ error: "technicianId inválido" });
      }

      if (techId != null) {
        const tech = await prisma.technician.findFirst({
          where: { id: techId, plantId, deletedAt: null },
          select: { id: true },
        });

        if (!tech) {
          return res.status(400).json({ error: "Técnico inválido" });
        }
      }

      const report = await prisma.conditionReport.findFirst({
        where: {
          id: reportId,
          plantId,
        },
        include: {
          plant: true,
          equipment: {
            include: {
              area: true,
            },
          },
        },
      });

      if (!report) {
        return res.status(404).json({ error: "Reporte no encontrado" });
      }

      if (report.status !== "OPEN") {
        return res
          .status(400)
          .json({ error: "Solo reportes OPEN pueden programar acción correctiva" });
      }

      if (report.correctiveExecutionId) {
        return res.status(400).json({
          error: "Este reporte ya tiene una acción correctiva ligada",
        });
      }

      const manualTitle = `Correctiva · ${report.equipment?.name || "Equipo"}${
        report.equipment?.code ? ` (${report.equipment.code})` : ""
      }`;

      const manualInstructions =
        String(instructions || "").trim() ||
        String(report.description || "").trim() ||
        "Acción correctiva por condición anormal";

      const result = await prisma.$transaction(async (tx) => {
        const execution = await tx.execution.create({
          data: {
            plantId,
            origin: "MANUAL",
            equipmentId: report.equipmentId,
            manualTitle,
            manualInstructions,
            scheduledAt: sched,
            technicianId: techId,
            status: "PENDING",
            observations: manualInstructions,
          },
          include: {
            route: { include: { equipment: true, lubricant: true } },
            technician: true,
            equipment: true,
          },
        });

        const updated = await tx.conditionReport.update({
          where: { id: reportId },
          data: {
            status: "IN_PROGRESS",
            correctiveExecutionId: execution.id,
            correctiveNotes: manualInstructions,
            correctiveScheduledAt: sched,
          },
          include: {
            plant: true,
            equipment: {
              include: {
                area: true,
              },
            },
            reportedBy: { select: { id: true, name: true, role: true } },
            correctiveExecution: true,
          },
        });

        // Si notifyManagers te soporta este type, déjalo.
        // Si no, cambia el type por CONDITION_REPORTED o el que ya manejes.
        await notifyManagers(tx, {
          plantId,
          type: "CONDITION_REPORTED",
          title: "Acción correctiva programada",
          message: `${updated.equipment?.name || "Equipo"}${
            updated.equipment?.code ? ` (${updated.equipment.code})` : ""
          } · Reporte #${updated.id} · Ejecución #${execution.id}`,
          link: "/condition-reports?status=IN_PROGRESS",
        });

        sseHub.broadcast("condition-report.corrective-scheduled", {
          plantId,
          reportId: updated.id,
          equipmentId: updated.equipmentId,
          equipmentName: updated.equipment?.name || null,
          equipmentCode: updated.equipment?.code || null,
          executionId: execution.id,
          scheduledAt: execution.scheduledAt,
          status: updated.status,
        });

        sseHub.broadcast("condition-report.status-updated", {
          plantId,
          reportId: updated.id,
          equipmentId: updated.equipmentId,
          status: updated.status,
        });

        return { report: updated, execution };
      });

      return res.json(result);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Error programando acción correctiva" });
    }
  });

  return router;
}
