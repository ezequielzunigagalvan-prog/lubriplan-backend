// src/ia/chatRouter.js
// POST /api/ai/chat — LubriBot (ADMIN y SUPERVISOR).
//
// Correcciones:
//  - El historial largo ya no rompe la conversación con un error 400: se recorta a los últimos mensajes.
//  - Errores del proveedor (sin saldo, saturado, tiempo agotado) llegan con un mensaje claro.
//  - El límite por hora devuelve en cuántos segundos se libera.
//  - Registro con duración y tokens, sin guardar el texto de las preguntas.
import express from "express";
import { logger } from "../config/logger.js";
import { buildChatContext } from "./chatContextBuilder.js";
import { generateChatReply } from "./chatService.js";
import { dualRateLimit } from "./aiRateLimit.js";
import { AI_MODE } from "./aiConfig.js";
import { describeAiError } from "./openaiClient.js";

const CHAT_USER_LIMIT = Number(process.env.AI_CHAT_RATE_LIMIT_USER_PER_HOUR || 30);
const CHAT_PLANT_LIMIT = Number(process.env.AI_CHAT_RATE_LIMIT_PLANT_PER_HOUR || 200);
const MAX_MESSAGES = 60;

export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "Escribe una pregunta";
  if (messages.length > MAX_MESSAGES) return "La conversación es demasiado larga; empieza una nueva";
  for (const m of messages) {
    if (!m || typeof m !== "object" || !["user", "assistant"].includes(String(m.role)) || typeof m.content !== "string" || !m.content.trim()) {
      return "Formato de mensaje inválido";
    }
    if (m.content.length > 4000) return "El mensaje es demasiado largo (máximo 4000 caracteres)";
  }
  if (messages[messages.length - 1].role !== "user") return "El último mensaje debe ser una pregunta";
  return null;
}

export default function chatRouter({ prisma, requireAuth, requireRole }) {
  const router = express.Router();

  router.post("/chat", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    const started = Date.now();
    const plantId = Number(req.currentPlantId);
    const userId = req.user?.id ?? null;
    try {
      if (!Number.isFinite(plantId) || plantId <= 0) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const messages = req.body?.messages;
      const invalid = validateMessages(messages);
      if (invalid) return res.status(400).json({ error: invalid });

      if (String(AI_MODE || "mock").toLowerCase() === "provider") {
        const rl = dualRateLimit({ userId, plantId, userLimitPerHour: CHAT_USER_LIMIT, plantLimitPerHour: CHAT_PLANT_LIMIT, namespace: "chat" });
        if (!rl.ok) {
          res.set("Retry-After", String(rl.retryAfterSec));
          return res.status(429).json({
            error: `Llegaste al límite de ${rl.userLimitPerHour} preguntas por hora. Intenta en ${Math.ceil(rl.retryAfterSec / 60)} min.`,
            retryAfter: rl.retryAfterSec,
          });
        }
      }

      const role = String(req.user?.role || "").toUpperCase();
      const context = await buildChatContext(prisma, { plantId, role, userId });
      const { reply, model, usage } = await generateChatReply({ messages, context });

      logger.info("[LubriBot] respuesta", {
        plantId,
        userId,
        model,
        ms: Date.now() - started,
        turns: messages.length,
        tokens: usage?.total_tokens ?? null,
      });
      return res.json({ ok: true, reply, model });
    } catch (e) {
      const d = describeAiError(e);
      logger.error("[LubriBot] error", { plantId, userId, kind: d.kind, status: e?.status, error: String(e?.message || e).slice(0, 200), ms: Date.now() - started });
      return res.status(d.status).json({ error: d.message, kind: d.kind });
    }
  });

  return router;
}
