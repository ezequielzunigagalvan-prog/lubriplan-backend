// src/ia/aiService.js
import { AISummarySchemaVersioned } from "./aiSchema.zod.js";
import { AI_MODE, AI_CACHE_TTL_MS, AI_SCHEMA_VERSION } from "./aiConfig.js";
import { cacheGet, cacheSet, makeCacheKey } from "./aiCache.js";

// ✅ Decide si cache incluye userId
function cacheScopeForRole(role) {
  const r = String(role || "").toUpperCase();
  // TECHNICIAN: personalizado
  if (r === "TECHNICIAN") return "USER";
  // ADMIN/SUPERVISOR: normalmente igual para todos por planta
  return "ROLE";
}

function ttlMs() {
  const h = Number(AI_CACHE_TTL_MS || 24);
  return Math.max(1, h) * 60 * 60 * 1000;
}

// ✅ Prompt builder (simple, robusto)
function buildPrompt({ month, plantId, role, lang, dashboard }) {
  const k = dashboard?.activities || {};
  const alerts = dashboard?.alerts || {};
  const counts = dashboard?.counts || {};

  return `
Eres un asistente de mantenimiento industrial para LubriPlan.
Devuelve SOLO JSON válido (sin markdown) que cumpla el schema indicado.
Idioma: ${lang}
Rol: ${role}
Periodo: ${month}
Planta: ${plantId}

Datos (fuente: dashboard backend):
- totalRoutes: ${counts.totalRoutes ?? 0}
- totalEquipments: ${counts.totalEquipments ?? 0}
- completed: ${k.completed ?? 0}
- pending: ${k.pending ?? 0}
- overdue: ${k.overdue ?? 0}
- conditionReports:
  - OPEN: ${k.conditionReports?.OPEN ?? 0}
  - IN_PROGRESS: ${k.conditionReports?.IN_PROGRESS ?? 0}
- alerts:
  - overdueActivities: ${alerts.overdueActivities ?? 0}
  - conditionOpenCount: ${alerts.conditionOpenCount ?? 0}
  - conditionInProgressCount: ${alerts.conditionInProgressCount ?? 0}
  - lowStockCount: ${alerts.lowStockCount ?? 0}
  - unassignedPending: ${alerts.unassignedPending ?? 0}

Instrucciones:
- Genera "executiveSummary" (2-4 líneas) con foco en riesgos y prioridades.
- "highlights": 3 a 6 bullets.
- "risks": 2 a 5 objetos con level/message/action.
- "recommendations": 3 a 6 acciones concretas.
- Los KPIs deben reflejar los números dados (no inventar).

Incluye: title, period, plantId, kpis, highlights, risks, recommendations, executiveSummary, schemaVersion.
`.trim();
}

// ✅ Fallback determinístico si IA falla
function fallbackSummary({ month, plantId, dashboard }) {
  const a = dashboard?.activities || {};
  const cr = a.conditionReports || {};
  const alerts = dashboard?.alerts || {};

  return {
    schemaVersion: Number(AI_SCHEMA_VERSION || 1),
    title: "Resumen ejecutivo (fallback)",
    period: month,
    plantId,
    kpis: {
      completed: Number(a.completed || 0),
      pending: Number(a.pending || 0),
      overdue: Number(a.overdue || 0),
      conditionOpen: Number(alerts.conditionOpenCount || cr.OPEN || 0),
      conditionInProgress: Number(alerts.conditionInProgressCount || cr.IN_PROGRESS || 0),
      lowStockCount: alerts.lowStockCount != null ? Number(alerts.lowStockCount || 0) : undefined,
      unassignedPending: alerts.unassignedPending != null ? Number(alerts.unassignedPending || 0) : undefined,
    },
    highlights: [
      `Actividades completadas: ${Number(a.completed || 0)}`,
      `Pendientes: ${Number(a.pending || 0)}`,
      `Vencidas: ${Number(a.overdue || 0)}`,
    ],
    risks: [
      {
        level: Number(a.overdue || 0) > 0 ? "HIGH" : "LOW",
        message: `Hay ${Number(a.overdue || 0)} actividades vencidas.`,
        action: "Reasignar y priorizar vencidas en el plan de la semana.",
      },
    ],
    recommendations: [
      "Revisar vencidas y programar recuperación.",
      "Validar reportes de condición OPEN/IN_PROGRESS y asignar responsable.",
      "Asegurar disponibilidad de lubricantes críticos si aplica.",
    ],
    executiveSummary:
      "Resumen no disponible por IA en este momento. Se muestran KPIs y acciones sugeridas basadas en datos del sistema.",
  };
}

// ---- Provider call (placeholder) ----
// Aquí luego conectamos OpenAI/otro proveedor.
// Por ahora te dejo el esqueleto; si ya tienes tu provider, lo conectamos al tiro.
async function callProvider(prompt) {
  // TODO: integrar proveedor real
  // Debe regresar string JSON
  throw new Error("AI provider not configured");
}

// ✅ robust JSON parse (acepta texto con basura alrededor)
function extractJson(text) {
  const s = String(text || "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const chunk = s.slice(first, last + 1);
  return chunk;
}

async function generateOnce({ month, plantId, role, lang, dashboard }) {
  const prompt = buildPrompt({ month, plantId, role, lang, dashboard });

  if (AI_MODE === "mock") {
    // Mock determinístico basado en dashboard
    return JSON.stringify(fallbackSummary({ month, plantId, dashboard }));
  }

  const out = await callProvider(prompt);
  return out;
}

async function generateWithRepair({ month, plantId, role, lang, dashboard }) {
  const schema = AISummarySchemaVersioned(Number(AI_SCHEMA_VERSION || 1));

  // 1) intento normal
  const raw1 = await generateOnce({ month, plantId, role, lang, dashboard });
  const json1 = extractJson(raw1);
  if (json1) {
    try {
      const obj = JSON.parse(json1);
      return schema.parse(obj);
    } catch {}
  }

  // 2) repair pass (1 retry)
  const repairPrompt = `
Devuelve SOLO JSON válido que cumpla este schema:
${schema.toString()}
No incluyas texto adicional.
`.trim();

  const raw2 = AI_MODE === "mock" ? raw1 : await callProvider(repairPrompt);
  const json2 = extractJson(raw2);
  if (json2) {
    try {
      const obj = JSON.parse(json2);
      return schema.parse(obj);
    } catch {}
  }

  // 3) fallback
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

  const keyParts = [
    month,
    plantId,
    role,
    scope === "USER" ? String(userId ?? "no-user") : "shared",
    String(schemaVersion ?? AI_SCHEMA_VERSION ?? 1),
    lang,
  ];

  const key = makeCacheKey(keyParts);
  const cached = cacheGet(key);
  if (cached) {
    return {
      cached: true,
      model: AI_MODE,
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
    model: AI_MODE,
    generatedAt: payload.generatedAt,
    summary,
  };
}