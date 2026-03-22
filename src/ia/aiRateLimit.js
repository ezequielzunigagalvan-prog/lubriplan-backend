// src/ia/aiRateLimit.js
function windowKey(prefix, id, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  return `${prefix}:${id}:${bucket}`;
}

const hits = new Map(); // key -> count

function hit(key) {
  const c = (hits.get(key) || 0) + 1;
  hits.set(key, c);
  return c;
}

function cleanupSometimes() {
  // limpieza simple (no perfecta) para que no crezca infinito
  if (hits.size < 5000) return;
  const now = Date.now();
  for (const k of hits.keys()) {
    // si el bucket es muy viejo, lo dejamos morir (heurística)
    // (no parseamos timestamps; solo recortamos)
    if (Math.random() < 0.05) hits.delete(k);
  }
}

export function dualRateLimit({
  userId,
  plantId,
  userLimitPerHour,
  plantLimitPerHour,
}) {
  const HOUR = 60 * 60 * 1000;

  const uid = userId ? String(userId) : "anon";
  const pid = plantId ? String(plantId) : "no-plant";

  const uKey = windowKey("ai:u", uid, HOUR);
  const pKey = windowKey("ai:p", pid, HOUR);

  const uCount = hit(uKey);
  const pCount = hit(pKey);

  cleanupSometimes();

  return {
    ok: uCount <= userLimitPerHour && pCount <= plantLimitPerHour,
    uCount,
    pCount,
    userLimitPerHour,
    plantLimitPerHour,
  };
}