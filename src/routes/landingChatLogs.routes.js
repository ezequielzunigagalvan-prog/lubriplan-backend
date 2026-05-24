// src/routes/landingChatLogs.routes.js
import express from "express";

export default function landingChatLogsRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // GET /api/admin/landing-chat-logs
  router.get(
    "/admin/landing-chat-logs",
    auth,
    requireRole(["ADMIN"]),
    async (req, res) => {
      try {
        const { hotOnly, source, page = "1", limit = "50" } = req.query;
        const take = Math.min(Number(limit) || 50, 200);
        const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

        const where = {};
        if (hotOnly === "true") where.isHotLead = true;
        if (source === "landing" || source === "card") where.source = source;

        const [logs, total] = await Promise.all([
          prisma.landingChatLog.findMany({
            where,
            orderBy: { updatedAt: "desc" },
            take,
            skip,
          }),
          prisma.landingChatLog.count({ where }),
        ]);

        return res.json({ ok: true, logs, total, page: Number(page), limit: take });
      } catch (e) {
        console.error("[landingChatLogs] Error:", e?.message);
        return res.status(500).json({ error: "Error obteniendo logs" });
      }
    }
  );

  // DELETE /api/admin/landing-chat-logs/:id
  router.delete(
    "/admin/landing-chat-logs/:id",
    auth,
    requireRole(["ADMIN"]),
    async (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });
        await prisma.landingChatLog.delete({ where: { id } });
        return res.json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: "Error eliminando registro" });
      }
    }
  );

  return router;
}
