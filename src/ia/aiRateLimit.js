// src/ia/aiRateLimit.js
// Límite por hora (usuario y planta) para llamadas reales al proveedor de IA.
// Antes la limpieza borraba llaves al azar (podía reiniciar el contador de la hora en curso).

const HOUR = 60 * 60 * 1000;
const hits = new Map(); // key -> { count, bucket }

function cleanup(bucket) {
  if (hits.size < 2000) return;
  for (const [k, v] of hits) if (v.bucket < bucket) hits.delete(k);
}

function peek(key, bucket) {
  const h = hits.get(key);
  return h && h.bucket === bucket ? h.count : 0;
}

/**
 * Verifica y (si procede) cuenta una llamada. Si se excede, no cuenta.
 * Devuelve { ok, uCount, pCount, retryAfterSec, ... }.
 */
export function dualRateLimit({ userId, plantId, userLimitPerHour, plantLimitPerHour, namespace = "ai" }) {
  const bucket = Math.floor(Date.now() / HOUR);
  const uKey = `${namespace}:u:${userId ?? "anon"}`;
  const pKey = `${namespace}:p:${plantId ?? "no-plant"}`;
  cleanup(bucket);

  const u = peek(uKey, bucket);
  const p = peek(pKey, bucket);
  const retryAfterSec = Math.ceil(((bucket + 1) * HOUR - Date.now()) / 1000);
  if (u >= userLimitPerHour || p >= plantLimitPerHour) {
    return { ok: false, uCount: u, pCount: p, userLimitPerHour, plantLimitPerHour, retryAfterSec };
  }
  hits.set(uKey, { count: u + 1, bucket });
  hits.set(pKey, { count: p + 1, bucket });
  return { ok: true, uCount: u + 1, pCount: p + 1, userLimitPerHour, plantLimitPerHour, retryAfterSec };
}
