import { Resend } from "resend";
import nodemailer from "nodemailer";
import {
  conditionAlertTemplate,
  criticalAlertTemplate,
  overdueSummaryTemplate,
  monthlyExecutiveReportTemplate,
} from "./email.templates.js";
import { getPlantAlertRecipients } from "./email.recipients.js";
import { logger } from "../../config/logger.js";

// ── Proveedores de email ─────────────────────────────────────────────────────
// Prioridad: RESEND_API_KEY (cloud) → SMTP_HOST (local) → ninguno (warn)
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const smtpTransport = !resend && process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || "LubriPlan <noreply@lubriplan.local>";
const APP_BASE_URL = String(process.env.APP_BASE_URL || "http://localhost").replace(/\/$/, "");
const API_PUBLIC_BASE_URL = String(
  process.env.API_PUBLIC_BASE_URL || process.env.APP_BASE_URL || "http://localhost"
).replace(/\/$/, "");

async function getEmailSettings(prisma) {
  if (!prisma?.appSettings) return null;
  return prisma.appSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
}

async function checkEmailEnabled(prisma, key) {
  const settings = await getEmailSettings(prisma);
  if (!settings) return { ok: true };
  if (settings[key] === false) {
    return { ok: false, skipped: true, reason: "EMAIL_DISABLED_BY_SETTINGS" };
  }
  return { ok: true };
}

function absolutizeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  if (/^data:/i.test(raw)) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${API_PUBLIC_BASE_URL}${raw}`;
  return `${API_PUBLIC_BASE_URL}/${raw}`;
}

async function sendEmail({ to, subject, html }) {
  if (!Array.isArray(to) || to.length === 0) {
    return { ok: false, skipped: true, reason: "NO_RECIPIENTS" };
  }

  // ── Resend (cloud) ──────────────────────────────────────────────────────────
  if (resend) {
    const result = await resend.emails.send({ from: EMAIL_FROM, to, subject, html });
    return { ok: true, provider: "resend", result };
  }

  // ── SMTP (local / on-premise) ───────────────────────────────────────────────
  if (smtpTransport) {
    const info = await smtpTransport.sendMail({ from: EMAIL_FROM, to, subject, html });
    logger.info("[email] SMTP enviado", { messageId: info.messageId, subject });
    return { ok: true, provider: "smtp", result: info };
  }

  // ── Sin proveedor configurado ───────────────────────────────────────────────
  logger.warn("[email] Sin proveedor de email configurado. Correo omitido:", subject);
  return { ok: false, skipped: true, reason: "NO_EMAIL_PROVIDER" };
}

export async function sendConditionAlertEmail({ prisma, payload }) {
  const emailStatus = await checkEmailEnabled(prisma, "conditionReportEmailEnabled");
  if (!emailStatus.ok) return emailStatus;

  const recipients = await getPlantAlertRecipients({
    prisma,
    plantId: payload.plantId,
    roles: ["ADMIN", "SUPERVISOR"],
  });

  const { subject, html } = conditionAlertTemplate({
    ...payload,
    observation: payload.observation || payload.description || "",
    evidenceImage: absolutizeUrl(payload.evidenceImage),
    link:
      payload.link ||
      `${APP_BASE_URL}/condition-reports?status=OPEN`,
  });

  return sendEmail({
    to: recipients,
    subject,
    html,
  });
}

export async function sendCriticalActivityEmail({ prisma, payload }) {
  const emailStatus = await checkEmailEnabled(prisma, "criticalActivityEmailEnabled");
  if (!emailStatus.ok) return emailStatus;

  const recipients = await getPlantAlertRecipients({
    prisma,
    plantId: payload.plantId,
    roles: ["ADMIN", "SUPERVISOR"],
  });

  const { subject, html } = criticalAlertTemplate({
    ...payload,
    observation: payload.observation || payload.observations || payload.reason || "",
    evidenceImage: absolutizeUrl(payload.evidenceImage),
    link:
      payload.link ||
      `${APP_BASE_URL}/activities`,
  });

  return sendEmail({
    to: recipients,
    subject,
    html,
  });
}

export async function sendOverdueSummaryEmail({ prisma, payload }) {
  const emailStatus = await checkEmailEnabled(prisma, "overdueSummaryEmailEnabled");
  if (!emailStatus.ok) return emailStatus;

  const recipients = await getPlantAlertRecipients({
    prisma,
    plantId: payload.plantId,
    roles: ["ADMIN", "SUPERVISOR"],
  });

  if (!recipients || recipients.length === 0) {
    return { ok: false, skipped: true, reason: "NO_RECIPIENTS", recipients: [] };
  }

  const { subject, html } = overdueSummaryTemplate({
    plantName: payload.plantName,
    totalOverdue: payload.totalOverdue,
    criticalOverdue: payload.criticalOverdue,
    unassignedOverdue: payload.unassignedOverdue,
    generatedAt: payload.generatedAt,
    link:
      payload.link ||
      `${APP_BASE_URL}/activities?status=OVERDUE&month=${payload.month}`,
  });

  const sendRes = await sendEmail({
    to: recipients,
    subject,
    html,
  });

  return {
    ...sendRes,
    recipients,
  };
}

export async function sendMonthlyExecutiveReportEmail({ prisma, payload }) {
  const emailStatus = await checkEmailEnabled(prisma, "monthlyReportEmailEnabled");
  if (!emailStatus.ok) return emailStatus;

  const recipients = await getPlantAlertRecipients({
    prisma,
    plantId: payload.plantId,
    roles: ["ADMIN", "SUPERVISOR"],
    includeExtraPlantRecipients: true,
  });

  if (!recipients || recipients.length === 0) {
    return {
      ok: false,
      skipped: true,
      reason: "NO_RECIPIENTS",
      recipients: [],
      subject: null,
    };
  }

  const { subject, html } = monthlyExecutiveReportTemplate({
    ...payload,
    link:
      payload.link ||
      `${APP_BASE_URL}/reports/monthly?month=${payload.month}`,
  });

  const result = await sendEmail({
    to: recipients,
    subject,
    html,
  });

  return {
    ...result,
    recipients,
    subject,
  };
}
