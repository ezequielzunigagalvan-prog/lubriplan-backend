// src/ia/openaiClient.js
// Cliente único de OpenAI para toda la IA (resumen, LubriBot y chat del sitio).
// Antes cada módulo creaba el suyo, sin tiempo límite: una llamada colgada dejaba la petición esperando.

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 30_000);

let clientPromise = null;

export async function getOpenAI() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) throw Object.assign(new Error("OPENAI_API_KEY no configurada"), { code: "AI_NOT_CONFIGURED" });
    const mod = await import("openai");
    const OpenAI = mod?.default || mod?.OpenAI || mod;
    return new OpenAI({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  })().catch((e) => {
    clientPromise = null; // permite reintentar si se configura después
    throw e;
  });
  return clientPromise;
}

/** Traduce errores del proveedor a algo que se le puede decir al usuario. */
export function describeAiError(err) {
  const status = Number(err?.status || err?.response?.status || 0);
  const code = String(err?.code || err?.error?.code || "");
  if (code === "AI_NOT_CONFIGURED") return { status: 503, kind: "not_configured", message: "La IA no está configurada en el servidor." };
  if (code === "insufficient_quota") return { status: 503, kind: "quota", message: "El servicio de IA no tiene saldo disponible. Avisa al administrador." };
  if (status === 429) return { status: 503, kind: "provider_busy", message: "El servicio de IA está saturado. Intenta en un minuto." };
  if (status === 401 || status === 403) return { status: 503, kind: "auth", message: "La clave del servicio de IA no es válida. Avisa al administrador." };
  if (/timeout|timed out|ETIMEDOUT|aborted/i.test(String(err?.message || "")) || err?.name === "APIConnectionTimeoutError") {
    return { status: 504, kind: "timeout", message: "La IA tardó demasiado en responder. Intenta de nuevo." };
  }
  if (status) return { status: 502, kind: "provider_error", message: "El servicio de IA no respondió correctamente. Intenta de nuevo." };
  return { status: 500, kind: "internal", message: "Error en el asistente. Intenta de nuevo." };
}

/**
 * Deja el historial en un tamaño razonable: solo role/content, últimos N mensajes,
 * máximo de caracteres total, y empieza con un mensaje del usuario.
 */
export function trimHistory(messages, { maxMessages = 16, maxChars = 12_000 } = {}) {
  const clean = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  let out = clean.slice(-maxMessages);
  while (out.length > 1 && out.reduce((s, m) => s + m.content.length, 0) > maxChars) out = out.slice(1);
  while (out.length && out[0].role !== "user") out = out.slice(1);
  return out;
}
