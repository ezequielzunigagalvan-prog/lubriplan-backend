import express from "express";

export default function notificationsRoutes({ prisma, auth }) {
  if (!prisma) throw new Error("notificationsRoutes: prisma is required");
  if (typeof auth !== "function") throw new Error("notificationsRoutes: auth middleware is required");

  const router = express.Router();
  const buildPlantScope = (plantId) =>
    plantId
      ? { plantId: Number(plantId) }
      : {};

  router.get("/notifications", auth, async (req, res) => {
    try {
      const userId = req.user?.id;
      const plantId = req.currentPlantId ? Number(req.currentPlantId) : null;
      if (!userId) return res.status(401).json({ error: "No autenticado" });

      const unread = String(req.query.unread || "") === "1";
      const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));

      const cursorRaw = req.query.cursor != null ? Number(req.query.cursor) : null;
      const cursor = Number.isFinite(cursorRaw) ? cursorRaw : null;

      const where = { userId, ...buildPlantScope(plantId) };
      if (unread) where.readAt = null;

      const [items, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        }),
        prisma.notification.count({
          where: { userId, readAt: null, ...buildPlantScope(plantId) },
        }),
      ]);

      const nextCursor = items.length === limit ? items[items.length - 1].id : null;

      return res.json({ items, unreadCount, nextCursor });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Error cargando notificaciones" });
    }
  });

  router.patch("/notifications/:id/read", auth, async (req, res) => {
    try {
      const userId = req.user?.id;
      const plantId = req.currentPlantId ? Number(req.currentPlantId) : null;
      if (!userId) return res.status(401).json({ error: "No autenticado" });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const r = await prisma.notification.updateMany({
        where: { id, userId, readAt: null, ...buildPlantScope(plantId) },
        data: { readAt: new Date() },
      });

      if (r.count === 0) return res.status(404).json({ error: "No encontrada" });

      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Error marcando como leída" });
    }
  });

  router.patch("/notifications/read-all", auth, async (req, res) => {
    try {
      const userId = req.user?.id;
      const plantId = req.currentPlantId ? Number(req.currentPlantId) : null;
      if (!userId) return res.status(401).json({ error: "No autenticado" });

      const r = await prisma.notification.updateMany({
        where: { userId, readAt: null, ...buildPlantScope(plantId) },
        data: { readAt: new Date() },
      });

      return res.json({ ok: true, count: r.count, unreadCount: 0 });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Error marcando todas como leídas" });
    }
  });

  return router;
}
