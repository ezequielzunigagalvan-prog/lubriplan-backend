// Ajustes por planta: lectura con respaldo general y guardado sin afectar a otras plantas.
import { describe, it, expect } from "vitest";
import { getPlantSettings, savePlantSettings, SETTINGS_DEFAULTS } from "../../src/services/plantSettings.js";
import { parseSettingsPatch } from "../../src/routes/settings.routes.js";

function makeDb(rows) {
  let nextId = Math.max(0, ...rows.map((r) => r.id)) + 1;
  return {
    rows,
    appSettings: {
      findUnique: async ({ where }) => rows.find((r) => r.plantId === where.plantId) || null,
      findFirst: async () => rows.filter((r) => r.plantId == null).sort((a, b) => a.id - b.id)[0] || null,
      update: async ({ where, data }) => Object.assign(rows.find((r) => r.plantId === where.plantId), data),
      create: async ({ data }) => {
        const row = { id: nextId++, ...data };
        rows.push(row);
        return row;
      },
    },
  };
}

describe("Ajustes por planta", () => {
  it("sin fila propia usa la configuración general", async () => {
    const db = makeDb([{ id: 1, plantId: null, preventNegativeStock: false }]);
    const s = await getPlantSettings(db, 3);
    expect(s.scope).toBe("DEFAULT");
    expect(s.preventNegativeStock).toBe(false);
    expect(s.aiSummaryEnabled).toBe(SETTINGS_DEFAULTS.aiSummaryEnabled);
  });

  it("sin ninguna fila devuelve los valores por defecto", async () => {
    const s = await getPlantSettings(makeDb([]), 3);
    expect(s).toMatchObject({ ...SETTINGS_DEFAULTS, scope: "DEFAULT" });
  });

  it("guardar en una planta crea su fila copiando la general y no toca a las demás", async () => {
    const db = makeDb([{ id: 1, plantId: null, preventNegativeStock: false, aiSummaryEnabled: false }]);
    await savePlantSettings(db, 3, { lowStockWarningEnabled: false });
    const p3 = await getPlantSettings(db, 3);
    const p4 = await getPlantSettings(db, 4);
    expect(p3).toMatchObject({ scope: "PLANT", lowStockWarningEnabled: false, preventNegativeStock: false, aiSummaryEnabled: false });
    expect(p4).toMatchObject({ scope: "DEFAULT", lowStockWarningEnabled: true });
    expect(db.rows.find((r) => r.plantId == null).lowStockWarningEnabled).toBeUndefined();
  });

  it("valida tipos y rangos", () => {
    expect(parseSettingsPatch({ preventNegativeStock: "si" }).error).toBeTruthy();
    expect(parseSettingsPatch({ overloadWindowDays: 0 }).error).toBeTruthy();
    expect(parseSettingsPatch({ overloadWarnRatio: 1.234, requiresPhotoOLP: true }).data).toEqual({ overloadWarnRatio: 1.23, requiresPhotoOLP: true });
  });
});
