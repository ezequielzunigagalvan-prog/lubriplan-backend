// src/ia/landingChatRouter.js
// Endpoint público para el chatbot del landing page de LubriPlan.
// Guarda cada conversación en LandingChatLog y notifica por email leads calientes.
import express from "express";
import { Resend } from "resend";
import { AI_MODE, OPENAI_MODEL } from "./aiConfig.js";

const LANDING_MODEL = String(process.env.AI_LANDING_CHAT_MODEL || OPENAI_MODEL || "gpt-4o-mini").trim();
const LANDING_MAX_TOKENS = Number(process.env.AI_LANDING_CHAT_MAX_TOKENS || 400);
const LANDING_IP_LIMIT_PER_HOUR = Number(process.env.AI_LANDING_IP_LIMIT_PER_HOUR || 30);
const MAX_MESSAGES = 20;
const isProvider = String(AI_MODE).toLowerCase() === "provider";

const LEAD_EMAIL = "lubriplan@hidrolub.com";
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

async function sendHotLeadEmail(messages, ip, keywords) {
  try {
    const apiKey = String(process.env.RESEND_API_KEY || "").trim();
    if (!apiKey) return;

    const resend = new Resend(apiKey);
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
      subject: `🔥 Lead caliente en LubriPlan — palabras clave: ${keywords.join(", ")}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;background:#f8fafc;padding:24px;">
          <div style="background:#0f172a;border-radius:16px;padding:20px 24px;margin-bottom:20px;">
            <div style="font-size:22px;font-weight:900;color:#f97316;letter-spacing:-0.5px;">LubriPlan</div>
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
  "REGLAS:",
  "- Responde SIEMPRE en espanol",
  "- Maximo 4-5 oraciones por respuesta",
  "- Tono profesional, tecnico e industrial",
  "- No inventes funcionalidades no listadas",
  "- Siempre termina invitando a la demo o contacto cuando sea relevante",
].join("\n");

const CONOCER_REPLY = "LubriPlan es una plataforma SaaS especializada en gestion de lubricacion industrial que conecta rutas, ejecucion trazable, inventario, condicion anormal y resumen ejecutivo con IA en un solo sistema. Reemplaza el control en Excel, papel o WhatsApp con trazabilidad real por equipo, tecnico y condicion. Esta disenado para jefes de mantenimiento, supervisores y tecnicos que necesitan operar con datos, no suposiciones. Puedes solicitar una demo en hidrolub.com/lubriplan o escribir a lubriplan@hidrolub.com.";

function mockReply(userText) {
  const t = String(userText || "").toLowerCase();
  if (t.includes("conocer") || t.includes("conoce") || t.includes("quiero saber") || t.includes("cuentame") || t.includes("explica") || t.includes("informacion") || t.includes("informame")) return CONOCER_REPLY;
  if (t.includes("que es") || t.includes("qué es")) return "LubriPlan es el sistema de gestion de lubricacion industrial que reemplaza el control en Excel, papel y mensajes. Conecta planificacion, ejecucion trazable, inventario, condicion anormal y alertas con IA en una sola plataforma para jefes de mantenimiento, supervisores y tecnicos.";
  if (t.includes("demo")) return "Puedes solicitar una demo en hidrolub.com/lubriplan o escribiendo a lubriplan@hidrolub.com. El equipo te contactara para mostrarla en tu operacion.";
  if (t.includes("precio") || t.includes("costo") || t.includes("cuesta") || t.includes("plan") || t.includes("tarifa") || t.includes("cotiza")) return "El costo depende del tamano de la operacion y la configuracion. Para una cotizacion puntual, escribe a lubriplan@hidrolub.com o solicita la demo en hidrolub.com/lubriplan.";
  if (t.includes("modulo") || t.includes("funcionalidad") || t.includes("incluye") || t.includes("que tiene") || t.includes("caracteristica")) return "LubriPlan incluye: rutas de lubricacion, ejecucion trazable, inventario con alertas, condicion anormal, resumen ejecutivo con IA, actividades automaticas/manuales/emergentes, multiplanta, modo offline y LubriPlan Card. Todo en una sola plataforma.";
  if (t.includes("card") || t.includes("qr") || t.includes("carta")) return "LubriPlan Card es la carta de lubricacion digital por QR. El tecnico escanea el codigo del equipo y accede a puntos, lubricantes, cantidades y metodos de aplicacion, sin login ni instalacion.";
  if (t.includes("offline") || t.includes("sin red") || t.includes("campo") || t.includes("movil")) return "LubriPlan tiene modo offline completo. El tecnico puede registrar ejecuciones en campo sin conexion a red y los datos se sincronizan automaticamente al reconectarse.";
  if (t.includes("multiplanta") || t.includes("varias plantas") || t.includes("multi")) return "LubriPlan soporta multiplanta con datos completamente separados por operacion. Cada planta tiene su propio contexto, usuarios y configuracion sin ningun cruce de informacion.";
  if (t.includes("ia") || t.includes("inteligencia") || t.includes("ai") || t.includes("resumen") || t.includes("reporte")) return "LubriPlan incluye resumen ejecutivo generado con IA. Analiza automaticamente la operacion del mes, detecta patrones de riesgo y entrega recomendaciones accionables con contexto real de planta.";
  if (t.includes("quien") || t.includes("para que") || t.includes("para quien") || t.includes("industria")) return "LubriPlan es para jefes de mantenimiento, supervisores de lubricacion y tecnicos de campo en manufactura, automotriz, metalmecanica, alimentos y bebidas, y plantas industriales en general.";
  if (t.includes("como funciona") || t.includes("funcionamiento") || t.includes("proceso")) return "El flujo es simple: configuras rutas, frecuencias y criterios. LubriPlan genera las actividades automaticamente, el tecnico las ejecuta con contexto desde su dispositivo, y la jefatura ve indicadores, alertas y resumen ejecutivo en tiempo real.";
  if (t.includes("integra") || t.includes("erp") || t.includes("sap") || t.includes("api")) return "LubriPlan funciona como plataforma autonoma. Para necesidades de integracion con ERP u otros sistemas, contacta al equipo en lubriplan@hidrolub.com con los detalles de tu operacion.";
  if (t.includes("segur") || t.includes("dato") || t.includes("privacidad")) return "LubriPlan opera con datos separados por planta y por empresa. Cada operacion accede unicamente a su propia informacion, con autenticacion por roles y sin mezcla entre clientes.";
  return "LubriPlan conecta planificacion, ejecucion, inventario y alertas de lubricacion industrial en un solo sistema. Puedo orientarte sobre funcionalidades, como funciona o como solicitar una demo.";
}

export default function landingChatRouter(prisma) {
  const router = express.Router();

  router.post("/landing/chat", async (req, res) => {
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

      // Generar respuesta
      let reply, model;
      if (!isProvider) {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        reply = mockReply(lastUser?.content);
        model = "mock";
      } else {
        try {
          const client = await getOpenAIClient();
          const response = await client.chat.completions.create({
            model: LANDING_MODEL,
            messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
            max_tokens: LANDING_MAX_TOKENS,
            temperature: 0.3,
          });
          reply = response.choices?.[0]?.message?.content?.trim() || "";
          model = response.model;
        } catch (aiErr) {
          console.error("[landingChat] OpenAI error, fallback a mock:", aiErr?.message);
          const lastUser = [...messages].reverse().find((m) => m.role === "user");
          reply = mockReply(lastUser?.content);
          model = "mock-fallback";
        }
      }

      // La conversación completa incluye la respuesta que acabamos de generar
      const fullMessages = [...messages, { role: "assistant", content: reply }];

      // Detectar hot lead
      const hotKeywords = detectHotKeywords(messages);
      const isHotLead = hotKeywords.length > 0;

      // Guardar en BD (upsert por sessionId)
      if (prisma && sessionId && typeof sessionId === "string" && sessionId.length < 128) {
        try {
          const sid = sessionId.trim();

          // Recuperar registro previo para saber si ya se envió email
          const existing = await prisma.landingChatLog.findUnique({ where: { sessionId: sid } });

          await prisma.landingChatLog.upsert({
            where: { sessionId: sid },
            update: {
              messages: fullMessages,
              ip,
              isHotLead,
              hotKeywords,
            },
            create: {
              sessionId: sid,
              messages: fullMessages,
              ip,
              isHotLead,
              hotKeywords,
              emailSent: false,
            },
          });

          // Enviar email de lead caliente solo la primera vez que se detecta
          if (isHotLead && !existing?.emailSent) {
            await sendHotLeadEmail(fullMessages, ip, hotKeywords);
            await prisma.landingChatLog.update({
              where: { sessionId: sid },
              data: { emailSent: true },
            });
          }
        } catch (dbErr) {
          console.error("[landingChat] Error guardando en BD:", dbErr?.message);
          // No bloqueamos la respuesta por error de BD
        }
      }

      return res.json({ ok: true, reply, model });
    } catch (e) {
      console.error("[landingChat] Error inesperado:", e?.message, e?.stack);
      return res.status(500).json({ error: "Error en el asistente. Intenta de nuevo." });
    }
  });

  return router;
}
