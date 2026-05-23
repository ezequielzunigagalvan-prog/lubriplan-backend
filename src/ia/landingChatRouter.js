// src/ia/landingChatRouter.js
// Endpoint público para el chatbot del landing page de LubriPlan.
// No requiere autenticación. Rate limit por IP.
import express from "express";
import { AI_MODE, OPENAI_MODEL } from "./aiConfig.js";

const LANDING_MODEL = String(process.env.AI_LANDING_CHAT_MODEL || OPENAI_MODEL || "gpt-4o-mini").trim();
const LANDING_MAX_TOKENS = Number(process.env.AI_LANDING_CHAT_MAX_TOKENS || 400);
const LANDING_IP_LIMIT_PER_HOUR = Number(process.env.AI_LANDING_IP_LIMIT_PER_HOUR || 30);
const MAX_MESSAGES = 20;
const isProvider = String(AI_MODE).toLowerCase() === "provider";

// Rate limit por IP: Map<ip, { count, windowStart }>
const ipWindows = new Map();

function ipRateLimit(ip) {
  const now = Date.now();
  const HOUR = 3_600_000;
  const entry = ipWindows.get(ip);
  if (!entry || now - entry.windowStart > HOUR) {
    ipWindows.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= LANDING_IP_LIMIT_PER_HOUR) return false;
  entry.count++;
  return true;
}

// Lazy OpenAI client — no cacheamos el promise rechazado para que reintente
async function getOpenAIClient() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY no configurada");
  const mod = await import("openai");
  const OpenAI = mod?.default || mod?.OpenAI || mod;
  return new OpenAI({ apiKey });
}

const SYSTEM_PROMPT = [
  "Eres el asistente virtual de LubriPlan, una plataforma SaaS para gestion de lubricacion industrial.",
  "Tu objetivo es responder preguntas sobre el producto, orientar a prospectos y dirigirlos hacia una demo o contacto.",
  "",
  "SOBRE LUBRIPLAN:",
  "Sistema que conecta planificacion, ejecucion, inventario, condicion y alertas de lubricacion industrial en una sola plataforma.",
  "Reemplaza hojas de Excel, papel y mensajes de WhatsApp con control operativo real.",
  "",
  "MODULOS: Rutas de lubricacion, ejecucion trazable, inventario con alertas, reportes de condicion anormal,",
  "alertas operativas y resumen ejecutivo con IA, actividades automaticas/manuales/emergentes,",
  "multiplanta sin mezcla de datos, modo offline, exportacion/importacion, LubriPlan Card (carta de lubricacion por QR sin login).",
  "",
  "ROLES: Administrador, Supervisor, Tecnico — vistas y permisos diferenciados.",
  "INDUSTRIAS: Manufactura, automotriz, metalmecanica, alimentos y bebidas, servicios auxiliares, plantas industriales.",
  "",
  "DEMO Y CONTACTO: hidrolub.com/lubriplan | lubriplan@hidrolub.com | Empresa: Hidrolub",
  "",
  "REGLAS:",
  "- Responde SIEMPRE en espanol",
  "- Maximo 3-4 oraciones por respuesta",
  "- Tono profesional, tecnico e industrial",
  "- Para precios: dependen de la operacion, derivar a demo o email",
  "- No inventes funcionalidades no listadas",
].join("\n");

function mockReply(userText) {
  const t = String(userText || "").toLowerCase();
  if (t.includes("demo")) return "Puedes solicitar una demo en hidrolub.com/lubriplan o escribiendo a lubriplan@hidrolub.com. El equipo te contactara para mostrarla en tu operacion.";
  if (t.includes("precio") || t.includes("costo") || t.includes("cuesta")) return "El costo depende del tamano de la operacion y la configuracion. Para cotizacion, escribe a lubriplan@hidrolub.com o solicita la demo en hidrolub.com/lubriplan.";
  if (t.includes("modulo") || t.includes("funcionalidad") || t.includes("incluye") || t.includes("que hace")) return "LubriPlan incluye rutas, ejecucion trazable, inventario, condicion anormal, alertas con IA, multiplanta, modo offline y LubriPlan Card. Todo en una sola plataforma, sin modulos separados.";
  if (t.includes("card") || t.includes("qr") || t.includes("carta")) return "LubriPlan Card es la carta de lubricacion digital. El tecnico escanea el QR del equipo y accede a puntos, lubricantes, cantidades y metodos sin login ni instalacion.";
  if (t.includes("offline") || t.includes("sin red") || t.includes("campo")) return "LubriPlan tiene modo offline. El tecnico registra ejecuciones en campo sin red y los datos se sincronizan al reconectarse.";
  if (t.includes("multiplanta") || t.includes("varias plantas")) return "LubriPlan soporta multiplanta con datos separados por operacion. Cada planta tiene su propio contexto sin mezcla de informacion.";
  if (t.includes("ia") || t.includes("inteligencia") || t.includes("ai") || t.includes("resumen")) return "LubriPlan incluye resumen ejecutivo con IA que analiza la operacion, detecta patrones y entrega recomendaciones con contexto real de planta.";
  if (t.includes("quien") || t.includes("para que") || t.includes("para quien")) return "LubriPlan es para jefes de mantenimiento, supervisores y tecnicos de lubricacion industrial en manufactura, automotriz, metalmecanica y otras industrias.";
  return "LubriPlan conecta planificacion, ejecucion, inventario y alertas de lubricacion industrial en un solo sistema. Puedo ayudarte con preguntas sobre funcionalidades, como funciona o como solicitar una demo.";
}

export default function landingChatRouter() {
  const router = express.Router();

  router.post("/landing/chat", async (req, res) => {
    try {
      // IP para rate limit
      const rawIp =
        req.headers["x-forwarded-for"] ||
        req.socket?.remoteAddress ||
        "unknown";
      const ip = String(Array.isArray(rawIp) ? rawIp[0] : rawIp)
        .split(",")[0]
        .trim();

      // Rate limit solo en modo provider
      if (isProvider && !ipRateLimit(ip)) {
        return res.status(429).json({ error: "Demasiadas consultas. Intenta en unos minutos." });
      }

      // Validar body
      const body = req.body;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "Body JSON requerido" });
      }

      const { messages } = body;

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages array requerido" });
      }

      if (messages.length > MAX_MESSAGES) {
        return res.status(400).json({ error: `Historial demasiado largo (max ${MAX_MESSAGES})` });
      }

      for (const m of messages) {
        if (
          !m ||
          typeof m !== "object" ||
          !m.role ||
          !m.content ||
          !["user", "assistant"].includes(String(m.role))
        ) {
          return res.status(400).json({ error: "Cada mensaje requiere role (user|assistant) y content" });
        }
        if (String(m.content).length > 2000) {
          return res.status(400).json({ error: "Mensaje demasiado largo (max 2000 caracteres)" });
        }
      }

      // Modo mock
      if (!isProvider) {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        return res.json({ ok: true, reply: mockReply(lastUser?.content), model: "mock" });
      }

      // Modo provider — con fallback a mock si OpenAI falla
      try {
        const client = await getOpenAIClient();
        const response = await client.chat.completions.create({
          model: LANDING_MODEL,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
          max_tokens: LANDING_MAX_TOKENS,
          temperature: 0.3,
        });
        const reply = response.choices?.[0]?.message?.content?.trim() || "";
        return res.json({ ok: true, reply, model: response.model });
      } catch (aiErr) {
        // Si OpenAI falla en landing, respondemos con mock en lugar de 500
        console.error("[landingChat] OpenAI error, fallback a mock:", aiErr?.message ?? aiErr);
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        return res.json({ ok: true, reply: mockReply(lastUser?.content), model: "mock-fallback" });
      }
    } catch (e) {
      console.error("[landingChat] Error inesperado:", e?.message ?? e, e?.stack);
      return res.status(500).json({ error: "Error en el asistente. Intenta de nuevo." });
    }
  });

  return router;
}
