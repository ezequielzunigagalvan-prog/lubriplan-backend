// src/ia/aiCache.js
// Caché en memoria del resumen IA. Llaves por planta (ai:summary:<planta>:<hash>) para poder
// invalidar solo una planta; tamaño máximo para que no crezca sin límite.
import crypto from "crypto";

const MAX_ENTRIES = Number(process.env.AI_CACHE_MAX_ENTRIES || 500);
const mem = new Map(); // key -> { value, exp }

export function makeCacheKey(parts = [], plantId = "all") {
  const raw = parts.filter((p) => p !== undefined && p !== null && p !== "").join("|");
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40);
  return `ai:summary:${plantId}:${hash}`;
}

/** Huella corta de los datos: si cambian los números, cambia la llave y se genera otro resumen. */
export function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}

export function cacheGet(key) {
  const hit = mem.get(key);
  if (!hit) return null;
  if (hit.exp && Date.now() > hit.exp) {
    mem.delete(key);
    return null;
  }
  // refresca su posición (lo más usado queda al final)
  mem.delete(key);
  mem.set(key, hit);
  return hit.value;
}

export function cacheSet(key, value, ttlMs) {
  mem.delete(key);
  mem.set(key, { value, exp: ttlMs ? Date.now() + ttlMs : null });
  while (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value);
  return true;
}

export function cacheInvalidatePrefix(prefix) {
  let n = 0;
  for (const k of [...mem.keys()]) {
    if (k.startsWith(prefix)) {
      mem.delete(k);
      n++;
    }
  }
  return n;
}
