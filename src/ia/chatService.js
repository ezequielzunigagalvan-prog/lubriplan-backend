// src/ia/chatService.js
import { OPENAI_MODEL, AI_MODE } from "./aiConfig.js";

const CHAT_MODEL = String(process.env.AI_CHAT_MODEL || OPENAI_MODEL || "gpt-4o-mini").trim();
const CHAT_MAX_TOKENS = Number(process.env.AI_CHAT_MAX_TOKENS || 800);

let clientPromise = null;

async function getClient() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");
    const mod = await import("openai");
    const OpenAI = mod?.default || mod?.OpenAI || mod;
    return new OpenAI({ apiKey });
  })();
  return clientPromise;
}

function buildSystemPrompt(context, role) {
  const r = String(role || "").toUpperCase();
  const isAdmin = r === "ADMIN" || r === "SUPERVISOR";

  const identity = `Eres LubriBot, el asistente de inteligencia operativa de LubriPlan — plataforma SaaS especializada en gestión de lubricación industrial.

Tu misión es ayudar a los equipos de mantenimiento a tomar decisiones rápidas, concretas y bien fundamentadas sobre lubricación, actividades de mantenimiento, condición de equipos e inventario.

Reglas estrictas:
- Responde SIEMPRE en español, con tono técnico, claro y directo.
- Sé conciso. Evita relleno y frases genéricas.
- No inventes información que no esté en el contexto. Si no tienes datos, dilo.
- Cuando menciones un equipo específico, incluye su código entre paréntesis si está disponible. Ejemplo: COMPRESOR (CPR-01).
- Si el usuario pregunta algo fuera del ámbito de mantenimiento/lubricación, responde brevemente y redirige al tema.
- Prioriza en este orden: actividades vencidas → reportes de condición críticos → stock bajo → carga desbalanceada de técnicos.
- No compares esta planta con otras plantas o benchmarks externos.
- DISTINCIÓN CRÍTICA — debes entender y comunicar correctamente la diferencia entre:
  * "Reporte de condición formal": entidad creada EXPLÍCITAMENTE por un técnico o usuario en la app para reportar una anomalía (fuga, ruido, vibración, temperatura, contaminación). Aparece en la sección "Reportes de condición formales" del contexto. Solo estos cuentan como reportes de condición.
  * "Actividad con condición deficiente": cuando al COMPLETAR una actividad del programa el técnico marca la condición del equipo como MALO o CRITICO. Esto NO crea un reporte de condición formal; solo genera una alerta interna a supervisión y admin. Aparece en el contexto como "Actividades recientes con condición MALO/CRITICO". Si preguntan si hay reportes de condición y solo existen actividades con condición deficiente, responde claramente: "No hay reportes de condición formales, pero hay X actividades completadas recientemente con condición MALO/CRITICO."`;

  if (!context) {
    return identity + "\n\nContexto de planta: No disponible en este momento.";
  }

  const {
    plantName,
    activities,
    openConditionReports,
    badConditionExecCount,
    activeTechnicians,
    lowStockLubricants,
    activePurchaseOrders,
  } = context;

  let ctx = `\n\n--- CONTEXTO DE PLANTA: ${plantName} ---`;

  ctx += `\n\nActividades del programa:
- Completadas: ${activities.completed}
- Pendientes (a tiempo): ${activities.pending}
- Vencidas (atrasadas): ${activities.overdue}`;

  if (openConditionReports?.length > 0) {
    ctx += `\n\nReportes de condición formales abiertos (${openConditionReports.length}) — creados explícitamente por técnico/usuario:`;
    openConditionReports.slice(0, 6).forEach((r) => {
      ctx += `\n  • [${r.status}] ${r.equipment}${r.equipmentCode ? ` (${r.equipmentCode})` : ""}: condición ${r.condition}${r.criticality ? `, criticidad ${r.criticality}` : ""} — hace ${r.ageHours}h`;
    });
  } else {
    ctx += "\n\nReportes de condición formales: Sin reportes formales abiertos actualmente.";
  }

  const badExecs = Number(badConditionExecCount ?? 0);
  if (badExecs > 0) {
    ctx += `\n\nActividades recientes con condición MALO/CRITICO (últimos 30 días): ${badExecs}. NOTA: estas NO son reportes de condición formales; son evaluaciones registradas al completar una actividad del programa.`;
  } else {
    ctx += "\n\nActividades recientes con condición MALO/CRITICO: ninguna en los últimos 30 días.";
  }

  if (isAdmin) {
    if (activeTechnicians?.length > 0) {
      ctx += `\n\nTécnicos activos (${activeTechnicians.length}):`;
      activeTechnicians.slice(0, 6).forEach((t) => {
        ctx += `\n  • ${t.name} (${t.code}) — ${t.specialty}: ${t.pendingCount} pendientes, ${t.overdueCount} vencidas`;
      });
    } else {
      ctx += "\n\nTécnicos: Sin técnicos activos registrados.";
    }

    if (lowStockLubricants?.length > 0) {
      ctx += `\n\nLubricantes con stock bajo (${lowStockLubricants.length}):`;
      lowStockLubricants.slice(0, 6).forEach((l) => {
        ctx += `\n  • ${l.name}${l.code ? ` (${l.code})` : ""}: stock ${l.stock} ${l.unit}, mínimo ${l.minStock} ${l.unit}${l.brand ? ` — ${l.brand}` : ""}`;
      });
    } else {
      ctx += "\n\nInventario: Todos los lubricantes sobre el mínimo.";
    }

    if (activePurchaseOrders?.length > 0) {
      ctx += `\n\nÓrdenes de compra activas (${activePurchaseOrders.length}):`;
      activePurchaseOrders.forEach((po) => {
        const items = po.items
          .map((i) => `${i.lubricant} ${i.quantity} ${i.unit}`.trim())
          .join(", ");
        ctx += `\n  • OC #${po.id} [${po.status}]: ${items || "sin ítems"}`;
      });
    } else {
      ctx += "\n\nÓrdenes de compra: Sin órdenes activas.";
    }
  } else {
    ctx += "\n\n(Rol Técnico: Ves actividades y reportes de condición de tu planta. Para inventario y gestión de personal, consulta con tu supervisor.)";
  }

  ctx += "\n--- FIN CONTEXTO ---";

  return identity + ctx;
}

function mockReply(context) {
  const overdue = context?.activities?.overdue ?? 0;
  const plant = context?.plantName || "la planta";
  const reports = context?.openConditionReports?.length ?? 0;
  const badExecs = context?.badConditionExecCount ?? 0;

  if (overdue > 0) {
    return `[Demo] Hola, soy LubriBot. En ${plant} hay ${overdue} actividad(es) vencida(s) que requieren atención prioritaria. Reportes de condición formales abiertos: ${reports}. Actividades completadas con condición MALO/CRITICO (últimos 30 días): ${badExecs}. Para activar respuestas reales, configura AI_MODE=provider en el backend.`;
  }
  return `[Demo] Hola, soy LubriBot. La operación en ${plant} está al día: sin actividades vencidas. Reportes de condición formales abiertos: ${reports}. Actividades completadas con condición MALO/CRITICO (últimos 30 días): ${badExecs}. Para activar respuestas reales, configura AI_MODE=provider en el backend.`;
}

export async function generateChatReply({ messages, context, role }) {
  if (String(AI_MODE || "mock").toLowerCase() !== "provider") {
    // Respuesta demo determinista basada en el contexto real de la planta
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const question = lastUserMsg?.content || "";

    let reply = mockReply(context);

    // Respuestas demo un poco más contextuales
    const q = question.toLowerCase();
    if (q.includes("vencid") || q.includes("atraso") || q.includes("overdue")) {
      reply = `[Demo] Actividades vencidas en ${context?.plantName || "la planta"}: ${context?.activities?.overdue ?? 0}. Para análisis detallado, activa AI_MODE=provider.`;
    } else if (q.includes("stock") || q.includes("lubricante") || q.includes("inventario")) {
      const lowCount = context?.lowStockLubricants?.length ?? 0;
      reply = `[Demo] Lubricantes bajo mínimo en ${context?.plantName || "la planta"}: ${lowCount}. Para detalles, activa AI_MODE=provider.`;
    } else if (q.includes("técnico") || q.includes("tecnico") || q.includes("personal")) {
      const techCount = context?.activeTechnicians?.length ?? 0;
      reply = `[Demo] Técnicos activos: ${techCount}. Para análisis de carga, activa AI_MODE=provider.`;
    }

    return { reply, model: "mock" };
  }

  const systemPrompt = buildSystemPrompt(context, role);

  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: String(m.role || "user"),
      content: String(m.content || ""),
    })),
  ];

  const client = await getClient();

  const response = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages: chatMessages,
    max_tokens: CHAT_MAX_TOKENS,
    temperature: 0.25,
  });

  const reply =
    response.choices?.[0]?.message?.content?.trim() ||
    "Sin respuesta del asistente. Intenta de nuevo.";

  return {
    reply,
    model: response.model || CHAT_MODEL,
  };
}
