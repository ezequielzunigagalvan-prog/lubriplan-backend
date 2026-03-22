import { escapeHtml, fmtDateTimeMx } from "./email.utils.js";

function baseLayout({ title, subtitle, bodyHtml, ctaLabel, ctaUrl }) {
  const safeTitle = escapeHtml(title);
  const safeSubtitle = escapeHtml(subtitle || "");
  const safeCtaLabel = escapeHtml(ctaLabel || "Abrir");
  const safeCtaUrl = escapeHtml(ctaUrl || "#");

  return `
  <!doctype html>
  <html lang="es">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${safeTitle}</title>
    </head>
    <body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:680px;margin:0 auto;padding:24px;">
        <div style="background:#0f172a;border-radius:16px 16px 0 0;padding:20px 24px;">
          <div style="font-size:22px;font-weight:800;color:#ffffff;">LubriPlan</div>
          <div style="margin-top:6px;font-size:13px;color:#cbd5e1;">${safeSubtitle}</div>
        </div>

        <div style="background:#f97316;height:6px;"></div>

        <div style="background:#ffffff;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;">
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0f172a;">${safeTitle}</h1>

          <div style="font-size:14px;line-height:1.6;color:#334155;">
            ${bodyHtml}
          </div>

          ${
            ctaUrl
              ? `
            <div style="margin-top:24px;">
              <a
                href="${safeCtaUrl}"
                style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700;"
              >
                ${safeCtaLabel}
              </a>
            </div>
          `
              : ""
          }

          <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
            Este correo fue generado automáticamente por LubriPlan.
          </div>
        </div>
      </div>
    </body>
  </html>
  `;
}

function detailRow(label, value) {
  return `
    <tr>
      <td style="padding:8px 0;width:170px;font-weight:700;color:#475569;vertical-align:top;">
        ${escapeHtml(label)}
      </td>
      <td style="padding:8px 0;color:#0f172a;">
        ${escapeHtml(value)}
      </td>
    </tr>
  `;
}

export function conditionAlertTemplate(payload) {
  const {
    plantName,
    equipmentName,
    equipmentCode,
    areaName,
    reportedByName,
    severity,
    category,
    description,
    detectedAt,
    link,
  } = payload;

  const bodyHtml = `
    <p style="margin:0 0 16px;">
      Se registró una condición anormal en un equipo. Se recomienda revisar el reporte y definir una acción correctiva lo antes posible.
    </p>

    <table style="width:100%;border-collapse:collapse;">
      ${detailRow("Planta", plantName || "—")}
      ${detailRow("Equipo", equipmentName || "—")}
      ${detailRow("Código", equipmentCode || "—")}
      ${detailRow("Área", areaName || "—")}
      ${detailRow("Reportado por", reportedByName || "—")}
      ${detailRow("Severidad", severity || "—")}
      ${detailRow("Categoría", category || "—")}
      ${detailRow("Fecha / hora", fmtDateTimeMx(detectedAt))}
      ${detailRow("Descripción", description || "—")}
    </table>
  `;

  return {
    subject: "[LubriPlan] Condición anormal reportada en equipo",
    html: baseLayout({
      title: "Condición anormal reportada",
      subtitle: "Alerta operativa",
      bodyHtml,
      ctaLabel: "Ver reporte",
      ctaUrl: link,
    }),
  };
}

export function criticalAlertTemplate(payload) {
  const {
    plantName,
    equipmentName,
    equipmentCode,
    riskLevel,
    reason,
    occurredAt,
    suggestedAction,
    link,
  } = payload;

  const bodyHtml = `
    <p style="margin:0 0 16px;">
      LubriPlan detectó un evento crítico que requiere atención inmediata.
    </p>

    <table style="width:100%;border-collapse:collapse;">
      ${detailRow("Planta", plantName || "—")}
      ${detailRow("Equipo", equipmentName || "—")}
      ${detailRow("Código", equipmentCode || "—")}
      ${detailRow("Nivel de riesgo", riskLevel || "CRÍTICO")}
      ${detailRow("Motivo", reason || "—")}
      ${detailRow("Fecha / hora", fmtDateTimeMx(occurredAt))}
      ${detailRow("Acción sugerida", suggestedAction || "Revisar detalle y atender de inmediato")}
    </table>
  `;

  return {
    subject: "[LubriPlan] Alerta crítica de lubricación",
    html: baseLayout({
      title: "Alerta crítica de lubricación",
      subtitle: "Evento crítico detectado",
      bodyHtml,
      ctaLabel: "Ver detalle",
      ctaUrl: link,
    }),
  };
}

export function overdueSummaryTemplate(payload) {
  const {
    plantName,
    totalOverdue,
    criticalOverdue,
    unassignedOverdue,
    generatedAt,
    link,
  } = payload;

  const bodyHtml = `
    <p style="margin:0 0 16px;">
      Este es el resumen de actividades vencidas detectadas por LubriPlan.
    </p>

    <table style="width:100%;border-collapse:collapse;">
      ${detailRow("Planta", plantName || "—")}
      ${detailRow("Fecha del resumen", fmtDateTimeMx(generatedAt))}
      ${detailRow("Total vencidas", String(totalOverdue ?? 0))}
      ${detailRow("Críticas", String(criticalOverdue ?? 0))}
      ${detailRow("Sin técnico", String(unassignedOverdue ?? 0))}
    </table>
  `;

  return {
    subject: "[LubriPlan] Resumen de actividades vencidas",
    html: baseLayout({
      title: "Resumen de actividades vencidas",
      subtitle: "Seguimiento operativo",
      bodyHtml,
      ctaLabel: "Ir al dashboard",
      ctaUrl: link,
    }),
  };
}

function monthLabelEs(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) return String(ym || "—");

  const [y, m] = String(ym).split("-").map(Number);
  const d = new Date(y, (m || 1) - 1, 1);

  return d.toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    month: "long",
    year: "numeric",
  });
}

function renderList(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<p style="margin:0;">—</p>`;
  }

  return `
    <ul style="margin:8px 0 0 18px;padding:0;">
      ${items
        .map(
          (x) => `
            <li style="margin:0 0 8px;color:#0f172a;">
              ${escapeHtml(x)}
            </li>
          `
        )
        .join("")}
    </ul>
  `;
}

function renderRisks(risks = []) {
  if (!Array.isArray(risks) || risks.length === 0) {
    return `<p style="margin:0;">Sin riesgos relevantes detectados.</p>`;
  }

  return risks
    .slice(0, 5)
    .map((r) => {
      const level = String(r?.level || "LOW").toUpperCase();
      const message = r?.message || "—";
      const action = r?.action || "—";

      return `
        <div style="margin:0 0 12px;padding:12px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;">
          <div style="font-weight:700;color:#0f172a;margin-bottom:6px;">
            ${escapeHtml(message)}
          </div>
          <div style="font-size:12px;color:#475569;margin-bottom:4px;">
            Nivel: <b>${escapeHtml(level)}</b>
          </div>
          <div style="font-size:12px;color:#475569;">
            Acción sugerida: <b>${escapeHtml(action)}</b>
          </div>
        </div>
      `;
    })
    .join("");
}

export function monthlyExecutiveReportTemplate(payload) {
  const {
    plantName,
    month,
    generatedAt,
    completed,
    pending,
    overdue,
    total,
    compliance,
    opEfficiency,
    lowStock,
    unassigned,
    conditionOpen,
    executiveSummary,
    highlights,
    recommendations,
    risks,
    link,
  } = payload;

  const bodyHtml = `
    <p style="margin:0 0 16px;">
      Te compartimos el reporte inteligente mensual generado automáticamente por LubriPlan.
    </p>

    <table style="width:100%;border-collapse:collapse;">
      ${detailRow("Planta", plantName || "—")}
      ${detailRow("Periodo", monthLabelEs(month))}
      ${detailRow("Generado", fmtDateTimeMx(generatedAt))}
      ${detailRow("Total actividades", String(total ?? 0))}
      ${detailRow("Completadas", String(completed ?? 0))}
      ${detailRow("Pendientes", String(pending ?? 0))}
      ${detailRow("Atrasadas", String(overdue ?? 0))}
      ${detailRow("Cumplimiento", `${Number(compliance ?? 0)}%`)}
      ${detailRow("Eficiencia operativa", `${Number(opEfficiency ?? 0)}%`)}
      ${detailRow("Lubricantes bajo stock", String(lowStock ?? 0))}
      ${detailRow("Pendientes sin técnico", String(unassigned ?? 0))}
      ${detailRow("Condición abierta / en progreso", String(conditionOpen ?? 0))}
    </table>

    <div style="margin-top:22px;">
      <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:8px;">
        Resumen ejecutivo
      </div>
      <div style="font-size:14px;line-height:1.6;color:#334155;">
        ${escapeHtml(executiveSummary || "Sin resumen disponible.")}
      </div>
    </div>

    <div style="margin-top:22px;">
      <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:8px;">
        Highlights
      </div>
      ${renderList(highlights)}
    </div>

    <div style="margin-top:22px;">
      <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:8px;">
        Riesgos principales
      </div>
      ${renderRisks(risks)}
    </div>

    <div style="margin-top:22px;">
      <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:8px;">
        Recomendaciones
      </div>
      ${renderList(recommendations)}
    </div>
  `;

  return {
    subject: `[LubriPlan] Reporte inteligente mensual · ${plantName || "Planta"} · ${monthLabelEs(month)}`,
    html: baseLayout({
      title: "Reporte inteligente mensual",
      subtitle: "Seguimiento ejecutivo automático",
      bodyHtml,
      ctaLabel: "Ver reporte mensual",
      ctaUrl: link,
    }),
  };
}

function monthLabelEs(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) return String(ym || "—");

  const [y, m] = String(ym).split("-").map(Number);
  const d = new Date(y, (m || 1) - 1, 1);

  return d.toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    month: "long",
    year: "numeric",
  });
}

function renderList(items = []) {
  if (!Array.isArray(items) || items.length === 0) return "<p style=\"margin:0;\">—</p>";

  return `
    <ul style="margin:8px 0 0 18px;padding:0;">
      ${items
        .map(
          (x) => `
            <li style="margin:0 0 8px;color:#0f172a;">
              ${escapeHtml(x)}
            </li>
          `
        )
        .join("")}
    </ul>
  `;
}

function renderRisks(risks = []) {
  if (!Array.isArray(risks) || risks.length === 0) {
    return `<p style="margin:0;">Sin riesgos relevantes detectados.</p>`;
  }

  return risks
    .slice(0, 5)
    .map((r) => {
      const level = String(r?.level || "LOW").toUpperCase();
      const message = r?.message || "—";
      const action = r?.action || "—";

      return `
        <div style="margin:0 0 12px;padding:12px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;">
          <div style="font-weight:700;color:#0f172a;margin-bottom:6px;">
            ${escapeHtml(message)}
          </div>
          <div style="font-size:12px;color:#475569;margin-bottom:4px;">
            Nivel: <b>${escapeHtml(level)}</b>
          </div>
          <div style="font-size:12px;color:#475569;">
            Acción sugerida: <b>${escapeHtml(action)}</b>
          </div>
        </div>
      `;
    })
    .join("");
}

export function monthlyExecutiveReportTemplate(payload) {
  const {
    plantName,
    month,
    generatedAt,
    completed,
    pending,
    overdue,
    total,
    compliance,
    opEfficiency,
    lowStock,
    unassigned,
    conditionOpen,
    executiveSummary,
    highlights,
    recommendations,
    risks,
    link,
  } = payload;

  const bodyHtml = `
    <p style="margin:0 0 16px;">
      Te compartimos el reporte inteligente mensual generado automáticamente por LubriPlan.
    </p>

    <table style="width:100%;border-collapse:collapse;">
      ${detailRow("Planta", plantName || "—")}
      ${detailRow("Periodo", monthLabelEs(month))}
      ${detailRow("Generado", fmtDateTimeMx(generatedAt))}
      ${detailRow("Total actividades", String(total ?? 0))}
      ${detailRow("Completadas", String(completed ?? 0))}
      ${detailRow("Pendientes", String(pending ?? 0))}
      ${detailRow("Atrasadas", String(overdue ?? 0))}
      ${detailRow("Cumplimiento", `${Number(compliance ?? 0)}%`)}
      ${detailRow("Eficiencia operativa", `${Number(opEfficiency ?? 0)}%`)}
      ${detailRow("Lubricantes bajo stock", String(lowStock ?? 0))}
      ${detailRow("Pendientes sin técnico", String(unassigned ?? 0))}
      ${detailRow("Condición abierta / en progreso", String(conditionOpen ?? 0))}
    </table>

    <div style="margin-top:22px;">
      <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:8px;">
        Resumen ejecutivo
      </div>
      <div style="font-size:14px;line-height:1.6;color:#334155;">
        ${escapeHtml(executiveSummary || "Sin resumen disponible.")}
      </div>
    </div>

    <div style="margin-top:22px;">
      <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:8px;">
        Highlights
      </div>
      ${renderList(highlights)}
    </div>

    <div style="margin-top:22px;">
      <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:8px;">
        Riesgos principales
      </div>
      ${renderRisks(risks)}
    </div>

    <div style="margin-top:22px;">
      <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:8px;">
        Recomendaciones
      </div>
      ${renderList(recommendations)}
    </div>
  `;

  return {
    subject: `[LubriPlan] Reporte inteligente mensual · ${plantName || "Planta"} · ${monthLabelEs(month)}`,
    html: baseLayout({
      title: "Reporte inteligente mensual",
      subtitle: "Seguimiento ejecutivo automático",
      bodyHtml,
      ctaLabel: "Ver reporte mensual",
      ctaUrl: link,
    }),
  };
}