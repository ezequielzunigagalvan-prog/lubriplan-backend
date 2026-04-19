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

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRiskLevel(level) {
  const s = String(level || "").toUpperCase().trim();
  if (["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(s)) return s;
  return "MEDIUM";
}

function getModelLabel() {
  return AI_MODE === "provider" ? OPENAI_MODEL : AI_MODE;
}

function buildPrompt({ month, plantId, role, lang, dashboard }) {
  const activities = dashboard?.activities || {};
  const alerts = dashboard?.alerts || {};
  const counts = dashboard?.counts || {};
  const predictive = dashboard?.predictive || {};
  const trends = dashboard?.trends || {};
  const priorities = dashboard?.priorities || {};

  const payload = {
    month,
    plantId,
    role,
    lang,

    counts: {
      totalRoutes: toNum(counts.totalRoutes),
      totalEquipments: toNum(counts.totalEquipments),
    },

    activities: {
      completed: toNum(activities.completed),
      pending: toNum(activities.pending),
      overdue: toNum(activities.overdue),
      total: toNum(activities.total),
      conditionReports: {
        OPEN: toNum(activities?.conditionReports?.OPEN),
        IN_PROGRESS: toNum(activities?.conditionReports?.IN_PROGRESS),
        RESOLVED: toNum(activities?.conditionReports?.RESOLVED),
        DISMISSED: toNum(activities?.conditionReports?.DISMISSED),
      },
    },

    trends: {
      completedDelta: toNum(trends.completedDelta),
      pendingDelta: toNum(trends.pendingDelta),
      overdueDelta: toNum(trends.overdueDelta),
      conditionOpenDelta: toNum(trends.conditionOpenDelta),
      conditionInProgressDelta: toNum(trends.conditionInProgressDelta),
    },

    operationalAlerts: {
      overdueActivities: toNum(alerts.overdueActivities),
      conditionOpenCount: toNum(alerts.conditionOpenCount),
      conditionInProgressCount: toNum(alerts.conditionInProgressCount),
      unassignedPending: toNum(alerts.unassignedPending),
      lowStockCount: toNum(alerts.lowStockCount),
    },

    predictiveAlerts: {
      consumptionAnomaliesCount: toNum(alerts.consumptionAnomaliesCount),
      predictiveSignalsCount: toNum(alerts.predictiveSignalsCount),

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
        risk: normalizeRiskLevel(x?.risk || "LOW"),
      })),
    },

    priorities: {
      overdueTop: shortList(priorities?.overdueTop, 5).map((x) => ({
        executionId: x?.executionId ?? null,
        activityName: x?.activityName || "Actividad",
        equipmentName: x?.equipmentName || "Equipo",
        equipmentCode: x?.equipmentCode || "",
        criticality: x?.criticality || null,
        overdueDays: x?.overdueDays ?? 0,
        technicianName: x?.technicianName || null,
        isUnassigned: Boolean(x?.isUnassigned),
      })),

      unassignedPendingTop: shortList(priorities?.unassignedPendingTop, 5).map((x) => ({
        executionId: x?.executionId ?? null,
        activityName: x?.activityName || "Actividad",
        equipmentName: x?.equipmentName || "Equipo",
        equipmentCode: x?.equipmentCode || "",
        criticality: x?.criticality || null,
        ageDays: x?.ageDays ?? 0,
      })),

      conditionRiskTop: shortList(priorities?.conditionRiskTop, 5).map((x) => ({
        reportId: x?.reportId ?? null,
        status: x?.status || "OPEN",
        condition: x?.condition || null,
        equipmentName: x?.equipmentName || "Equipo",
        equipmentCode: x?.equipmentCode || "",
        criticality: x?.criticality || null,
        ageDays: x?.ageDays ?? 0,
      })),

      equipmentRiskTop: shortList(priorities?.equipmentRiskTop, 5).map((x) => ({
        equipmentId: x?.equipmentId ?? null,
        equipmentName: x?.equipmentName || "Equipo",
        equipmentCode: x?.equipmentCode || "",
        criticality: x?.criticality || null,
        openReports: x?.openReports ?? 0,
        criticalReports: x?.criticalReports ?? 0,
        badReports: x?.badReports ?? 0,
        score: x?.score ?? 0,
      })),

      technicianLoadTop: shortList(priorities?.technicianLoadTop, 5).map((x) => ({
        technicianId: x?.technicianId ?? null,
        technicianName: x?.technicianName || "Sin asignar",
        technicianCode: x?.technicianCode || "",
        openAssigned: x?.openAssigned ?? 0,
        overdueAssigned: x?.overdueAssigned ?? 0,
        pendingAssigned: x?.pendingAssigned ?? 0,
        score: x?.score ?? 0,
      })),

      topLubricants: shortList(priorities?.topLubricants, 5).map((x) => ({
        lubricantId: x?.lubricantId ?? null,
        name: x?.name || "Lubricante",
        code: x?.code || "",
        unit: x?.unit || "",
        consumed: x?.consumed ?? 0,
        stock: x?.stock ?? null,
        minStock: x?.minStock ?? null,
      })),
    },
  };

  return `
Eres un analista senior de lubricación industrial y mantenimiento para una planta productiva.

Tu trabajo NO es repetir métricas visibles.
Tu trabajo es INTERPRETAR, PRIORIZAR y RECOMENDAR decisiones operativas concretas.

Debes responder SOLO con JSON válido.
No uses markdown.
No agregues texto fuera del JSON.
No expliques el schema.
No incluyas comentarios.

Idioma:
- Responde en español ejecutivo, claro, técnico y directo.
- Tono: gerente de mantenimiento / jefe de planta.
- Nada de frases genéricas o vacías.

Reglas obligatorias:
- No inventes datos.
- No contradigas el payload.
- No repitas literalmente KPIs si no aportan interpretación.
- Cada highlight debe ser un hallazgo accionable, no una lectura plana de números.
- Cada risk debe señalar impacto operativo real.
- Cada action debe ser específica y ejecutable.
- Evita frases vagas como "dar seguimiento", "monitorear", "revisar constantemente" o "seguir observando" sin contexto.
- Si el riesgo es bajo, dilo sin exagerar.
- Si faltan datos, dilo claramente.
- Prioriza lo que afecta ejecución, disponibilidad y cumplimiento del plan.
- Usa el bloque "trends" para detectar deterioro o mejora vs periodo anterior.
- Usa el bloque "priorities" para señalar concentración de riesgo.
- Si hay alertas predictivas, intégralas al diagnóstico; no las menciones como sección aislada sin interpretación.
- Si existen vencidas, sin asignar o reportes abiertos críticos, deben influir en riesgos o recomendaciones.
- Si mencionas un equipo específico, incluye también su código entre paréntesis cuando exista en los datos. Ejemplo: "MEZCLADOR (MEZ-14)".
- No menciones equipos solo por nombre si el código está disponible.

Qué debes priorizar al analizar:
1. Actividades vencidas y pendientes críticas.
2. Reportes de condición abiertos o en progreso.
3. Consumos anómalos o señales predictivas.
4. Carga operativa mal distribuida o actividades sin asignar.
5. Cambios contra el periodo anterior.

Formato esperado:
- title: "Lectura ejecutiva operativa"
- executiveSummary: máximo 2 frases
- highlights: exactamente 3 hallazgos accionables
- risks: 2 o 3 riesgos concretos
- recommendations: exactamente 3 acciones concretas y priorizadas

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
    "unassignedPending": 0
  },
  "highlights": ["string", "string", "string"],
  "risks": [
    {
      "level": "LOW | MEDIUM | HIGH | CRITICAL",
      "message": "string",
      "action": "string"
    }
  ],
  "recommendations": ["string", "string", "string"],
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
  const trends = dashboard?.trends || {};
  const priorities = dashboard?.priorities || {};

  const overdue = toNum(activities.overdue);
  const pending = toNum(activities.pending);
  const completed = toNum(activities.completed);
  const lowStockCount = toNum(alerts?.lowStockCount);

  const anomalyCount = toNum(
    predictive?.equipmentConsumptionAnomaliesCount ??
      alerts?.consumptionAnomaliesCount
  );
  const predictiveSignalsCount = toNum(
    predictive?.consumptionSignalsCount ?? alerts?.predictiveSignalsCount
  );

  const overdueDelta = toNum(trends?.overdueDelta);
  const unassignedPending = toNum(alerts?.unassignedPending);

  const topOverdue = shortList(priorities?.overdueTop, 1)[0];
  const topCondition = shortList(priorities?.conditionRiskTop, 1)[0];
  const highlights = [];

  if (overdue > 0) {
    highlights.push(
      overdueDelta > 0
        ? "Las actividades vencidas siguen siendo el principal foco y además crecieron vs el periodo anterior."
        : "Las actividades vencidas se mantienen como la principal fricción operativa del periodo."
    );
  }

  if (topCondition) {
    highlights.push(
      `El mayor riesgo técnico está concentrado en ${topCondition.equipmentName}${topCondition.equipmentCode ? ` (${topCondition.equipmentCode})` : ""}, con reporte ${String(topCondition.condition || "").toUpperCase()} ${topCondition.status === "OPEN" ? "aún abierto" : "en atención"}.`
    );
  }

  while (highlights.length < 3) {
    if (unassignedPending > 0) {
      highlights.push(
        "Persisten actividades sin asignación, lo que puede convertir pendiente en vencido si no se redistribuye carga."
      );
    } else if (anomalyCount > 0 || predictiveSignalsCount > 0) {
      highlights.push(
        "Las señales predictivas sugieren revisar consumo y condición operativa antes de que el riesgo se convierta en evento operativo."
      );
    } else if (lowStockCount > 0) {
      highlights.push(
        "El inventario bajo en algunos lubricantes puede comprometer ejecución si no se repone antes del siguiente ciclo."
      );
    } else {
      highlights.push(
        "La operación se mantiene estable, pero conviene sostener disciplina en cierre de pendientes y reportes abiertos."
      );
    }
  }

  const risks = [];

  if (overdue > 0) {
    risks.push({
      level: overdue >= 5 ? "HIGH" : "MEDIUM",
      message: topOverdue
        ? `Hay actividades vencidas y la más sensible corresponde a ${topOverdue.equipmentName}${topOverdue.equipmentCode ? ` (${topOverdue.equipmentCode})` : ""}, con ${toNum(topOverdue.overdueDays)} días de atraso.`
        : `Hay ${overdue} actividades vencidas que ya comprometen cumplimiento operativo.`,
      action: "Reprogramar primero las vencidas críticas, asignar responsable y cerrar la recuperación en la semana.",
    });
  }

  if (topCondition) {
    risks.push({
      level:
        String(topCondition.condition || "").toUpperCase() === "CRITICO"
          ? "CRITICAL"
          : "HIGH",
      message: `Existe riesgo técnico en ${topCondition.equipmentName}${topCondition.equipmentCode ? ` (${topCondition.equipmentCode})` : ""} por condición ${String(topCondition.condition || "").toUpperCase()} en estado ${topCondition.status}.`,
      action: "Atender primero ese equipo, validar condición real y definir acción correctiva con fecha compromiso.",
    });
  }

  if (anomalyCount > 0 || predictiveSignalsCount > 0) {
    risks.push({
      level:
        anomalyCount >= 3 || predictiveSignalsCount >= 3
          ? "HIGH"
          : "MEDIUM",
      message:
        "Existen señales predictivas que justifican revisión preventiva antes de que se materialice el riesgo.",
      action: "Validar los equipos con mayor desviación de consumo y confirmar si la frecuencia de ejecución sigue alineada con la operación.",
    });
  }

  while (risks.length < 2) {
    risks.push({
      level: "LOW",
      message: "No se detecta un riesgo crítico adicional con la información disponible.",
      action: "Mantener control de ejecución y cierre oportuno del backlog actual.",
    });
  }

  const recommendations = [
    overdue > 0
      ? "Cerrar primero el bloque de actividades vencidas con mayor criticidad, atraso y falta de asignación."
      : "Sostener el cumplimiento del plan semanal evitando que pendientes migren a vencidas.",

    topCondition
      ? `Resolver el frente técnico de ${topCondition.equipmentName}${topCondition.equipmentCode ? ` (${topCondition.equipmentCode})` : ""} antes de ampliar carga en otros equipos.`
      : "Cerrar reportes OPEN e IN_PROGRESS con responsable, fecha compromiso y criterio de cierre.",

    anomalyCount > 0 || predictiveSignalsCount > 0
      ? "Priorizar señales predictivas y consumos fuera de patrón en los equipos con mayor severidad antes de que afecten disponibilidad."
      : "Revisar balance de carga y asignación para sostener la ejecución sin generar nuevo atraso.",
  ];

  return {
    schemaVersion: Number(AI_SCHEMA_VERSION || 1),
    title: "Lectura ejecutiva operativa",
    period: month,
    plantId,
    kpis: {
      completed,
      pending,
      overdue,
      conditionOpen: toNum(alerts.conditionOpenCount || conditionReports.OPEN),
      conditionInProgress: toNum(
        alerts.conditionInProgressCount || conditionReports.IN_PROGRESS
      ),
      unassignedPending: toNum(alerts.unassignedPending),
    },
    highlights: highlights.slice(0, 3),
    risks: risks.slice(0, 3),
    recommendations: recommendations.slice(0, 3),
    executiveSummary:
      predictiveSignalsCount > 0
        ? "Se detectan riesgos operativos que requieren priorización inmediata, especialmente en vencidas, reportes abiertos y señales predictivas de consumo. La ejecución debe enfocarse en los frentes con mayor impacto operativo."
        : "La operación presenta focos que requieren priorización táctica, principalmente en vencidas, reportes abiertos y balance de ejecución. Conviene atacar primero lo que más compromete cumplimiento y continuidad.",
  };
}

async function callProvider(prompt) {
  return generateExecutiveSummary({ prompt });
}

function extractJson(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  const cleaned = s
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  return cleaned.slice(first, last + 1);
}

function normalizeProviderOutput(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (typeof raw.text === "string") return raw.text;
    if (typeof raw.content === "string") return raw.content;
    if (typeof raw.output_text === "string") return raw.output_text;
    return raw;
  }
  return raw;
}

async function generateOnce({ month, plantId, role, lang, dashboard }) {
  const prompt = buildPrompt({ month, plantId, role, lang, dashboard });

  if (AI_MODE === "mock") {
    return fallbackSummary({ month, plantId, dashboard });
  }

  return normalizeProviderOutput(await callProvider(prompt));
}

async function generateWithRepair({ month, plantId, role, lang, dashboard }) {
  const schema = AISummarySchemaVersioned(Number(AI_SCHEMA_VERSION || 1));

  let raw1 = "";
  try {
    raw1 = await generateOnce({ month, plantId, role, lang, dashboard });
  } catch (error) {
    console.error("AI summary failed:", error);
    return schema.parse(fallbackSummary({ month, plantId, dashboard }));
  }

  if (raw1 && typeof raw1 === "object" && !Array.isArray(raw1)) {
    try {
      return schema.parse(raw1);
    } catch (error) {
      console.error("AI first pass schema failed:", error);
    }
  }

  const json1 = extractJson(raw1);
  if (json1) {
    try {
      return schema.parse(JSON.parse(json1));
    } catch (error) {
      console.error("AI first pass parse failed:", error);
      console.log("Raw AI response:", String(raw1).slice(0, 1200));
    }
  }

  const repairPrompt = `
Tu respuesta anterior no cumplió el formato requerido.

Corrígela y devuelve SOLO JSON válido.
No uses markdown.
No agregues comentarios.
No agregues explicación.
No agregues texto antes o después del JSON.

Debes cumplir exactamente estas reglas:
- executiveSummary: máximo 2 frases
- highlights: exactamente 3 strings
- risks: 2 a 3 objetos
- recommendations: exactamente 3 strings
- no inventar datos
- no repetir literalmente KPIs si no aportan interpretación
- redactar en español ejecutivo, técnico y directo
- priorizar vencidas, reportes abiertos, anomalías de consumo y carga no asignada
- usar los datos entregados, no frases genéricas
- si mencionas un equipo específico, incluye su código entre paréntesis cuando exista en los datos

Schema:
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
  "highlights": ["string", "string", "string"],
  "risks": [
    {
      "level": "LOW | MEDIUM | HIGH | CRITICAL",
      "message": "string",
      "action": "string"
    }
  ],
  "recommendations": ["string", "string", "string"],
  "executiveSummary": "string",
  "schemaVersion": ${Number(AI_SCHEMA_VERSION || 1)}
}

Respuesta anterior:
${typeof raw1 === "string" ? raw1 : JSON.stringify(raw1)}
`.trim();

  let raw2 = raw1;
  if (AI_MODE !== "mock") {
    try {
      raw2 = normalizeProviderOutput(await callProvider(repairPrompt));
    } catch (error) {
      console.error("AI repair pass failed:", error);
      return schema.parse(fallbackSummary({ month, plantId, dashboard }));
    }
  }

  if (raw2 && typeof raw2 === "object" && !Array.isArray(raw2)) {
    try {
      return schema.parse(raw2);
    } catch (error) {
      console.error("AI repair pass schema failed:", error);
    }
  }

  const json2 = extractJson(raw2);
  if (json2) {
    try {
      return schema.parse(JSON.parse(json2));
    } catch (error) {
      console.error("AI repair pass parse failed:", error);
      console.log("Raw AI response:", String(raw2).slice(0, 1200));
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
      model: getModelLabel(),
      generatedAt: cached.generatedAt,
      summary: cached.summary,
    };
  }

  console.log("AI summary request:", {
    month,
    plantId,
    role,
    userId: userId ?? null,
    lang,
    model: getModelLabel(),
  });

  const summary = await generateWithRepair({
    month,
    plantId,
    role,
    lang,
    dashboard,
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    summary,
  };

  cacheSet(key, payload, ttlMs());

  return {
    cached: false,
    model: getModelLabel(),
    generatedAt: payload.generatedAt,
    summary,
  };
}
