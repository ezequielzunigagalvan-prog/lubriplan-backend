// src/routes/actionPlan.routes.js
// Plan de acción: pendientes de supervisores y administradores en 4 grupos
// (Lubricación, Seguridad, Predictivos, Auditoría), con avance en %, comentarios,
// evidencia, responsable y fecha de ejecución. Reglas en actionPlanRules.js.
import express from "express";
import multer from "multer";
import { logger } from "../config/logger.js";
import { uploadBufferToCloudinary, destroyCloudinaryImage } from "../lib/cloudinary.js";
import { notifyUser } from "../notifications/notify.js";
import { logAudit } from "../services/audit.service.js";
import { safeTimeZone, zonedYmd } from "../utils/tzRange.js";
import {
  CATEGORIES, ActionError, isAdmin, canView, canWork, statusFor, nextProgress, parseActionInput, isOverdue,
} from "./actionPlanRules.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"].includes(String(file.mimetype).toLowerCase());
    return ok ? cb(null, true) : cb(new ActionError("Formato no permitido: usa JPG, PNG, WebP o PDF"));
  },
});

const USER_MINI = { select: { id: true, name: true, email: true, role: true } };
const LIST_SELECT = {
  id: true, category: true, title: true, description: true, priority: true, status: true, progress: true,
  dueDate: true, closedAt: true, createdAt: true, updatedAt: true, ownerUserId: true, createdById: true, equipmentId: true,
  owner: USER_MINI,
  createdBy: USER_MINI,
  equipment: { select: { id: true, name: true, code: true } },
  _count: { select: { comments: true, evidence: true } },
};

export default function actionPlanRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();
  const managers = [auth, requireRole(["ADMIN", "SUPERVISOR"])];

  const plantToday = async (plantId) => {
    const plant = await prisma.plant.findFirst({ where: { id: plantId }, select: { timezone: true } });
    return zonedYmd(new Date(), safeTimeZone(plant?.timezone));
  };

  const fail = (res, e, label) => {
    if (e instanceof ActionError || e?.status) return res.status(e.status || 400).json({ error: e.message });
    logger.error(label, e);
    return res.status(500).json({ error: "No se pudo completar la operación" });
  };

  async function loadItem(req, id) {
    const item = await prisma.actionItem.findFirst({ where: { id, plantId: req.currentPlantId }, select: LIST_SELECT });
    if (!item) throw new ActionError("Pendiente no encontrado", 404);
    if (!canView(req.user, item)) throw new ActionError("Este pendiente no está asignado a ti", 403);
    return item;
  }

  async function assertAssignable(plantId, userId) {
    const u = await prisma.user.findFirst({
      where: { id: userId, active: true, role: { in: ["ADMIN", "SUPERVISOR"] }, userPlants: { some: { plantId, active: true } } },
      select: { id: true, name: true },
    });
    if (!u) throw new ActionError("El responsable debe ser un supervisor o administrador activo de esta planta");
    return u;
  }

  const decorate = (item, today) => ({ ...item, overdue: isOverdue(item, today) });

  // ── Lista y resumen por grupo ────────────────────────────────────────────
  router.get("/action-plan", ...managers, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
      const admin = isAdmin(req.user);
      const scope = admin && req.query.scope === "all" ? "all" : "mine";
      const ownerFilter = Number(req.query.ownerUserId) || null;
      const where = {
        plantId,
        ...(scope === "mine" ? { ownerUserId: req.user.id } : ownerFilter ? { ownerUserId: ownerFilter } : {}),
        ...(req.query.includeClosed === "1" ? {} : { status: { notIn: ["CANCELLED"] } }),
      };
      const today = await plantToday(plantId);
      const rows = await prisma.actionItem.findMany({ where, select: LIST_SELECT, orderBy: [{ dueDate: "asc" }, { id: "asc" }] });
      const items = rows.map((r) => decorate(r, today));

      const summary = Object.fromEntries(
        CATEGORIES.map((c) => {
          const list = items.filter((i) => i.category === c && i.status !== "CANCELLED");
          const open = list.filter((i) => i.status !== "DONE");
          return [c, {
            total: list.length,
            open: open.length,
            done: list.length - open.length,
            overdue: list.filter((i) => i.overdue).length,
            avgProgress: list.length ? Math.round(list.reduce((n, i) => n + i.progress, 0) / list.length) : null,
          }];
        })
      );
      return res.json({ ok: true, scope, today, items, summary });
    } catch (e) {
      return fail(res, e, "GET /action-plan");
    }
  });

  // ── Mis pendientes en todas mis plantas (acceso rápido de los dashboards) ──
  router.get("/action-plan/my-summary", ...managers, async (req, res) => {
    try {
      const links = await prisma.userPlant.findMany({
        where: { userId: req.user.id, active: true, plant: { active: true } },
        select: { plant: { select: { id: true, name: true, timezone: true } } },
      });
      const plants = links.map((l) => l.plant);
      const ids = plants.map((p) => p.id);
      const rows = ids.length
        ? await prisma.actionItem.findMany({
            where: { ownerUserId: req.user.id, plantId: { in: ids }, status: { notIn: ["DONE", "CANCELLED"] } },
            select: { id: true, title: true, category: true, priority: true, progress: true, dueDate: true, status: true, plantId: true },
            orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          })
        : [];
      const byId = new Map(plants.map((p) => [p.id, { ...p, today: zonedYmd(new Date(), safeTimeZone(p.timezone)) }]));
      const items = rows.map((r) => {
        const p = byId.get(r.plantId);
        const due = new Date(r.dueDate).toISOString().slice(0, 10);
        const daysLeft = Math.round((new Date(`${due}T12:00:00Z`) - new Date(`${p.today}T12:00:00Z`)) / 86_400_000);
        return { ...r, plantName: p?.name || "", overdue: isOverdue(r, p.today), daysLeft };
      });
      const byPlant = plants
        .map((p) => {
          const mine = items.filter((i) => i.plantId === p.id);
          return { plantId: p.id, name: p.name, open: mine.length, overdue: mine.filter((i) => i.overdue).length };
        })
        .filter((p) => p.open);
      return res.json({
        ok: true,
        total: items.length,
        overdue: items.filter((i) => i.overdue).length,
        dueSoon: items.filter((i) => !i.overdue && i.daysLeft <= 7).length,
        byPlant,
        // vencidos primero, luego por fecha compromiso
        items: [...items].sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.daysLeft - b.daysLeft).slice(0, 6),
      });
    } catch (e) {
      return fail(res, e, "GET /action-plan/my-summary");
    }
  });

  // Responsables posibles (admin)
  router.get("/action-plan/assignees", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const users = await prisma.user.findMany({
        where: { active: true, role: { in: ["ADMIN", "SUPERVISOR"] }, userPlants: { some: { plantId, active: true } } },
        select: { id: true, name: true, email: true, role: true },
        orderBy: [{ role: "desc" }, { name: "asc" }],
      });
      return res.json({ ok: true, items: users });
    } catch (e) {
      return fail(res, e, "GET /action-plan/assignees");
    }
  });

  // ── Detalle ──────────────────────────────────────────────────────────────
  router.get("/action-plan/:id", ...managers, async (req, res) => {
    try {
      const item = await loadItem(req, Number(req.params.id));
      const [comments, evidence, today] = await Promise.all([
        prisma.actionComment.findMany({ where: { actionId: item.id }, orderBy: { createdAt: "desc" }, include: { user: USER_MINI } }),
        prisma.actionEvidence.findMany({ where: { actionId: item.id }, orderBy: { createdAt: "desc" }, include: { user: USER_MINI } }),
        plantToday(req.currentPlantId),
      ]);
      return res.json({ ok: true, item: decorate(item, today), comments, evidence });
    } catch (e) {
      return fail(res, e, "GET /action-plan/:id");
    }
  });

  // ── Alta ─────────────────────────────────────────────────────────────────
  router.post("/action-plan", ...managers, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
      const data = parseActionInput(req.body, { user: req.user, today: await plantToday(plantId) });
      const owner = await assertAssignable(plantId, data.ownerUserId);
      if (data.equipmentId) {
        const eq = await prisma.equipment.findFirst({ where: { id: data.equipmentId, plantId }, select: { id: true } });
        if (!eq) throw new ActionError("El equipo no existe en esta planta");
      }
      const item = await prisma.actionItem.create({
        data: { ...data, plantId, createdById: req.user.id, status: "OPEN", progress: 0 },
        select: LIST_SELECT,
      });
      if (owner.id !== req.user.id) {
        notifyUser(prisma, owner.id, {
          plantId,
          type: "ACTION_ASSIGNED",
          title: "Nuevo pendiente asignado",
          message: `${item.title} · ejecutar a más tardar el ${item.dueDate.toISOString().slice(0, 10)}`,
          link: `/action-plan?item=${item.id}`,
        }).catch((err) => logger.error("notify action assigned", err));
      }
      return res.status(201).json({ ok: true, item });
    } catch (e) {
      return fail(res, e, "POST /action-plan");
    }
  });

  // ── Edición (admin: todo; responsable: título, descripción, prioridad, grupo, equipo) ──
  router.patch("/action-plan/:id", ...managers, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const item = await loadItem(req, Number(req.params.id));
      const admin = isAdmin(req.user);
      const data = parseActionInput(req.body, { user: req.user, existing: item, today: await plantToday(plantId) });

      // Cancelar / reabrir (solo admin)
      if (req.body.status !== undefined) {
        if (!admin) throw new ActionError("Solo un administrador puede cancelar o reabrir un pendiente", 403);
        const s = String(req.body.status).toUpperCase();
        if (s === "CANCELLED") data.status = "CANCELLED";
        else if (s === "REOPEN") {
          data.status = statusFor(item.progress >= 100 ? 90 : item.progress, "OPEN");
          if (item.progress >= 100) data.progress = 90;
          data.closedAt = null;
        } else throw new ActionError("Estado no válido");
      }
      if (data.ownerUserId && data.ownerUserId !== item.ownerUserId) await assertAssignable(plantId, data.ownerUserId);
      if (data.equipmentId) {
        const eq = await prisma.equipment.findFirst({ where: { id: data.equipmentId, plantId }, select: { id: true } });
        if (!eq) throw new ActionError("El equipo no existe en esta planta");
      }
      if (!Object.keys(data).length) throw new ActionError("No hay cambios");

      const updated = await prisma.actionItem.update({ where: { id: item.id }, data, select: LIST_SELECT });
      logAudit({ plantId, userId: req.user.id, action: "UPDATE", model: "ActionItem", recordId: item.id, changes: { after: req.body }, ip: req.ip });

      if (data.ownerUserId && data.ownerUserId !== item.ownerUserId && data.ownerUserId !== req.user.id) {
        notifyUser(prisma, data.ownerUserId, {
          plantId, type: "ACTION_ASSIGNED", title: "Pendiente asignado",
          message: `${updated.title} · ejecutar a más tardar el ${updated.dueDate.toISOString().slice(0, 10)}`,
          link: `/action-plan?item=${item.id}`,
        }).catch((err) => logger.error("notify action reassigned", err));
      } else if (data.dueDate && item.ownerUserId !== req.user.id) {
        notifyUser(prisma, item.ownerUserId, {
          plantId, type: "ACTION_UPDATED", title: "Cambió la fecha de un pendiente",
          message: `${updated.title} · nueva fecha ${updated.dueDate.toISOString().slice(0, 10)}`,
          link: `/action-plan?item=${item.id}`,
        }).catch((err) => logger.error("notify action date", err));
      }
      return res.json({ ok: true, item: updated });
    } catch (e) {
      return fail(res, e, "PATCH /action-plan/:id");
    }
  });

  // ── Registrar avance (con comentario obligatorio) ────────────────────────
  router.post("/action-plan/:id/progress", ...managers, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const item = await loadItem(req, Number(req.params.id));
      if (!canWork(req.user, item)) throw new ActionError("El pendiente está cancelado", 400);
      const text = String(req.body?.comment || "").trim();
      if (text.length < 3) throw new ActionError("Describe el avance en el comentario");
      const progress = nextProgress(item.progress, req.body?.progress, { admin: isAdmin(req.user) });
      const status = statusFor(progress, item.status);

      const [updated] = await prisma.$transaction([
        prisma.actionItem.update({
          where: { id: item.id },
          data: { progress, status, closedAt: progress >= 100 ? new Date() : null },
          select: LIST_SELECT,
        }),
        prisma.actionComment.create({
          data: { actionId: item.id, userId: req.user.id, text: text.slice(0, 2000), progressFrom: item.progress, progressTo: progress },
        }),
      ]);

      // Avisa a quien lo asignó cuando el responsable avanza o cierra.
      if (item.createdById !== req.user.id) {
        notifyUser(prisma, item.createdById, {
          plantId,
          type: "ACTION_UPDATED",
          title: progress >= 100 ? "Pendiente cerrado" : `Avance ${progress}% en un pendiente`,
          message: `${item.title} · ${text.slice(0, 120)}`,
          link: `/action-plan?item=${item.id}`,
        }).catch((err) => logger.error("notify action progress", err));
      }
      return res.json({ ok: true, item: updated });
    } catch (e) {
      return fail(res, e, "POST /action-plan/:id/progress");
    }
  });

  // ── Comentarios ──────────────────────────────────────────────────────────
  router.post("/action-plan/:id/comments", ...managers, async (req, res) => {
    try {
      const item = await loadItem(req, Number(req.params.id));
      const text = String(req.body?.text || "").trim();
      if (!text) throw new ActionError("Escribe el comentario");
      const comment = await prisma.actionComment.create({
        data: { actionId: item.id, userId: req.user.id, text: text.slice(0, 2000) },
        include: { user: USER_MINI },
      });
      await prisma.actionItem.update({ where: { id: item.id }, data: { updatedAt: new Date() } });
      const other = req.user.id === item.ownerUserId ? item.createdById : item.ownerUserId;
      if (other && other !== req.user.id) {
        notifyUser(prisma, other, {
          plantId: req.currentPlantId, type: "ACTION_UPDATED", title: "Nuevo comentario en un pendiente",
          message: `${item.title} · ${text.slice(0, 120)}`, link: `/action-plan?item=${item.id}`,
        }).catch((err) => logger.error("notify action comment", err));
      }
      return res.status(201).json({ ok: true, comment });
    } catch (e) {
      return fail(res, e, "POST /action-plan/:id/comments");
    }
  });

  // ── Evidencia ────────────────────────────────────────────────────────────
  router.post("/action-plan/:id/evidence", ...managers, (req, res, next) => {
    upload.single("file")(req, res, (err) => (err ? fail(res, err.status ? err : new ActionError(err.message), "upload") : next()));
  }, async (req, res) => {
    try {
      const item = await loadItem(req, Number(req.params.id));
      if (!req.file) throw new ActionError("Elige un archivo");
      const isPdf = String(req.file.mimetype).toLowerCase() === "application/pdf";
      const up = await uploadBufferToCloudinary(req.file.buffer, {
        folder: `lubriplan/action-plan/${req.currentPlantId}`,
        resourceType: isPdf ? "raw" : "image",
        publicId: isPdf ? `act_${item.id}_${Date.now()}.pdf` : undefined,
      });
      const ev = await prisma.actionEvidence.create({
        data: {
          actionId: item.id,
          userId: req.user.id,
          url: up.secure_url,
          publicId: up.public_id || null,
          name: String(req.file.originalname || "").slice(0, 160) || null,
          note: String(req.body?.note || "").trim().slice(0, 300) || null,
        },
        include: { user: USER_MINI },
      });
      await prisma.actionItem.update({ where: { id: item.id }, data: { updatedAt: new Date() } });
      return res.status(201).json({ ok: true, evidence: ev });
    } catch (e) {
      return fail(res, e, "POST /action-plan/:id/evidence");
    }
  });

  router.delete("/action-plan/:id/evidence/:evidenceId", ...managers, async (req, res) => {
    try {
      const item = await loadItem(req, Number(req.params.id));
      const ev = await prisma.actionEvidence.findFirst({ where: { id: Number(req.params.evidenceId), actionId: item.id } });
      if (!ev) throw new ActionError("Evidencia no encontrada", 404);
      if (ev.userId !== req.user.id && !isAdmin(req.user)) throw new ActionError("Solo quien la subió o un administrador puede quitarla", 403);
      await prisma.actionEvidence.delete({ where: { id: ev.id } });
      if (ev.publicId && !/\.pdf$/i.test(ev.publicId)) Promise.resolve(destroyCloudinaryImage(ev.publicId)).catch(() => {});
      return res.json({ ok: true });
    } catch (e) {
      return fail(res, e, "DELETE evidence");
    }
  });

  // ── Eliminar (admin) ─────────────────────────────────────────────────────
  router.delete("/action-plan/:id", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const item = await loadItem(req, Number(req.params.id));
      await prisma.actionItem.delete({ where: { id: item.id } });
      logAudit({ plantId: req.currentPlantId, userId: req.user.id, action: "DELETE", model: "ActionItem", recordId: item.id, changes: { before: { title: item.title } }, ip: req.ip });
      return res.json({ ok: true });
    } catch (e) {
      return fail(res, e, "DELETE /action-plan/:id");
    }
  });

  return router;
}
