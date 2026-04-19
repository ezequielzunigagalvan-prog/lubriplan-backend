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
Eres un analista senior de lubricaciÃ³n industrial y mantenimiento para una planta productiva.

Tu trabajo NO es repetir mÃ©tricas visibles.
Tu trabajo es INTERPRETAR, PRIORIZAR y RECOMENDAR decisiones operativas concretas.

Debes responder SOLO con JSON vÃ¡lido.
No uses markdown.
No agregues texto fuera del JSON.
No expliques el schema.
No incluyas comentarios.

Idioma:
- Responde en espaÃ±ol ejecutivo, claro, tÃ©cnico y directo.
- Tono: gerente de mantenimiento / jefe de planta.
- Nada de frases genÃ©ricas o vacÃ­as.

Reglas obligatorias:
- No inventes datos.
- No contradigas el payload.
- No repitas literalmente KPIs si no aportan interpretaciÃ³n.
- Cada highlight debe ser un hallazgo accionable, no una lectura plana de nÃºmeros.
- Cada risk debe seÃ±alar impacto operativo real.
- Cada action debe ser especÃ­fica y ejecutable.
- Evita frases vagas como "dar seguimiento", "monitorear", "revisar constantemente" o "seguir observando" sin contexto.
- Si el riesgo es bajo, dilo sin exagerar.
- Si faltan datos, dilo claramente.
- Prioriza lo que afecta ejecuciÃ³n, disponibilidad y cumplimiento del plan.
- Usa el bloque "trends" para detectar deterioro o mejora vs periodo anterior.
- Usa el bloque "priorities" para seÃ±alar concentraciÃ³n de riesgo.
- Si hay alertas predictivas, intÃ©gralas al diagnÃ³stico; no las menciones como secciÃ³n aislada sin interpretaciÃ³n.
- Si existen vencidas, sin asignar o reportes abiertos crÃ­ticos, deben influir en riesgos o recomendaciones.
- Si mencionas un equipo especÃ­fico, incluye tambiÃ©n su cÃ³digo entre parÃ©ntesis cuando exista en los datos. Ejemplo: "MEZCLADOR (MEZ-14)".
- No menciones equipos solo por nombre si el cÃ³digo estÃ¡ disponible.

QuÃ© debes priorizar al analizar:
1. Actividades vencidas y pendientes crÃ­ticas.
2. Reportes de condiciÃ³n abiertos o en progreso.
3. Consumos anÃ³malos o seÃ±ales predictivas.
4. Carga operativa mal distribuida o actividades sin asignar.
5. Cambios contra el periodo anterior.

Formato esperado:
- title: "Lectura ejecutiva operativa"
- executiveSummary: mÃ¡ximo 2 frases
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

  const anomalyCount = toNum(
    predictive?.equipmentConsumptionAnomaliesCount ??
      alerts?.consumptionAnomaliesCount
  );
  const predictiveSignalsCount = toNum(
    predictive?.consumptionSignalsCount ?? alerts?.predictiveSignalsCount
  );

  const overdueDelta = toNum(trends?.overdueDelta);
  const conditionOpenDelta = toNum(trends?.conditionOpenDelta);
  const unassignedPending = toNum(alerts?.unassignedPending);

  const topOverdue = shortList(priorities?.overdueTop, 1)[0];
  const topCondition = shortList(priorities?.conditionRiskTop, 1)[0];
  const highlights = [];

  if (overdue > 0) {
    highlights.push(
      overdueDelta > 0
        ? `Las actividades vencidas siguen siendo el principal foco y ademÃ¡s crecieron vs el periodo anterior.`
        : `Las actividades vencidas se mantienen como la principal fricciÃ³n operativa del periodo.`
    );
  }

  if (topCondition) {
    highlights.push(
      `El mayor riesgo tÃ©cnico estÃ¡ concentrado en ${topCondition.equipmentName}${topCondition.equipmentCode ? ` (${topCondition.equipmentCode})` : ""}, con reporte ${String(topCondition.condition || "").toUpperCase()} ${topCondition.status === "OPEN" ? "aÃºn abierto" : "en atenciÃ³n"}.`
    );
  }

  while (highlights.length < 3) {
    if (unassignedPending > 0) {
      highlights.push(
        `Persisten actividades sin asignaciÃ³n, lo que puede convertir pendiente en vencido si no se redistribuye carga.`
      );
    } else if (anomalyCount > 0 || predictiveSignalsCount > 0) {
      highlights.push(
        `Las seÃ±ales predictivas sugieren revisar consumo y condiciÃ³n operativa antes de que el riesgo se convierta en evento operativo.`
      );
    } else {
      highlights.push(
        `La operaciÃ³n se mantiene estable, pero conviene sostener disciplina en cierre de pendientes y reportes abiertos.`
      );
    }
  }

  const risks = [];

  if (overdue > 0) {
    risks.push({
      level: overdue >= 5 ? "HIGH" : "MEDIUM",
      message: topOverdue
        ? `Hay actividades vencidas y la mÃ¡s sensible corresponde a ${topOverdue.equipmentName}${topOverdue.equipmentCode ? ` (${topOverdue.equipmentCode})` : ""}, con ${toNum(topOverdue.overdueDays)} dÃ­as de atraso.`
        : `Hay ${overdue} actividades vencidas que ya comprometen cumplimiento operativo.`,
      action: "Reprogramar primero las vencidas crÃ­ticas, asignar responsable y cerrar la recuperaciÃ³n en la semana.",
    });
  }

  if (topCondition) {
    risks.push({
      level:
        String(topCondition.condition || "").toUpperCase() === "CRITICO"
          ? "CRITICAL"
          : "HIGH",
      message: `Existe riesgo tÃ©cnico en ${topCondition.equipmentName}${topCondition.equipmentCode ? ` (${topCondition.equipmentCode})` : ""} por condiciÃ³n ${String(topCondition.condition || "").toUpperCase()} en estado ${topCondition.status}.`,
      action: "Atender primero ese equipo, validar condiciÃ³n real y definir acciÃ³n correctiva con fecha compromiso.",
    });
  }

  if (anomalyCount > 0 || predictiveSignalsCount > 0) {
    risks.push({
      level:
        anomalyCount >= 3 || predictiveSignalsCount >= 3
          ? "HIGH"
          : "MEDIUM",
      message:
        `Existen seÃ±ales predictivas que justifican revisiÃ³n preventiva antes de que se materialice el riesgo.`,
      action: "Validar los equipos con mayor desviaciÃ³n de consumo y confirmar si la frecuencia de ejecuciÃ³n sigue alineada con la operaciÃ³n.",
    });
  }

  while (risks.length < 2) {
    risks.push({
      level: "LOW",
      message: "No se detecta un riesgo crÃ­tico adicional con la informaciÃ³n disponible.",
      action: "Mantener control de ejecuciÃ³n y cierre oportuno del backlog actual.",
    });
  }

  const recommendations = [
    overdue > 0
      ? "Cerrar primero el bloque de actividades vencidas con mayor criticidad, atraso y falta de asignaciÃ³n."
      : "Sostener el cumplimiento del plan semanal evitando que pendientes migren a vencidas.",

    topCondition
      ? `Resolver el frente tÃ©cnico de ${topCondition.equipmentName}${topCondition.equipmentCode ? ` (${topCondition.equipmentCode})` : ""} antes de ampliar carga en otros equipos.`
      : "Cerrar reportes OPEN e IN_PROGRESS con responsable, fecha compromiso y criterio de cierre.",

    anomalyCount > 0 || predictiveSignalsCount > 0
      ? "Priorizar seÃ±ales predictivas y consumos fuera de patrÃ³n en los equipos con mayor severidad antes de que afecten disponibilidad."
      : "Revisar balance de carga y asignaciÃ³n para sostener la ejecuciÃ³n sin generar nuevo atraso.",
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
        ? "Se detectan riesgos operativos que requieren priorizaciÃ³n inmediata, especialmente en vencidas, reportes abiertos y seÃ±ales predictivas de consumo. La ejecuciÃ³n debe enfocarse en los frentes con mayor impacto operativo."
        : "La operaciÃ³n presenta focos que requieren priorizaciÃ³n tÃ¡ctica, principalmente en vencidas, reportes abiertos y balance de ejecuciÃ³n. Conviene atacar primero lo que mÃ¡s compromete cumplimiento y continuidad.",
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

function normalizeProviderOutput(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
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
Tu respuesta anterior no cumpliÃ³ el formato requerido.

CorrÃ­gela y devuelve SOLO JSON vÃ¡lido.
No uses markdown.
No agregues comentarios.
No agregues explicaciÃ³n.
No agregues texto antes o despuÃ©s del JSON.

Debes cumplir exactamente estas reglas:
- executiveSummary: mÃ¡ximo 2 frases
- highlights: exactamente 3 strings
- risks: 2 a 3 objetos
- recommendations: exactamente 3 strings
- no inventar datos
- no repetir literalmente KPIs si no aportan interpretaciÃ³n
- redactar en espaÃ±ol ejecutivo, tÃ©cnico y directo
- priorizar vencidas, reportes abiertos, anomalias de consumo y carga no asignada
- usar los datos entregados, no frases genÃ©ricas
- si mencionas un equipo especÃ­fico, incluye su cÃ³digo entre parÃ©ntesis cuando exista en los datos

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
      model: AI_MODE === "provider" ? OPENAI_MODEL : AI_MODE,
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
    model: AI_MODE === "provider" ? OPENAI_MODEL : AI_MODE,
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
    model: AI_MODE === "provider" ? OPENAI_MODEL : AI_MODE,
    generatedAt: payload.generatedAt,
    summary,
  };
}
