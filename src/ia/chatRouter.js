// src/ia/chatRouter.js
import express from "express";
import { buildChatContext } from "./chatContextBuilder.js";
import { generateChatReply } from "./chatService.js";
import { dualRateLimit } from "./aiRateLimit.js";
import { AI_MODE } from "./aiConfig.js";

const CHAT_USER_LIMIT = Number(process.env.AI_CHAT_RATE_LIMIT_USER_PER_HOUR || 20);
const CHAT_PLANT_LIMIT = Number(process.env.AI_CHAT_RATE_LIMIT_PLANT_PER_HOUR || 200);
const MAX_MESSAGES = 40;

export default function chatRouter({ prisma, requireAuth, requireRole }) {
  const router = express.Router();

  // POST /api/ai/chat
  router.post(
    "/chat",
    requireAuth,
    requireRole(["ADMIN", "SUPERVISOR"]),
    async (req, res) => {
      try {
        const userId = req.user?.id ?? null;
        const role = String(req.user?.role || "TECHNICIAN").toUpperCase();
        const currentPlantId = Number(req.currentPlantId);

        if (!Number.isFinite(currentPlantId) || currentPlantId <= 0) {
          return res.status(400).json({ error: "PLANT_REQUIRED" });
        }

        const { messages } = req.body || {};

        if (!Array.isArray(messages) || messages.length === 0) {
          return res.status(400).json({ error: "messages array requerido" });
        }

        if (messages.length > MAX_MESSAGES) {
          return res.status(400).json({
            error: `Historial demasiado largo (máximo ${MAX_MESSAGES} mensajes)`,
          });
        }

        for (const m of messages) {
          if (typeof m !== "object" || !m.role || !m.content) {
            return res.status(400).json({ error: "Cada mensaje requiere role y content" });
          }
          if (!["user", "assistant"].includes(String(m.role))) {
            return res.status(400).json({ error: "role inválido (acepta: user, assistant)" });
          }
          if (String(m.content).length > 4000) {
            return res.status(400).json({ error: "Mensaje demasiado largo (máx 4000 caracteres)" });
          }
        }

        // Rate limiting — solo en modo provider para no bloquear demos
        if (String(AI_MODE || "mock").toLowerCase() === "provider") {
          const rl = dualRateLimit({
            userId,
            plantId: String(currentPlantId),
            userLimitPerHour: CHAT_USER_LIMIT,
            plantLimitPerHour: CHAT_PLANT_LIMIT,
          });

          if (!rl.ok) {
            return res.status(429).json({
              error: "Límite de consultas excedido. Intenta en unos minutos.",
              details: {
                userCount: rl.uCount,
                userLimit: rl.userLimitPerHour,
                plantCount: rl.pCount,
                plantLimit: rl.plantLimitPerHour,
              },
            });
          }
        }

        // Compilar snapshot de la planta para el system prompt
        const context = await buildChatContext(prisma, {
          plantId: currentPlantId,
          role,
          userId,
        });

        // Generar respuesta
        const { reply, model } = await generateChatReply({
          messages,
          context,
          role,
        });

        return res.json({ ok: true, reply, model });
      } catch (e) {
        console.error("[chatRouter] Error:", e);
        return res.status(500).json({ error: "Error en el asistente. Intenta de nuevo." });
      }
    }
  );

  return router;
}
