// src/services/plantSettings.js
// Ajustes por planta. Cada planta puede tener su fila en AppSettings (plantId); si no la tiene,
// usa la configuración general (fila sin planta, id 1) y, si tampoco existe, los valores por defecto.

export const SETTINGS_DEFAULTS = {
  executionEvidenceRequired: false,
  preventNegativeStock: true,
  lowStockWarningEnabled: true,
  technicianOverloadEnabled: true,
  predictiveAlertsEnabled: true,
  aiSummaryEnabled: true,
  criticalActivityEmailEnabled: true,
  conditionReportEmailEnabled: true,
  overdueSummaryEmailEnabled: true,
  monthlyReportEmailEnabled: true,
  monthlyTechSummaryEnabled: false,
  requiresPhotoOLP: false,
  overloadWindowDays: 7,
  overloadOverdueLookbackDays: 30,
  overloadCapacityPerDay: 6,
  overloadWarnRatio: 1.1,
  overloadCriticalRatio: 1.4,
};

export const SETTING_KEYS = Object.keys(SETTINGS_DEFAULTS);

function pickValues(row) {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = row && row[k] !== undefined && row[k] !== null ? row[k] : SETTINGS_DEFAULTS[k];
  return out;
}

/** Configuración general (sin planta). */
async function globalRow(db) {
  return db.appSettings.findFirst({ where: { plantId: null }, orderBy: { id: "asc" } });
}

/**
 * Ajustes efectivos de una planta: { ...valores, scope: "PLANT" | "DEFAULT" }.
 * Nunca lanza por falta de fila.
 */
export async function getPlantSettings(db, plantId) {
  const pid = Number(plantId);
  if (Number.isInteger(pid) && pid > 0) {
    const own = await db.appSettings.findUnique({ where: { plantId: pid } });
    if (own) return { ...pickValues(own), scope: "PLANT", updatedAt: own.updatedAt ?? null };
  }
  const g = await globalRow(db);
  return { ...pickValues(g), scope: "DEFAULT", updatedAt: g?.updatedAt ?? null };
}

/**
 * Guarda cambios en la fila de la planta. Si aún no tiene, la crea copiando la configuración
 * general, así las demás plantas no se ven afectadas.
 */
export async function savePlantSettings(db, plantId, data) {
  const pid = Number(plantId);
  const existing = await db.appSettings.findUnique({ where: { plantId: pid } });
  if (existing) return db.appSettings.update({ where: { plantId: pid }, data });
  const base = pickValues(await globalRow(db));
  return db.appSettings.create({ data: { ...base, ...data, plantId: pid } });
}
