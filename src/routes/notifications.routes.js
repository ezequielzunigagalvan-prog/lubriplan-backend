// src/routes/notifications.routes.js
// Bandeja de notificaciones del usuario. Cada usuario ve SOLO las suyas, de la planta activa.
//  - GET    /notifications?unread=1&type=A,B&limit=20&cursor=ID
//  - GET    /notifications/count
//  - PATCH  /notifications/:id/read
//  - PATCH  /notifications/read-all
//  - DELETE /notifications/read      (borra las leídas de la planta activa)
//  - DELETE /notifications/:id
import express from "express";
import { logger } from "../config/logger.js";

export const NOTIFICATION_TYPES = [
  "CONDITION_REPORTED",
  "CONDITION_RESOLVED",
  "CONDITION_DISMISSED",
  "EMERGENCY_CREATED",
  "EXEC_ASSIGNED",
  "EXEC_CONDITION_CRITICAL",
  "EXEC_OVERDUE",
  "LOW_STOCK",
  "MONTHLY_TECH_SUMMARY",
];

/** Filtro base: usuario + planta activa (las notificaciones sin planta se ven en cualquiera). */
export function notificationScope(userId, plantId) {
  return plantId
    ? { userId, OR: [{ plantId: Number(plantId) }, { plantId: null }] }
    : { userId };
}

export function parseTypes(raw) {
  const list = String(raw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => NOTIFICATION_TYPES.includes(s));
  return list.length ? list : null;
}

export default function notificationsRoutes({ prisma, auth }) {
  if (!prisma) throw new Error("notificationsRoutes: prisma is required");
  if (typeof auth !== "function") throw new Error("notificationsRoutes: auth middleware is required");

  const router = express.Router();

  const ctx = (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "No autenticado" });
      return null;
    }
    const plantId = req.currentPlantId ? Number(req.currentPlantId) : null;
    return { userId, plantId, scope: notificationScope(userId, plantId) };
  };

  /** Sin leer en las otras plantas del usuario (para avisar que hay pendientes allá). */
  async function otherPlantsUnread(userId, plantId) {
    if (!plantId) return [];
    const rows = await prisma.notification.groupBy({
      by: ["plantId"],
      where: { userId, readAt: null, plantId: { not: null, notIn: [plantId] } },
      _count: { _all: true },
    });
    if (!rows.length) return [];
    const plants = await prisma.plant.findMany({
      where: { id: { in: rows.map((r) => r.plantId) } },
      select: { id: true, name: true },
    });
    const names = new Map(plants.map((p) => [p.id, p.name]));
    return rows.map((r) => ({ plantId: r.plantId, plantName: names.get(r.plantId) || `Planta ${r.plantId}`, unread: r._count._all }));
  }

  router.get("/notifications", auth, async (req, res) => {
    try {
      const c = ctx(req, res);
      if (!c) return;

      const unread = String(req.query.unread || "") === "1";
      const types = parseTypes(req.query.type);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));
      const cursorRaw = req.query.cursor != null ? Number(req.query.cursor) : null;
      const cursor = Number.isFinite(cursorRaw) ? cursorRaw : null;

      const where = {
        ...c.scope,
        ...(unread ? { readAt: null } : {}),
        ...(types ? { type: { in: types } } : {}),
      };

      const [items, unreadCount, byType, otherPlants] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        }),
        prisma.notification.count({ where: { ...c.scope, readAt: null } }),
        prisma.notification.groupBy({ by: ["type"], where: { ...c.scope, readAt: null }, _count: { _all: true } }),
        otherPlantsUnread(c.userId, c.plantId),
      ]);

      const nextCursor = items.length === limit ? items[items.length - 1].id : null;
      const unreadByType = Object.fromEntries(byType.map((r) => [r.type, r._count._all]));

      return res.json({ items, unreadCount, unreadByType, otherPlants, nextCursor });
    } catch (e) {
      logger.error("GET notifications", e);
      return res.status(500).json({ error: "Error cargando notificaciones" });
    }
  });

  router.get("/notifications/count", auth, async (req, res) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const unreadCount = await prisma.notification.count({ where: { ...c.scope, readAt: null } });
      return res.json({ unreadCount });
    } catch (e) {
      logger.error("GET notifications/count", e);
      return res.status(500).json({ error: "Error contando notificaciones" });
    }
  });

  router.patch("/notifications/read-all", auth, async (req, res) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const types = parseTypes(req.query.type || req.body?.type);
      const r = await prisma.notification.updateMany({
        where: { ...c.scope, readAt: null, ...(types ? { type: { in: types } } : {}) },
        data: { readAt: new Date() },
      });
      const unreadCount = await prisma.notification.count({ where: { ...c.scope, readAt: null } });
      return res.json({ ok: true, count: r.count, unreadCount });
    } catch (e) {
      logger.error("PATCH notifications/read-all", e);
      return res.status(500).json({ error: "Error marcando todas como leídas" });
    }
  });

  router.patch("/notifications/:id/read", auth, async (req, res) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const found = await prisma.notification.findFirst({ where: { id, ...c.scope }, select: { id: true, readAt: true } });
      if (!found) return res.status(404).json({ error: "No encontrada" });
      // Marcar una ya leída no es error (doble clic, dos pestañas).
      if (!found.readAt) await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
      return res.json({ ok: true });
    } catch (e) {
      logger.error("PATCH notifications/:id/read", e);
      return res.status(500).json({ error: "Error marcando como leída" });
    }
  });

  router.delete("/notifications/read", auth, async (req, res) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const r = await prisma.notification.deleteMany({ where: { ...c.scope, readAt: { not: null } } });
      return res.json({ ok: true, count: r.count });
    } catch (e) {
      logger.error("DELETE notifications/read", e);
      return res.status(500).json({ error: "Error eliminando notificaciones leídas" });
    }
  });

  router.delete("/notifications/:id", auth, async (req, res) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });
      const r = await prisma.notification.deleteMany({ where: { id, ...c.scope } });
      if (r.count === 0) return res.status(404).json({ error: "No encontrada" });
      return res.json({ ok: true });
    } catch (e) {
      logger.error("DELETE notifications/:id", e);
      return res.status(500).json({ error: "Error eliminando notificación" });
    }
  });

  return router;
}
