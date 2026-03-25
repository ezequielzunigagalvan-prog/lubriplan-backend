import { AISummarySchemaVersioned } from "./aiSchema.zod.js";
import {
  AI_MODE,
  AI_CACHE_TTL_MS,
  AI_SCHEMA_VERSION,
  OPENAI_MODEL,
} from "./aiConfig.js";
import { cacheGet, cacheSet, makeCacheKey } from "./aiCache.js";
import { generateExecutiveSummary } from "./openaiProvider.js";

function cacheScopeForRole(role) {
  const r = String(role || "").toUpperCase();
  if (r === "TECHNICIAN") return "USER";
  return "ROLE";
}

function ttlMs() {
  const ms = Number(AI_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
  return Math.max(60_000, ms);
}

function shortList(items = [], max = 3) {
  return Array.isArray(items) ? items.slice(0, max) : [];
}

function buildPrompt({ month, plantId, role, lang, dashboard }) {
  const activities = dashboard?.activities || {};
  const alerts = dashboard?.alerts || {};
  const counts = dashboard?.counts || {};
  const predictive = dashboard?.predictive || {};

  const payload = {
    month,
    plantId,
    role,
    lang,
    counts: {
      totalRoutes: Number(counts.totalRoutes || 0),
      totalEquipments: Number(counts.totalEquipments || 0),
    },
    activities: {
      completed: Number(activities.completed || 0),
      pending: Number(activities.pending || 0),
      overdue: Number(activities.overdue || 0),
      total: Number(activities.total || 0),
      conditionReports: {
        OPEN: Number(activities?.conditionReports?.OPEN || 0),
        IN_PROGRESS: Number(activities?.conditionReports?.IN_PROGRESS || 0),
        RESOLVED: Number(activities?.conditionReports?.RESOLVED || 0),
        DISMISSED: Number(activities?.conditionReports?.DISMISSED || 0),
      },
    },
    operationalAlerts: {
      overdueActivities: Number(alerts.overdueActivities || 0),
      conditionOpenCount: Number(alerts.conditionOpenCount || 0),
      conditionInProgressCount: Number(alerts.conditionInProgressCount || 0),
      lowStockCount:
        alerts.lowStockCount == null ? null : Number(alerts.lowStockCount || 0),
      unassignedPending:
        alerts.unassignedPending == null
          ? null
          : Number(alerts.unassignedPending || 0),
    },
    predictiveAlerts: {
      daysToEmptyCount: Number(alerts.daysToEmptyCount || 0),
      consumptionAnomaliesCount: Number(alerts.consumptionAnomaliesCount || 0),
      predictiveSignalsCount: Number(alerts.predictiveSignalsCount || 0),
      daysToEmptyTop: shortList(predictive?.lubricantDaysToEmptyTop, 3).map((x) => ({
        lubricantName: x?.lubricantName || x?.name || "Lubricante",
        daysToEmpty: x?.daysToEmpty ?? x?.dte ?? null,
        stock: x?.stock ?? null,
        minStock: x?.minStock ?? null,
        risk: x?.risk || "LOW",
      })),
      consumptionAnomaliesTop: shortList(
        predictive?.equipmentConsumptionAnomaliesTop,
        3
      ).map((x) => ({
        equipmentName: x?.equipmentName || x?.name || "Equipo",
        code: x?.code || "",
        ratio: x?.ratio ?? null,
        last14AvgDaily: x?.last14AvgDaily ?? x?.lastNAvgDaily ?? null,
        baselineAvgDaily: x?.baselineAvgDaily ?? null,
        criticality: x?.criticality || null,
        risk: x?.risk || "LOW",
      })),
    },
  };

  return `
Eres un analista experto en lubricación industrial y mantenimiento.
Debes responder SOLO con JSON válido, sin markdown, sin comentarios y sin texto extra.
Responde en español claro y ejecutivo.

Objetivo:
- resumir el estado operativo real
- leer alertas operativas y alertas predictivas
- señalar riesgos concretos
- recomendar acciones útiles y accionables

Debe cumplir:
- no inventar números
- no contradecir el payload
- no usar texto genérico
- executiveSummary: máximo 3 frases
- highlights: 3 a 6 bullets cortos
- risks: 2 a 5 objetos con level, message y action
- recommendations: 3 a 6 acciones concretas

Si faltan datos, dilo claramente.

Schema obligatorio:
{
  "title": "string",
  "period": "${month}",
  "plantId": "${plantId}",
  "kpis": {
    "completed": 0,
    "pending": 0,
    "overdue": 0,
    "conditionOpen": 0,
    "conditionInProgress": 0,
    "lowStockCount": 0,
    "unassignedPending": 0
  },
  "highlights": ["string"],
  "risks": [
    {
      "level": "LOW | MEDIUM | HIGH | CRITICAL",
      "message": "string",
      "action": "string"
    }
  ],
  "recommendations": ["string"],
  "executiveSummary": "string",
  "schemaVersion": ${Number(AI_SCHEMA_VERSION || 1)}
}

Datos fuente:
${JSON.stringify(payload, null, 2)}
`.trim();
}

function fallbackSummary({ month, plantId, dashboard }) {
  const activities = dashboard?.activities || {};
  const conditionReports = activities?.conditionReports || {};
  const alerts = dashboard?.alerts || {};
  const predictive = dashboard?.predictive || {};
  const overdue = Number(activities.overdue || 0);
  const pending = Number(activities.pending || 0);
  const completed = Number(activities.completed || 0);
  const dteCount = Number(
    predictive?.lubricantDaysToEmptyCount ?? alerts?.daysToEmptyCount ?? 0
  );
  const anomalyCount = Number(
    predictive?.equipmentConsumptionAnomaliesCount ??
      alerts?.consumptionAnomaliesCount ??
      0
  );
  const predictiveSignalsCount = Number(
    predictive?.consumptionSignalsCount ?? alerts?.predictiveSignalsCount ?? 0
  );

  const risks = [
    {
      level: overdue > 0 ? "HIGH" : "LOW",
      message: `Hay ${overdue} actividades vencidas.`,
      action: "Reasignar y priorizar vencidas en el plan de la semana.",
    },
  ];

  if (dteCount > 0) {
    risks.push({
      level: dteCount >= 3 ? "HIGH" : "MEDIUM",
      message: `Se detectaron ${dteCount} lubricantes con riesgo de agotarse.`,
      action: "Revisar cobertura, stock mínimo y compras prioritarias.",
    });
  }

  if (anomalyCount > 0) {
    risks.push({
      level: anomalyCount >= 3 ? "HIGH" : "MEDIUM",
      message: `Hay ${anomalyCount} equipos con consumo fuera de patrón.`,
      action:
        "Validar condición, ruta y consumo reciente antes de que crezca el riesgo.",
    });
  }

  const highlights = [
    `Actividades completadas: ${completed}`,
    `Pendientes: ${pending}`,
    `Vencidas: ${overdue}`,
  ];

  if (predictiveSignalsCount > 0) {
    highlights.push(`Señales predictivas activas: ${predictiveSignalsCount}`);
  }

  const recommendations = [
    "Revisar vencidas y programar recuperación.",
    "Validar reportes de condición OPEN/IN_PROGRESS y asignar responsable.",
    "Asegurar disponibilidad de lubricantes críticos si aplica.",
  ];

  if (predictiveSignalsCount > 0) {
    recommendations.push(
      "Atender primero alertas predictivas de consumo e inventario con mayor severidad."
    );
  }

  return {
    schemaVersion: Number(AI_SCHEMA_VERSION || 1),
    title: "Resumen ejecutivo (fallback)",
    period: month,
    plantId,
    kpis: {
      completed,
      pending,
      overdue,
      conditionOpen: Number(alerts.conditionOpenCount || conditionReports.OPEN || 0),
      conditionInProgress: Number(
        alerts.conditionInProgressCount || conditionReports.IN_PROGRESS || 0
      ),
      lowStockCount:
        alerts.lowStockCount != null ? Number(alerts.lowStockCount || 0) : undefined,
      unassignedPending:
        alerts.unassignedPending != null
          ? Number(alerts.unassignedPending || 0)
          : undefined,
    },
    highlights: highlights.slice(0, 6),
    risks: risks.slice(0, 5),
    recommendations: recommendations.slice(0, 6),
    executiveSummary:
      predictiveSignalsCount > 0
        ? "Resumen no disponible por IA en este momento. Se muestran KPIs, riesgos operativos y señales predictivas detectadas con base en datos del sistema."
        : "Resumen no disponible por IA en este momento. Se muestran KPIs y acciones sugeridas basadas en datos del sistema.",
  };
}

async function callProvider(prompt) {
  return generateExecutiveSummary({ prompt });
}

function extractJson(text) {
  const s = String(text || "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

async function generateOnce({ month, plantId, role, lang, dashboard }) {
  const prompt = buildPrompt({ month, plantId, role, lang, dashboard });

  if (AI_MODE === "mock") {
    return JSON.stringify(fallbackSummary({ month, plantId, dashboard }));
  }

  return callProvider(prompt);
}

async function generateWithRepair({ month, plantId, role, lang, dashboard }) {
  const schema = AISummarySchemaVersioned(Number(AI_SCHEMA_VERSION || 1));

  let raw1 = "";
  try {
    raw1 = await generateOnce({ month, plantId, role, lang, dashboard });
  } catch (error) {
    console.error("AI provider first pass failed:", error);
    return schema.parse(fallbackSummary({ month, plantId, dashboard }));
  }

  const json1 = extractJson(raw1);
  if (json1) {
    try {
      return schema.parse(JSON.parse(json1));
    } catch (error) {
      console.error("AI first pass parse failed:", error);
    }
  }

  const repairPrompt = `
Corrige tu respuesta anterior.
Devuelve SOLO JSON válido, sin markdown, sin comentarios y sin texto adicional.
Usa exactamente este schema funcional:
{
  "title": "string",
  "period": "${month}",
  "plantId": "${plantId}",
  "kpis": {
    "completed": 0,
    "pending": 0,
    "overdue": 0,
    "conditionOpen": 0,
    "conditionInProgress": 0,
    "lowStockCount": 0,
    "unassignedPending": 0
  },
  "highlights": ["string"],
  "risks": [
    {
      "level": "LOW | MEDIUM | HIGH | CRITICAL",
      "message": "string",
      "action": "string"
    }
  ],
  "recommendations": ["string"],
  "executiveSummary": "string",
  "schemaVersion": ${Number(AI_SCHEMA_VERSION || 1)}
}
`.trim();

  let raw2 = raw1;
  if (AI_MODE !== "mock") {
    try {
      raw2 = await callProvider(repairPrompt);
    } catch (error) {
      console.error("AI provider repair pass failed:", error);
      return schema.parse(fallbackSummary({ month, plantId, dashboard }));
    }
  }

  const json2 = extractJson(raw2);
  if (json2) {
    try {
      return schema.parse(JSON.parse(json2));
    } catch (error) {
      console.error("AI repair pass parse failed:", error);
    }
  }

  return schema.parse(fallbackSummary({ month, plantId, dashboard }));
}

export async function getAISummary({
  month,
  plantId,
  role,
  userId,
  lang,
  schemaVersion,
  dashboard,
}) {
  const scope = cacheScopeForRole(role);

  const key = makeCacheKey([
    month,
    plantId,
    role,
    scope === "USER" ? String(userId ?? "no-user") : "shared",
    String(schemaVersion ?? AI_SCHEMA_VERSION ?? 1),
    lang,
  ]);

  const cached = cacheGet(key);
  if (cached) {
    return {
      cached: true,
      model: AI_MODE === "provider" ? OPENAI_MODEL : AI_MODE,
      generatedAt: cached.generatedAt,
      summary: cached.summary,
    };
  }

  const summary = await generateWithRepair({ month, plantId, role, lang, dashboard });
  const payload = {
    generatedAt: new Date().toISOString(),
    summary,
  };

  cacheSet(key, payload, ttlMs());

  return {
    cached: false,
    model: AI_MODE === "provider" ? OPENAI_MODEL : AI_MODE,
    generatedAt: payload.generatedAt,
    summary,
  };
}
