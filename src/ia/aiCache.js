// src/ia/aiCache.js
import crypto from "crypto";

const mem = new Map(); // key -> { value, exp }

export function makeCacheKey(parts = []) {
  const raw = parts.filter(Boolean).join("|");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return `ai:summary:${hash}`;
}

export function cacheGet(key) {
  const hit = mem.get(key);
  if (!hit) return null;
  if (hit.exp && Date.now() > hit.exp) {
    mem.delete(key);
    return null;
  }
  return hit.value;
}

export function cacheSet(key, value, ttlMs) {
  mem.set(key, { value, exp: ttlMs ? Date.now() + ttlMs : null });
  return true;
}

export function cacheInvalidatePrefix(prefix) {
  for (const k of mem.keys()) {
    if (k.startsWith(prefix)) mem.delete(k);
  }
}
