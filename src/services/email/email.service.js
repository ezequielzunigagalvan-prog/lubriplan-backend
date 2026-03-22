import { Resend } from "resend";
import {
  conditionAlertTemplate,
  criticalAlertTemplate,
  overdueSummaryTemplate,
  monthlyExecutiveReportTemplate,
} from "./email.templates.js";
import { getPlantAlertRecipients } from "./email.recipients.js";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || "LubriPlan <onboarding@resend.dev>";
const APP_BASE_URL = String(process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.warn("[email] RESEND_API_KEY no configurado. Correo omitido:", subject);
    return { ok: false, skipped: true, reason: "RESEND_NOT_CONFIGURED" };
  }

  if (!Array.isArray(to) || to.length === 0) {
    return { ok: false, skipped: true, reason: "NO_RECIPIENTS" };
  }

  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to,
    subject,
    html,
  });

  return { ok: true, result };
}

export async function sendConditionAlertEmail({ prisma, payload }) {
  const recipients = await getPlantAlertRecipients({
    prisma,
    plantId: payload.plantId,
    roles: ["ADMIN", "SUPERVISOR"],
  });

  const { subject, html } = conditionAlertTemplate({
    ...payload,
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
  const recipients = await getPlantAlertRecipients({
    prisma,
    plantId: payload.plantId,
    roles: ["ADMIN", "SUPERVISOR"],
  });

  const { subject, html } = criticalAlertTemplate({
    ...payload,
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
      `${APP_BASE_URL}/reports/monthly-intelligent?month=${payload.month}`,
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