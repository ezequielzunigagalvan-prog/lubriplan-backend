// src/services/email/leadNotifier.js
// Avisos por correo de prospectos de la landing (formulario de demo y chatbot).
//
// El destinatario se configura SOLO en el servidor con LEAD_EMAIL (uno o varios separados por coma).
// Nunca se envía al navegador: el visitante no ve a dónde llegan sus datos.

import { sendEmail } from "./email.service.js";
import { escapeHtml, dedupeEmails } from "./email.utils.js";
import { logger } from "../../config/logger.js";

export function getLeadRecipients() {
  return dedupeEmails(String(process.env.LEAD_EMAIL || "").split(","));
}

function sourceLabel(source) {
  return source === "card" ? "LubriPlan Card" : "LubriPlan";
}

function stamp() {
  return new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
}

function layout({ title, subtitle, body, footer }) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;background:#f4f5f7;padding:24px;">
    <div style="background:#0a0c0f;border-radius:12px;padding:20px 24px;margin-bottom:18px;border-top:4px solid #f97316;">
      <div style="font-size:20px;font-weight:800;color:#f97316;">${escapeHtml(title)}</div>
      <div style="font-size:13px;color:#9aa4b2;margin-top:4px;">${escapeHtml(subtitle)}</div>
    </div>
    ${body}
    <div style="font-size:11px;color:#94a3b8;text-align:center;margin-top:14px;">${footer}</div>
  </div>`;
}

function row(label, valueHtml) {
  return `<tr style="border-top:1px solid #f1f5f9;">
    <td style="padding:9px 0;font-size:12px;font-weight:700;color:#94a3b8;width:120px;text-transform:uppercase;letter-spacing:.5px;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:9px 0;font-size:14px;color:#0f172a;">${valueHtml}</td>
  </tr>`;
}

async function deliver({ subject, html, replyTo }) {
  const to = getLeadRecipients();
  if (!to.length) {
    logger.warn("[leads] LEAD_EMAIL no configurado: el aviso no se envió", { subject });
    return { ok: false, reason: "NO_LEAD_EMAIL" };
  }
  try {
    return await sendEmail({ to, subject, html, replyTo });
  } catch (e) {
    logger.error("[leads] Error enviando aviso", { subject, msg: e?.message });
    return { ok: false, reason: "SEND_ERROR" };
  }
}

/** Formulario de "Solicitar demo" o formulario dentro del chat. */
export async function notifyDemoRequest({ nombre, email, telefono, empresa, source, ip, origin }) {
  const label = sourceLabel(source);
  const safeEmail = escapeHtml(email);
  const body = `
    <div style="background:#fff;border-radius:10px;padding:18px 22px;border:1px solid #e2e8f0;">
      <table style="width:100%;border-collapse:collapse;">
        ${row("Nombre", `<b>${escapeHtml(nombre)}</b>`)}
        ${email ? row("Correo", `<a href="mailto:${safeEmail}" style="color:#ea580c;text-decoration:none;">${safeEmail}</a>`) : row("Correo", "No proporcionado")}
        ${row("Teléfono", escapeHtml(telefono))}
        ${empresa ? row("Empresa", escapeHtml(empresa)) : ""}
        ${row("Producto", escapeHtml(label))}
        ${row("Origen", escapeHtml(origin === "chat" ? "Formulario del chatbot" : "Formulario «Solicitar demo»"))}
      </table>
    </div>
    ${email ? `<div style="font-size:12px;color:#64748b;margin-top:12px;">Puedes responder este correo directamente: la respuesta irá al prospecto.</div>` : ""}`;

  return deliver({
    subject: `${source === "card" ? "Solicitud de información" : "Nueva solicitud de demo"} — ${nombre}${empresa ? ` (${empresa})` : ""}`,
    html: layout({
      title: label,
      subtitle: "Nueva solicitud de demo",
      body,
      footer: `IP: ${escapeHtml(ip)} · ${escapeHtml(stamp())}`,
    }),
    replyTo: email || undefined,
  });
}

/** Conversación del chatbot (interés detectado o datos de contacto escritos en el chat). */
export async function notifyChatLead({ messages, ip, source, keywords = [], reason }) {
  const label = sourceLabel(source);
  const transcript = messages
    .map((m) => {
      const isUser = m.role === "user";
      return `<tr>
        <td style="padding:8px 12px;font-weight:700;color:${isUser ? "#ea580c" : "#64748b"};white-space:nowrap;vertical-align:top;font-size:12px;">${isUser ? "Visitante" : "LubriBot"}</td>
        <td style="padding:8px 12px;color:#1e293b;font-size:13px;line-height:1.55;">${escapeHtml(m.content).replace(/\n/g, "<br>")}</td>
      </tr>`;
    })
    .join("");

  const tags = keywords.length
    ? `<div style="background:#fff;border-radius:10px;padding:14px 20px;margin-bottom:14px;border:1px solid #e2e8f0;">
        <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Palabras detectadas</div>
        ${keywords.map((k) => `<span style="display:inline-block;margin:0 6px 6px 0;background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;">${escapeHtml(k)}</span>`).join("")}
      </div>`
    : "";

  const body = `${tags}
    <div style="background:#fff;border-radius:10px;border:1px solid #e2e8f0;overflow:hidden;">
      <div style="padding:12px 20px;border-bottom:1px solid #e2e8f0;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Conversación completa</div>
      <table style="width:100%;border-collapse:collapse;">${transcript}</table>
    </div>`;

  const subject =
    reason === "contact"
      ? `Datos de contacto en el chat de ${label}`
      : `Prospecto interesado en el chat de ${label}`;

  return deliver({
    subject,
    html: layout({
      title: label,
      subtitle: reason === "contact" ? "El visitante escribió sus datos de contacto" : "Interés detectado en el chatbot",
      body,
      footer: `IP: ${escapeHtml(ip)} · Mensajes: ${messages.length} · ${escapeHtml(stamp())}`,
    }),
  });
}

/** ¿El texto trae un correo o un teléfono? */
export function hasContactInfo(text) {
  const t = String(text || "");
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(t)) return true;
  const digits = t.replace(/[^\d]/g, "");
  return /(\+?\d[\d\s().-]{7,}\d)/.test(t) && digits.length >= 8;
}
