// src/ia/landingChatRouter.js
// Endpoints públicos de chatbot para landing principal y landing de LubriPlan Card.
import express from "express";
import { logger } from "../config/logger.js";
import { notifyChatLead, hasContactInfo } from "../services/email/leadNotifier.js";
import { AI_MODE, OPENAI_MODEL } from "./aiConfig.js";
import { getOpenAI, trimHistory } from "./openaiClient.js";

const LANDING_MODEL = String(process.env.AI_LANDING_CHAT_MODEL || OPENAI_MODEL || "gpt-4o-mini").trim();
const LANDING_MAX_TOKENS = Number(process.env.AI_LANDING_CHAT_MAX_TOKENS || 400);
const LANDING_IP_LIMIT_PER_HOUR = Number(process.env.AI_LANDING_IP_LIMIT_PER_HOUR || 30);
const MAX_MESSAGES = 20;
const isProvider = String(AI_MODE).toLowerCase() === "provider";

const HOT_KEYWORDS = [
  "demo", "precio", "costo", "cuesta", "cotizacion", "cotización",
  "contratar", "adquirir", "comprar", "tarifa", "plan", "implementar",
  "implementacion", "implementación", "interesado", "quiero", "cuanto",
];

// Rate limit por IP
const ipWindows = new Map();
function ipRateLimit(ip) {
  const now = Date.now();
  const HOUR = 3_600_000;
  // limpieza de ventanas viejas para que el mapa no crezca sin límite
  if (ipWindows.size > 5000) for (const [k, v] of ipWindows) if (now - v.windowStart > HOUR) ipWindows.delete(k);
  const entry = ipWindows.get(ip);
  if (!entry || now - entry.windowStart > HOUR) {
    ipWindows.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= LANDING_IP_LIMIT_PER_HOUR) return false;
  entry.count++;
  return true;
}

function extractIp(req) {
  const raw = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  return String(Array.isArray(raw) ? raw[0] : raw).split(",")[0].trim();
}

function detectHotKeywords(messages) {
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => String(m.content || "").toLowerCase())
    .join(" ");
  return HOT_KEYWORDS.filter((kw) => userText.includes(kw));
}

// ── System prompt: LubriPlan (landing principal) ─────────────────────────────
const SYSTEM_PROMPT_LANDING = [
  "Eres el asistente virtual de LubriPlan, plataforma SaaS de gestion de lubricacion industrial.",
  "Tu objetivo es responder preguntas sobre el producto, orientar a prospectos y concretar solicitudes de demo.",
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
  "- LubriPlan Card: carta digital de lubricacion por QR (ver detalle abajo)",
  "- QR unico por equipo con su carta de lubricacion y etiquetas para imprimir",
  "- Ordenes de lubricacion preventiva (OLP): ejecutar varias rutas de un equipo junto con el paro de mantenimiento",
  "- Plan de accion para supervisores: pendientes de lubricacion, seguridad, predictivos y auditoria con avance y evidencia",
  "- Diagramas de sistemas de lubricacion automatica (progresivos y de aceite con dosificadores) y documentos tecnicos por equipo",
  "- Panel multiplanta para administradores y supervisores, analisis de cumplimiento, puntualidad, consumo y costo",
  "- Asistente tecnico de campo: reengrase, bombazos, compatibilidad de grasas, viscosidad y conversiones",
  "",
  "QUE ES LUBRIPLAN CARD (modulo independiente y también incluido en LubriPlan):",
  "Es la carta de lubricacion digital accesible por codigo QR. Convierte las tarjetas fisicas o en papel de cada equipo en una ficha digital.",
  "El tecnico escanea el QR pegado en el equipo con su celular y accede al instante a: lubricante correcto, cantidad exacta, frecuencia, metodo de aplicacion y puntos de lubricacion.",
  "No requiere crear cuenta, no requiere instalar ninguna app. Funciona desde cualquier celular con camara.",
  "El administrador sube la imagen del equipo, marca los puntos de lubricacion y genera el QR. La carta siempre muestra la version actualizada.",
  "Cada lubricacion queda registrada con fecha, tecnico y condicion — trazabilidad completa sin papel.",
  "LubriPlan Card esta disponible como plan independiente (solo cartas, sin el sistema completo) o incluida en LubriPlan Professional.",
  "Si preguntan por LubriPlan Card, explica esto y ofrece agendar una demo o visitar el landing especifico de Card.",
  "",
  "FLUJO: configuras rutas -> LubriPlan genera actividades automaticamente -> tecnico ejecuta con contexto -> jefatura ve KPIs, alertas y resumen IA.",
  "",
  "ROLES: Administrador, Supervisor, Tecnico — vistas y permisos diferenciados.",
  "INDUSTRIAS: Manufactura, automotriz, metalmecanica, alimentos y bebidas, servicios auxiliares, plantas industriales.",
  "",
  "SOLICITAR DEMO:",
  "Cuando el prospecto pida una demo, precio, cotizacion o quiera ser contactado, responde exactamente asi:",
  "«Para agendar tu demo personalizada, necesito algunos datos. ¿Puedes compartirme tu nombre completo, correo electronico, telefono y empresa (esta ultima es opcional)?»",
  "Una vez que el usuario proporcione esos datos en el chat, confirma que los recibiste y que el equipo de LubriPlan se pondra en contacto a la brevedad.",
  "No compartas precios especificos; siempre deriva a la demo.",
  "",
  "REGLAS:",
  "- Responde SIEMPRE en espanol",
  "- Maximo 4-5 oraciones por respuesta",
  "- Tono profesional, tecnico e industrial",
  "- No inventes funcionalidades no listadas",
].join("\n");

// ── System prompt: LubriPlan Card (landing de Card) ──────────────────────────
const SYSTEM_PROMPT_CARD = [
  "Eres el asistente virtual de LubriPlan Card, la carta de lubricacion digital de LubriPlan.",
  "Tu objetivo es explicar LubriPlan Card, resolver dudas y concretar solicitudes de demo o contacto.",
  "",
  "QUE ES LUBRIPLAN CARD:",
  "Es la carta de lubricacion digital accesible por codigo QR. El tecnico escanea el QR del equipo",
  "y ve al instante: puntos de lubricacion, lubricante correcto, cantidad, frecuencia y metodo de aplicacion.",
  "Sin login, sin instalacion de apps, desde cualquier celular con camara.",
  "",
  "PARA QUE SIRVE:",
  "- Elimina las cartas impresas o en PDF que se pierden o desactualizan",
  "- El tecnico tiene la informacion correcta en campo, en el momento exacto",
  "- Cada punto de lubricacion tiene especificacion tecnica completa",
  "- Se actualiza en tiempo real desde el sistema; el QR siempre muestra la version vigente",
  "",
  "COMO FUNCIONA:",
  "1. El administrador sube el plano o imagen del equipo en LubriPlan",
  "2. Marca los puntos de lubricacion sobre la imagen (posicion, lubricante, cantidad, frecuencia, metodo)",
  "3. Se genera un QR unico por equipo",
  "4. El tecnico escanea el QR en campo y accede a la carta sin necesidad de cuenta ni app",
  "",
  "PRECIOS:",
  "NUNCA menciones precios, montos, tarifas, planes ni costos, aunque el usuario insista.",
  "Si pregunta por precio o cotizacion, explica que la propuesta depende del numero de equipos y de la operacion,",
  "y pide sus datos para que el equipo lo contacte (ver abajo).",
  "",
  "SOLICITAR INFORMACION, DEMO O COTIZACION:",
  `Cuando el prospecto pida informacion, una demo, precio, cotizacion o quiera ser contactado, responde exactamente asi: «${"{{CARD_CONTACT_REPLY}}"}»`,
  "Una vez que el usuario proporcione esos datos, confirma que los recibiste y que el equipo se pondra en contacto.",
  "",
  "REGLAS:",
  "- Responde SIEMPRE en espanol",
  "- Maximo 4-5 oraciones por respuesta",
  "- Tono practico, claro e industrial",
  "- No inventes funcionalidades no listadas",
  "- Cuando no sepas algo, indica que el equipo puede resolverlo en la demo",
].join("\n");

// ── Mock replies ─────────────────────────────────────────────────────────────
const DEMO_REQUEST_REPLY =
  "Para agendar tu demo personalizada, necesito algunos datos. ¿Puedes compartirme tu nombre completo, correo electrónico, teléfono y empresa (esta última es opcional)?";

// LubriPlan Card: sin precios; se piden nombre, empresa y teléfono.
const DEMO_REQUEST_REPLY_CARD =
  "Con gusto te damos información de LubriPlan Card. La propuesta depende del número de equipos y de tu operación, así que el equipo te contactará directamente. ¿Me compartes tu nombre, el nombre de tu empresa y tu número de teléfono?";

const SYSTEM_PROMPT_CARD_FINAL = SYSTEM_PROMPT_CARD.replace("{{CARD_CONTACT_REPLY}}", DEMO_REQUEST_REPLY_CARD);

function mockReplyLanding(userText) {
  const t = String(userText || "").toLowerCase();
  if (t.includes("demo") || t.includes("contratar") || t.includes("cotiza") || t.includes("precio") || t.includes("costo") || t.includes("cuesta") || t.includes("contacto") || t.includes("interesado")) return DEMO_REQUEST_REPLY;
  if (t.includes("card") || t.includes("qr") || t.includes("carta")) return "LubriPlan Card es la carta de lubricación digital accesible por código QR. El técnico escanea el QR pegado en el equipo y ve al instante el lubricante correcto, la cantidad exacta, la frecuencia y el método de aplicación — sin login ni instalación. Está disponible como plan independiente (solo cartas) o incluida en LubriPlan Professional.";
  if (t.includes("conocer") || t.includes("cuentame") || t.includes("explica") || t.includes("que es") || t.includes("qué es")) return "LubriPlan es el sistema de gestión de lubricación industrial que reemplaza el control en Excel, papel y mensajes. Conecta planificación, ejecución trazable, inventario, condición anormal y alertas con IA en una sola plataforma para jefes de mantenimiento, supervisores y técnicos.";
  if (t.includes("offline") || t.includes("sin red") || t.includes("campo")) return "LubriPlan tiene modo offline completo. El técnico puede registrar ejecuciones en campo sin conexión y los datos se sincronizan automáticamente al reconectarse.";
  if (t.includes("multiplanta") || t.includes("varias plantas")) return "LubriPlan soporta multiplanta con datos completamente separados por operación. Cada planta tiene su propio contexto, usuarios y configuración.";
  if (t.includes("ia") || t.includes("inteligencia") || t.includes("resumen")) return "LubriPlan incluye resumen ejecutivo generado con IA que analiza la operación del mes, detecta patrones de riesgo y entrega recomendaciones accionables.";
  if (t.includes("modulo") || t.includes("incluye") || t.includes("funcionalidad")) return "LubriPlan incluye: rutas de lubricación, ejecución trazable, inventario con alertas, condición anormal, resumen ejecutivo con IA, actividades automáticas/manuales/emergentes, multiplanta, modo offline y LubriPlan Card.";
  if (t.includes("quien") || t.includes("industria") || t.includes("para quien")) return "LubriPlan es para jefes de mantenimiento, supervisores y técnicos en manufactura, automotriz, metalmecánica, alimentos y bebidas, y plantas industriales.";
  return "LubriPlan conecta planificación, ejecución, inventario y alertas de lubricación industrial en un solo sistema. Puedo orientarte sobre funcionalidades, cómo funciona o cómo solicitar una demo.";
}

function mockReplyCard(userText) {
  const t = String(userText || "").toLowerCase();
  if (t.includes("demo") || t.includes("contratar") || t.includes("cotiza") || t.includes("precio") || t.includes("costo") || t.includes("cuesta") || t.includes("contacto") || t.includes("interesado")) return DEMO_REQUEST_REPLY_CARD;
  if (t.includes("que es") || t.includes("qué es") || t.includes("cuentame") || t.includes("explica") || t.includes("conocer")) return "LubriPlan Card es la carta de lubricación digital accesible por código QR. El técnico escanea el QR del equipo y ve al instante los puntos de lubricación, lubricante, cantidad, frecuencia y método de aplicación, sin necesidad de login ni instalación.";
  if (t.includes("como funciona") || t.includes("cómo funciona") || t.includes("proceso")) return "El administrador sube el plano del equipo, marca los puntos de lubricación sobre la imagen y se genera un QR único por equipo. El técnico escanea el QR en campo y accede a la carta actualizada en tiempo real desde cualquier celular.";
  if (t.includes("precio") || t.includes("plan") || t.includes("costo") || t.includes("tarifa")) return DEMO_REQUEST_REPLY_CARD;
  if (t.includes("diferencia") || t.includes("vs lubriplan") || t.includes("necesito el sistema")) return "LubriPlan Card puede usarse de forma independiente o como parte del sistema completo LubriPlan. Si solo necesitas digitalizar las cartas de lubricación sin el sistema completo, Card es la opción. Si quieres información para tu caso, compárteme tu nombre, empresa y teléfono.";
  if (t.includes("informacion") || t.includes("información") || t.includes("info")) return DEMO_REQUEST_REPLY_CARD;
  if (t.includes("sin login") || t.includes("sin app") || t.includes("sin instalar") || t.includes("qr")) return "Exacto: LubriPlan Card no requiere login ni instalación. El técnico escanea el QR con la cámara del celular y accede directo a la carta del equipo. Cero fricción en campo.";
  return "LubriPlan Card digitaliza las cartas de lubricación con acceso por QR, sin login ni app. Puedo contarte cómo funciona, qué incluye o cómo solicitar una demo.";
}

// ── Manejador genérico del chat ──────────────────────────────────────────────
async function handleChat({ req, res, prisma, source, systemPrompt, mockFn }) {
  try {
    const ip = extractIp(req);

    if (isProvider && !ipRateLimit(ip)) {
      return res.status(429).json({ error: "Demasiadas consultas. Intenta en unos minutos." });
    }

    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Body JSON requerido" });
    }

    const { messages, sessionId } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array requerido" });
    }
    if (messages.length > MAX_MESSAGES) {
      return res.status(400).json({ error: `Historial demasiado largo (max ${MAX_MESSAGES})` });
    }
    for (const m of messages) {
      if (!m || typeof m !== "object" || !m.role || !m.content || !["user", "assistant"].includes(String(m.role))) {
        return res.status(400).json({ error: "Cada mensaje requiere role (user|assistant) y content" });
      }
      if (String(m.content).length > 2000) {
        return res.status(400).json({ error: "Mensaje demasiado largo (max 2000 caracteres)" });
      }
    }

    let reply, model;
    if (!isProvider) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      reply = mockFn(lastUser?.content);
      model = "mock";
    } else {
      try {
        const client = await getOpenAI();
        const response = await client.chat.completions.create({
          model: LANDING_MODEL,
          // solo role/content y un historial acotado (antes se reenviaba tal cual lo mandaba el navegador)
          messages: [{ role: "system", content: systemPrompt }, ...trimHistory(messages, { maxMessages: 12, maxChars: 6000 })],
          max_tokens: LANDING_MAX_TOKENS,
          temperature: 0.3,
        });
        reply = response.choices?.[0]?.message?.content?.trim() || "";
        model = response.model;
      } catch (aiErr) {
        logger.warn("[landingChat] la IA falló; respuesta predefinida", { source, status: aiErr?.status, error: String(aiErr?.message || "").slice(0, 160) });
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        reply = mockFn(lastUser?.content);
        model = "mock-fallback";
      }
    }

    if (!reply) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      reply = mockFn(lastUser?.content);
    }
    const fullMessages = [...messages.map((m) => ({ role: m.role, content: String(m.content) })), { role: "assistant", content: reply }];
    const hotKeywords = detectHotKeywords(messages);
    const isHotLead = hotKeywords.length > 0;

    if (prisma && sessionId && typeof sessionId === "string" && sessionId.length < 128) {
      try {
        const sid = sessionId.trim();
        const existing = await prisma.landingChatLog.findUnique({ where: { sessionId: sid } });

        await prisma.landingChatLog.upsert({
          where: { sessionId: sid },
          update: { messages: fullMessages, ip, source, isHotLead, hotKeywords },
          create: { sessionId: sid, messages: fullMessages, ip, source, isHotLead, hotKeywords, emailSent: false },
        });

        // Aviso por correo:
        //  - la primera vez que se detecta interés (demo, precio, cotización…)
        //  - y cada vez que el visitante escribe un correo o teléfono en el chat
        //    (antes esas respuestas no llegaban si el aviso de interés ya se había enviado).
        const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.content;
        const sentContact = hasContactInfo(lastUserText);
        const sendInterest = isHotLead && !existing?.emailSent;

        if (sentContact || sendInterest) {
          // Sin await: el visitante no espera al envío del correo.
          notifyChatLead({
            messages: fullMessages,
            ip,
            source,
            keywords: hotKeywords,
            reason: sentContact ? "contact" : "interest",
          })
            .then(async (r) => {
              if (r?.ok && !existing?.emailSent) {
                await prisma.landingChatLog.update({ where: { sessionId: sid }, data: { emailSent: true } });
              }
            })
            .catch((e) => logger.error("[landingChat] Error en aviso por correo:", e?.message));
        }
      } catch (dbErr) {
        logger.error("[landingChat] Error guardando en BD:", dbErr?.message);
      }
    }

    return res.json({ ok: true, reply, model });
  } catch (e) {
    logger.error("[landingChat] Error inesperado:", e?.message, e?.stack);
    return res.status(500).json({ error: "Error en el asistente. Intenta de nuevo." });
  }
}

// ── Router ───────────────────────────────────────────────────────────────────
export default function landingChatRouter(prisma) {
  const router = express.Router();

  // Chat del landing principal de LubriPlan
  router.post("/landing/chat", (req, res) =>
    handleChat({ req, res, prisma, source: "landing", systemPrompt: SYSTEM_PROMPT_LANDING, mockFn: mockReplyLanding })
  );

  // Chat del landing de LubriPlan Card
  router.post("/landing/card/chat", (req, res) =>
    handleChat({ req, res, prisma, source: "card", systemPrompt: SYSTEM_PROMPT_CARD_FINAL, mockFn: mockReplyCard })
  );

  return router;
}
