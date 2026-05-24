// src/ia/landingChatRouter.js
// Endpoints públicos de chatbot para landing principal y landing de LubriPlan Card.
import express from "express";
import { Resend } from "resend";
import { AI_MODE, OPENAI_MODEL } from "./aiConfig.js";

const LANDING_MODEL = String(process.env.AI_LANDING_CHAT_MODEL || OPENAI_MODEL || "gpt-4o-mini").trim();
const LANDING_MAX_TOKENS = Number(process.env.AI_LANDING_CHAT_MAX_TOKENS || 400);
const LANDING_IP_LIMIT_PER_HOUR = Number(process.env.AI_LANDING_IP_LIMIT_PER_HOUR || 30);
const MAX_MESSAGES = 20;
const isProvider = String(AI_MODE).toLowerCase() === "provider";

const LEAD_EMAIL = process.env.LEAD_EMAIL || "lubriplan@hidrolub.com";
const EMAIL_FROM = process.env.EMAIL_FROM || "LubriPlan <onboarding@resend.dev>";

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

async function sendHotLeadEmail(messages, ip, keywords, source) {
  try {
    const apiKey = String(process.env.RESEND_API_KEY || "").trim();
    if (!apiKey) return;

    const resend = new Resend(apiKey);
    const sourceLabel = source === "card" ? "LubriPlan Card" : "LubriPlan";
    const transcript = messages
      .map((m) => `<tr>
        <td style="padding:8px 12px;font-weight:900;color:${m.role === "user" ? "#f97316" : "#64748b"};white-space:nowrap;vertical-align:top;font-size:12px;">
          ${m.role === "user" ? "Visitante" : "LubriBot"}
        </td>
        <td style="padding:8px 12px;color:#1e293b;font-size:13px;line-height:1.55;">${String(m.content || "").replace(/</g, "&lt;")}</td>
      </tr>`)
      .join("");

    await resend.emails.send({
      from: EMAIL_FROM,
      to: [LEAD_EMAIL],
      subject: `🔥 Lead caliente en ${sourceLabel} — palabras clave: ${keywords.join(", ")}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;background:#f8fafc;padding:24px;">
          <div style="background:#0f172a;border-radius:16px;padding:20px 24px;margin-bottom:20px;">
            <div style="font-size:22px;font-weight:900;color:#f97316;letter-spacing:-0.5px;">${sourceLabel}</div>
            <div style="font-size:13px;color:#94a3b8;margin-top:4px;">Nuevo lead caliente desde el landing</div>
          </div>

          <div style="background:#fff;border-radius:12px;padding:16px 20px;margin-bottom:16px;border:1px solid #e2e8f0;">
            <div style="font-size:11px;font-weight:900;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Detectado</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              ${keywords.map((kw) => `<span style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:900;">${kw}</span>`).join("")}
            </div>
          </div>

          <div style="background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;margin-bottom:16px;">
            <div style="padding:12px 20px;border-bottom:1px solid #e2e8f0;">
              <span style="font-size:11px;font-weight:900;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Conversación completa</span>
            </div>
            <table style="width:100%;border-collapse:collapse;">
              ${transcript}
            </table>
          </div>

          <div style="font-size:11px;color:#94a3b8;text-align:center;">
            IP: ${ip} · Mensajes: ${messages.length} · ${new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}
          </div>
        </div>
      `,
    });
  } catch (e) {
    console.error("[landingChat] Error enviando email lead:", e?.message);
  }
}

async function getOpenAIClient() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY no configurada");
  const mod = await import("openai");
  const OpenAI = mod?.default || mod?.OpenAI || mod;
  return new OpenAI({ apiKey });
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
  "PLANES DISPONIBLES (precios en pesos mexicanos):",
  "- Card Basica ($890 MXN/mes): hasta 30 equipos con tarjeta QR, historial ilimitado, multiples puntos, panel de administracion, exportar PDF",
  "- Card Pro ($1,690 MXN/mes): equipos ilimitados, evidencia fotografica, alertas de vencimiento automaticas, reportes y analisis, multiusuario",
  "- LubriPlan + Card ($3,990 MXN/mes): todo Card Pro mas el sistema completo LubriPlan (rutas, actividades, inventario, reportes IA, multiplanta)",
  "Los primeros dos planes son solo para cartas de lubricacion. El tercero incluye la integracion con el sistema de gestion completo.",
  "",
  "SOLICITAR DEMO O COTIZACION:",
  "Cuando el prospecto pida una demo, precio, cotizacion o quiera ser contactado, responde exactamente asi:",
  "«Para enviarte informacion y agendar tu demo de LubriPlan Card, necesito algunos datos. ¿Puedes compartirme tu nombre completo, correo electronico, telefono y empresa (esta ultima es opcional)?»",
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

const DEMO_REQUEST_REPLY_CARD =
  "Para enviarte información y agendar tu demo de LubriPlan Card, necesito algunos datos. ¿Puedes compartirme tu nombre completo, correo electrónico, teléfono y empresa (esta última es opcional)?";

function mockReplyLanding(userText) {
  const t = String(userText || "").toLowerCase();
  if (t.includes("demo") || t.includes("contratar") || t.includes("cotiza") || t.includes("precio") || t.includes("costo") || t.includes("cuesta") || t.includes("contacto") || t.includes("interesado")) return DEMO_REQUEST_REPLY;
  if (t.includes("conocer") || t.includes("cuentame") || t.includes("explica") || t.includes("que es") || t.includes("qué es")) return "LubriPlan es el sistema de gestión de lubricación industrial que reemplaza el control en Excel, papel y mensajes. Conecta planificación, ejecución trazable, inventario, condición anormal y alertas con IA en una sola plataforma para jefes de mantenimiento, supervisores y técnicos.";
  if (t.includes("card") || t.includes("qr") || t.includes("carta")) return "LubriPlan Card es la carta de lubricación digital por QR. El técnico escanea el código del equipo y accede a puntos, lubricantes, cantidades y métodos de aplicación, sin login ni instalación.";
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
  if (t.includes("diferencia") || t.includes("vs lubriplan") || t.includes("necesito el sistema")) return "LubriPlan Card puede usarse de forma independiente (Card Básica desde $79/mes) o como parte de LubriPlan Professional ($499/mes). Si solo necesitas digitalizar las cartas de lubricación sin el sistema completo, Card es la opción.";
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
        const client = await getOpenAIClient();
        const response = await client.chat.completions.create({
          model: LANDING_MODEL,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          max_tokens: LANDING_MAX_TOKENS,
          temperature: 0.3,
        });
        reply = response.choices?.[0]?.message?.content?.trim() || "";
        model = response.model;
      } catch (aiErr) {
        console.error("[landingChat] OpenAI error, fallback a mock:", aiErr?.message);
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        reply = mockFn(lastUser?.content);
        model = "mock-fallback";
      }
    }

    const fullMessages = [...messages, { role: "assistant", content: reply }];
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

        if (isHotLead && !existing?.emailSent) {
          await sendHotLeadEmail(fullMessages, ip, hotKeywords, source);
          await prisma.landingChatLog.update({ where: { sessionId: sid }, data: { emailSent: true } });
        }
      } catch (dbErr) {
        console.error("[landingChat] Error guardando en BD:", dbErr?.message);
      }
    }

    return res.json({ ok: true, reply, model });
  } catch (e) {
    console.error("[landingChat] Error inesperado:", e?.message, e?.stack);
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
    handleChat({ req, res, prisma, source: "card", systemPrompt: SYSTEM_PROMPT_CARD, mockFn: mockReplyCard })
  );

  return router;
}
