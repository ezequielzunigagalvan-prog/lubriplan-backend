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
  "Eres el asistente virtual de LubriPlan, plataforma SaaS de gestion de lubricacion industrial.",
  "Tu objetivo es responder preguntas sobre el producto, orientar a prospectos y dirigirlos a demo o contacto.",
  "",
  "SOBRE LUBRIPLAN:",
  "Sistema que conecta planificacion, ejecucion, inventario, condicion y alertas de lubricacion en una sola plataforma.",
  "Reemplaza Excel, papel y WhatsApp con control operativo real y trazable.",
  "",
  "MODULOS:",
  "- Rutas de lubricacion: frecuencias, puntos, metodos y responsables",
  "- Ejecucion trazable: tecnico, condicion, evidencia y consumo real",
  "- Inventario de lubricantes con alertas de existencia minima",
  "- Reportes de condicion anormal con seguimiento",
  "- Alertas operativas y resumen ejecutivo generado con IA",
  "- Actividades automaticas, manuales y emergentes",
  "- Multiplanta sin mezcla de datos entre operaciones",
  "- Modo offline para campo sin red",
  "- Exportacion e importacion de datos",
  "- LubriPlan Card: carta de lubricacion por QR, sin login ni instalacion",
  "",
  "FLUJO: configuras rutas -> LubriPlan genera actividades automaticamente -> tecnico ejecuta con contexto -> jefatura ve KPIs, alertas y resumen IA.",
  "",
  "ROLES: Administrador, Supervisor, Tecnico — vistas y permisos diferenciados.",
  "INDUSTRIAS: Manufactura, automotriz, metalmecanica, alimentos y bebidas, servicios auxiliares, plantas industriales.",
  "",
  "DEMO Y CONTACTO: hidrolub.com/lubriplan | lubriplan@hidrolub.com | Empresa: Hidrolub",
  "PRECIOS: dependen del tamano y configuracion de la operacion. Derivar siempre a demo o email.",
  "",
  "CUANDO EL USUARIO QUIERE 'CONOCER' LUBRIPLAN:",
  "Presenta el producto de forma completa: que es, que problema resuelve, como funciona (flujo), modulos principales,",
  "para quien es y como acceder a la demo. Usa 4-5 oraciones claras y termina invitando a la demo.",
  "",
  "REGLAS:",
  "- Responde SIEMPRE en espanol",
  "- Maximo 4-5 oraciones por respuesta (para 'conocer' puedes extenderte un poco mas)",
  "- Tono profesional, tecnico e industrial",
  "- No inventes funcionalidades no listadas",
  "- Siempre termina invitando a la demo o contacto cuando sea relevante",
].join("\n");

const CONOCER_REPLY = [
  "LubriPlan es una plataforma SaaS especializada en gestion de lubricacion industrial.",
  "Conecta en un solo sistema: rutas de lubricacion, ejecucion trazable por tecnico,",
  "inventario con alertas de existencia, reportes de condicion anormal y resumen ejecutivo con IA.",
  "Esta disenado para que jefes de mantenimiento, supervisores y tecnicos dejen atras el control",
  "en Excel, papel o WhatsApp y operen con datos reales.",
  "\n¿Te interesa ver como funciona en la practica?",
  "Puedes solicitar una demo en hidrolub.com/lubriplan o escribir a lubriplan@hidrolub.com.",
].join(" ");

function mockReply(userText) {
  const t = String(userText || "").toLowerCase();

  // Conocer LubriPlan — respuesta completa de producto
  if (
    t.includes("conocer") ||
    t.includes("conoce") ||
    t.includes("quiero saber") ||
    t.includes("cuentame") ||
    t.includes("cuentame") ||
    t.includes("explica") ||
    t.includes("informacion") ||
    t.includes("informame")
  ) return CONOCER_REPLY;

  if (t.includes("que es") || t.includes("qué es")) {
    return "LubriPlan es el sistema de gestion de lubricacion industrial que reemplaza el control en Excel, papel y mensajes. Conecta planificacion, ejecucion trazable, inventario, condicion anormal y alertas con IA en una sola plataforma para jefes de mantenimiento, supervisores y tecnicos.";
  }
  if (t.includes("demo")) return "Puedes solicitar una demo en hidrolub.com/lubriplan o escribiendo a lubriplan@hidrolub.com. El equipo te contactara para mostrarla en tu operacion.";
  if (t.includes("precio") || t.includes("costo") || t.includes("cuesta") || t.includes("plan") || t.includes("tarifa")) return "El costo depende del tamano de la operacion y la configuracion. Para una cotizacion puntual, escribe a lubriplan@hidrolub.com o solicita la demo en hidrolub.com/lubriplan.";
  if (t.includes("modulo") || t.includes("funcionalidad") || t.includes("incluye") || t.includes("que tiene") || t.includes("caracteristica")) return "LubriPlan incluye: rutas de lubricacion, ejecucion trazable, inventario con alertas, condicion anormal, resumen ejecutivo con IA, actividades automaticas/manuales/emergentes, multiplanta, modo offline y LubriPlan Card. Todo en una sola plataforma.";
  if (t.includes("card") || t.includes("qr") || t.includes("carta")) return "LubriPlan Card es la carta de lubricacion digital por QR. El tecnico escanea el codigo del equipo y accede a puntos, lubricantes, cantidades y metodos de aplicacion, sin login ni instalacion.";
  if (t.includes("offline") || t.includes("sin red") || t.includes("campo") || t.includes("movil")) return "LubriPlan tiene modo offline completo. El tecnico puede registrar ejecuciones en campo sin conexion a red y los datos se sincronizan automaticamente al reconectarse.";
  if (t.includes("multiplanta") || t.includes("varias plantas") || t.includes("multi")) return "LubriPlan soporta multiplanta con datos completamente separados por operacion. Cada planta tiene su propio contexto, usuarios y configuracion sin ningun cruce de informacion.";
  if (t.includes("ia") || t.includes("inteligencia") || t.includes("ai") || t.includes("resumen") || t.includes("reporte")) return "LubriPlan incluye resumen ejecutivo generado con IA. Analiza automaticamente la operacion del mes, detecta patrones de riesgo y entrega recomendaciones accionables con contexto real de planta, sin que tengas que revisar registro por registro.";
  if (t.includes("quien") || t.includes("para que") || t.includes("para quien") || t.includes("industria")) return "LubriPlan es para jefes de mantenimiento, supervisores de lubricacion y tecnicos de campo en manufactura, automotriz, metalmecanica, alimentos y bebidas, y plantas industriales en general.";
  if (t.includes("como funciona") || t.includes("funcionamiento") || t.includes("proceso")) return "El flujo es simple: configuras rutas, frecuencias y criterios. LubriPlan genera las actividades automaticamente, el tecnico las ejecuta con contexto desde su dispositivo, y la jefatura ve indicadores, alertas y resumen ejecutivo en tiempo real.";
  if (t.includes("integra") || t.includes("erp") || t.includes("sap") || t.includes("api")) return "LubriPlan funciona como plataforma autonoma. Para necesidades de integracion con ERP u otros sistemas, contacta al equipo en lubriplan@hidrolub.com con los detalles de tu operacion.";
  if (t.includes("segur") || t.includes("dato") || t.includes("privacidad")) return "LubriPlan opera con datos separados por planta y por empresa. Cada operacion accede unicamente a su propia informacion, con autenticacion por roles y sin mezcla entre clientes.";
  return "LubriPlan conecta planificacion, ejecucion, inventario y alertas de lubricacion industrial en un solo sistema. Puedo orientarte sobre funcionalidades, como funciona o como solicitar una demo. Escribe tu pregunta.";
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
