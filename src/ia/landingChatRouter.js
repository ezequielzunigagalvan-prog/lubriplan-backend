// src/ia/landingChatRouter.js
// Endpoint público para el chatbot del landing page de LubriPlan.
// No requiere autenticación. Rate limit por IP.
import express from "express";
import { AI_MODE, OPENAI_MODEL } from "./aiConfig.js";

const LANDING_MODEL = String(process.env.AI_LANDING_CHAT_MODEL || OPENAI_MODEL || "gpt-4o-mini").trim();
const LANDING_MAX_TOKENS = Number(process.env.AI_LANDING_CHAT_MAX_TOKENS || 400);
const LANDING_IP_LIMIT_PER_HOUR = Number(process.env.AI_LANDING_IP_LIMIT_PER_HOUR || 30);
const MAX_MESSAGES = 20;

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

let clientPromise = null;
async function getClient() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");
    const mod = await import("openai");
    const OpenAI = mod?.default || mod?.OpenAI || mod;
    return new OpenAI({ apiKey });
  })();
  return clientPromise;
}

const SYSTEM_PROMPT = `Eres el asistente virtual de LubriPlan, una plataforma SaaS para gestión de lubricación industrial. Tu objetivo es responder preguntas sobre el producto, orientar a prospectos y dirigirlos hacia una demo o contacto cuando corresponda.

SOBRE LUBRIPLAN:
LubriPlan es un sistema que conecta planificación, ejecución, inventario, condición y alertas de lubricación industrial en una sola plataforma. Reemplaza hojas de Excel, papel y mensajes de WhatsApp con control operativo real.

MÓDULOS:
- Rutas de lubricación: frecuencias, puntos, métodos y responsables
- Ejecución trazable: técnico, condición, evidencia y consumo real
- Inventario de lubricantes con alertas de existencia mínima
- Reportes de condición anormal con seguimiento
- Alertas operativas y resumen ejecutivo con IA
- Actividades automáticas, manuales y emergentes
- Multiplanta sin mezcla de datos entre operaciones
- Modo offline para campo sin red
- Exportación e importación de datos
- LubriPlan Card: carta de lubricación por código QR sin login

ROLES: Administrador, Supervisor, Técnico — cada uno con vistas y permisos diferenciados.

INDUSTRIAS: Manufactura, automotriz, metalmecánica, alimentos y bebidas, servicios auxiliares, plantas industriales en general.

DEMO Y CONTACTO:
- Demo: hidrolub.com/lubriplan (menciona la URL si preguntan cómo acceder)
- Email: lubriplan@hidrolub.com
- Empresa desarrolladora: Hidrolub

PRECIOS: Dependen del tamaño de la operación y configuración. Para cotización puntual, dirigir a la demo o al email de contacto. No inventes cifras.

REGLAS:
- Responde SIEMPRE en español
- Sé breve: máximo 3-4 oraciones por respuesta
- Tono profesional, técnico e industrial
- Si la pregunta es muy específica de implementación, precio o integración con ERP, dirige al email o a la demo
- No inventes funcionalidades que no están listadas arriba
- Si no sabes algo, dilo con honestidad y deriva al contacto`;

function mockReply(userText) {
  const t = String(userText || "").toLowerCase();
  if (t.includes("demo")) return "Puedes solicitar una demo en hidrolub.com/lubriplan o escribiendo a lubriplan@hidrolub.com. El equipo te contactará para mostrarla en tu contexto operativo.";
  if (t.includes("precio") || t.includes("costo") || t.includes("cuesta")) return "El costo depende del tamaño de la operación y la configuración. Para una cotización puntual, escribe a lubriplan@hidrolub.com o solicita la demo en hidrolub.com/lubriplan.";
  if (t.includes("módulo") || t.includes("funcionalidad") || t.includes("incluye")) return "LubriPlan incluye rutas, ejecución trazable, inventario, condición anormal, alertas con IA, multiplanta, modo offline y LubriPlan Card. Todo en una sola plataforma, sin módulos separados.";
  if (t.includes("card") || t.includes("qr")) return "LubriPlan Card es la carta de lubricación digital. El técnico escanea el QR del equipo y accede a puntos, lubricantes, cantidades y métodos — sin login ni instalación.";
  if (t.includes("offline") || t.includes("sin red") || t.includes("campo")) return "LubriPlan tiene modo offline. El técnico puede registrar ejecuciones en campo aunque no tenga red, y los datos se sincronizan al reconectarse.";
  if (t.includes("multiplanta") || t.includes("varias plantas")) return "Sí, LubriPlan soporta multiplanta con datos completamente separados por operación. Cada planta tiene su propio contexto sin mezcla de información.";
  if (t.includes("ia") || t.includes("inteligencia") || t.includes("ai")) return "LubriPlan incluye resumen ejecutivo generado con IA que analiza la operación del mes, detecta patrones y entrega recomendaciones accionables con contexto real de planta.";
  return "LubriPlan es la plataforma de gestión de lubricación industrial que conecta planificación, ejecución, inventario y alertas en un solo sistema. ¿Tienes alguna pregunta específica sobre el producto o deseas solicitar una demo?";
}

export default function landingChatRouter() {
  const router = express.Router();

  router.post("/landing/chat", async (req, res) => {
    try {
      const ip = String(
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        "unknown"
      );

      if (String(AI_MODE).toLowerCase() === "provider" && !ipRateLimit(ip)) {
        return res.status(429).json({ error: "Demasiadas consultas. Intenta en unos minutos." });
      }

      const { messages } = req.body || {};

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages array requerido" });
      }

      if (messages.length > MAX_MESSAGES) {
        return res.status(400).json({ error: `Historial demasiado largo (máx ${MAX_MESSAGES})` });
      }

      for (const m of messages) {
        if (!m?.role || !m?.content || !["user", "assistant"].includes(String(m.role))) {
          return res.status(400).json({ error: "Mensaje con role o content inválido" });
        }
        if (String(m.content).length > 2000) {
          return res.status(400).json({ error: "Mensaje demasiado largo (máx 2000 caracteres)" });
        }
      }

      if (String(AI_MODE).toLowerCase() !== "provider") {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        return res.json({ ok: true, reply: mockReply(lastUser?.content), model: "mock" });
      }

      const client = await getClient();
      const response = await client.chat.completions.create({
        model: LANDING_MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        max_tokens: LANDING_MAX_TOKENS,
        temperature: 0.3,
      });

      const reply = response.choices?.[0]?.message?.content?.trim() || "";
      return res.json({ ok: true, reply, model: response.model });
    } catch (e) {
      console.error("[landingChatRouter] Error:", e);
      return res.status(500).json({ error: "Error en el asistente. Intenta de nuevo." });
    }
  });

  return router;
}
