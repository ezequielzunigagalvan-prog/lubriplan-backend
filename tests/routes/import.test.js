import { describe, it, expect, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";

const db = {
  equipment: [],
  lubricant: [],
  technician: [],
  route: [],
};

vi.mock("../../src/prisma.js", () => {
  const byCodes = (list, where) => list.filter((x) => (where?.code?.in ? where.code.in.includes(x.code) : true));
  const client = {
    equipment: { findMany: vi.fn(async ({ where }) => byCodes(db.equipment, where)) },
    lubricant: { findMany: vi.fn(async () => db.lubricant) },
    technician: { findMany: vi.fn(async () => db.technician) },
    route: { findMany: vi.fn(async () => db.route) },
    plant: { findFirst: vi.fn(async () => ({ timezone: "America/Mexico_City" })) },
  };
  return { default: client };
});
vi.mock("../../src/services/audit.service.js", () => ({ logAudit: vi.fn(async () => {}) }));

const { validateWorkbook, summarize, toNumber, parseSheetYmd, cellValue, normalizeCode, buildTemplateWorkbook, TEMPLATE_COLUMNS } = await import(
  "../../src/routes/import.js"
);

const MX = "America/Mexico_City";

function book(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
  }
  return wb;
}

beforeEach(() => {
  db.equipment = [];
  db.lubricant = [];
  db.technician = [];
  db.route = [];
});

describe("utilidades", () => {
  it("números con coma decimal o separador de miles", () => {
    expect(toNumber("1,5")).toBe(1.5);
    expect(toNumber("1,234.5")).toBe(1234.5);
    expect(toNumber(" 12 ")).toBe(12);
    expect(toNumber("abc")).toBeNull();
    expect(toNumber("")).toBeNull();
  });
  it("fechas de Excel y de texto, rechaza inválidas", () => {
    expect(parseSheetYmd(new Date(Date.UTC(2026, 3, 1)))).toBe("2026-04-01");
    expect(parseSheetYmd("2026-04-01")).toBe("2026-04-01");
    expect(parseSheetYmd("01/04/2026")).toBe("2026-04-01");
    expect(parseSheetYmd("31/02/2026")).toBeNull();
    expect(parseSheetYmd("ayer")).toBeNull();
  });
  it("celdas con formato, fórmulas y errores", () => {
    expect(cellValue({ richText: [{ text: "EQ-" }, { text: "01" }] })).toBe("EQ-01");
    expect(cellValue({ formula: "A1", result: 7 })).toBe(7);
    expect(cellValue({ error: "#N/A" })).toBe("");
  });
  it("códigos sin acentos y en mayúsculas", () => {
    expect(normalizeCode(" eq 01 ")).toBe("EQ-01");
    expect(normalizeCode("bómba-1")).toBe("BOMBA-1");
  });
});

describe("validateWorkbook", () => {
  const H = TEMPLATE_COLUMNS;

  it("acepta la plantilla de ejemplo completa", async () => {
    const wb = buildTemplateWorkbook();
    const { sheets, warnings } = await validateWorkbook(wb, 1, MX);
    const s = summarize(sheets);
    expect(s.equipos).toMatchObject({ ok: 1, errors: 0 });
    expect(s.lubricantes).toMatchObject({ ok: 2, errors: 0 });
    expect(s.tecnicos).toMatchObject({ ok: 1, errors: 0 });
    expect(s.rutas).toMatchObject({ ok: 2, errors: 0 });
    expect(sheets.rutas.ok[1]).toMatchObject({ unidad: "BOMBAZOS", equivalencia_bombazo: 1.2, unidad_equivalencia_bombazo: "g", ultima: "2026-04-01", proxima: "2026-04-16" });
    expect(warnings.some((w) => w.includes("vencida"))).toBe(true);
  });

  it("criticidad con acento, estado en minúsculas y valores inválidos", async () => {
    const wb = book({
      equipos: [H.equipos, ["eq 1", "Bomba", "", "", "activo", "Crítica"], ["EQ-2", "", "", "", "Roto", "Urgente"]],
    });
    const { sheets } = await validateWorkbook(wb, 1, MX);
    expect(sheets.equipos.ok[0]).toMatchObject({ codigo: "EQ-1", estado: "ACTIVO", criticidad: "CRITICA" });
    const msgs = sheets.equipos.errors.map((e) => e.message).join(" | ");
    expect(msgs).toContain("Falta el nombre");
    expect(msgs).toContain("Estado \"Roto\"");
    expect(msgs).toContain("Criticidad \"Urgente\"");
  });

  it("el código de equipo de otra planta se omite con aviso (es único en todo el sistema)", async () => {
    db.equipment = [{ code: "EQ-1", plantId: 9 }];
    const wb = book({ equipos: [H.equipos, ["EQ-1", "Bomba"]] });
    const { sheets, warnings } = await validateWorkbook(wb, 1, MX);
    expect(sheets.equipos.ok).toHaveLength(0);
    expect(sheets.equipos.skipped[0].message).toContain("otra planta");
    expect(warnings.join(" ")).toContain("único en todo LubriPlan");
  });

  it("código de técnico eliminado es error; existente se omite", async () => {
    db.technician = [{ code: "TEC-1", deletedAt: new Date() }, { code: "TEC-2", deletedAt: null }];
    const wb = book({ tecnicos: [H.tecnicos, ["Ana", "tec-1"], ["Luis", "TEC-2"], ["Eva", "TEC-3", "", "Inactivo"]] });
    const { sheets } = await validateWorkbook(wb, 1, MX);
    expect(sheets.tecnicos.errors[0].message).toContain("técnico eliminado");
    expect(sheets.tecnicos.skipped).toHaveLength(1);
    expect(sheets.tecnicos.ok[0]).toMatchObject({ codigo: "TEC-3", estatus: "Inactivo" });
  });

  it("rutas: referencias, fecha futura, frecuencia, bombazos y duplicados", async () => {
    db.equipment = [{ id: 5, code: "EQ-1", plantId: 1 }];
    db.lubricant = [{ id: 7, code: "LUB-1", name: "Grasa EP2", type: "Grasa" }];
    db.route = [{ equipmentId: 5, lubricantId: 7, normalizedName: "engrase", method: "" }];
    const wb = book({
      rutas: [
        H.rutas,
        ["EQ-1", "Engrase", 15, "LUB-1", 3, "g", "", "", "", "", "", "2026-01-01"], // ya existe → omitida
        ["EQ-9", "Otra", 7, "LUB-1", 1, "g", "", "", "", "", "", "2026-01-01"], // equipo no existe
        ["EQ-1", "Nivel", 7.5, "LUB-1", 1, "L", "", "", "", "", "", "2099-01-01"], // frecuencia y fecha futura
        ["EQ-1", "Rodamientos", 30, "LUB-1", 2, "bombazos", "", "", "", "", "", "2026-01-01"], // falta equivalencia
        ["EQ-1", "Cadena", 7, "LUB-1", 5, "g", "", "", "", "", "", "2026-01-01"],
        ["EQ-1", "cadena", 7, "LUB-1", 5, "g", "", "", "", "", "", "2026-01-01"], // repetida en archivo
      ],
    });
    const { sheets } = await validateWorkbook(wb, 1, MX);
    expect(sheets.rutas.skipped).toHaveLength(1);
    expect(sheets.rutas.ok.map((r) => r.nombre)).toEqual(["Cadena"]);
    const msgs = sheets.rutas.errors.map((e) => `${e.row}: ${e.message}`).join(" | ");
    expect(msgs).toContain("3: El equipo EQ-9 no existe");
    expect(msgs).toContain("4: La frecuencia debe ser un número entero");
    expect(msgs).toContain("4: La última fecha (2099-01-01) está en el futuro");
    expect(msgs).toContain("5: Con BOMBAZOS indica cuánto equivale");
    expect(msgs).toContain("7: Ruta repetida en el archivo");
  });

  it("rutas que usan equipos y lubricantes del mismo archivo", async () => {
    const wb = book({
      equipos: [H.equipos, ["EQ-N", "Nuevo"]],
      lubricantes: [H.lubricantes, ["LUB-N", "Aceite 68", "aceite", "68", "litros", 10]],
      rutas: [H.rutas, ["eq-n", "Nivel", 7, "lub-n", 0.5, "L", "", "", "", "", "", "01/11/2026"]],
    });
    const { sheets } = await validateWorkbook(wb, 1, MX);
    expect(sheets.lubricantes.ok[0]).toMatchObject({ tipo: "Aceite", unidad: "L" });
    expect(sheets.rutas.ok).toHaveLength(1);
    expect(sheets.rutas.errors).toHaveLength(0);
  });

  it("columnas faltantes y archivo sin hojas reconocidas", async () => {
    const r1 = await validateWorkbook(book({ lubricantes: [["codigo", "nombre"], ["L1", "X"]] }), 1, MX);
    expect(r1.sheets.lubricantes.errors[0].message).toContain("Faltan columnas: tipo, unidad, stock");
    const r2 = await validateWorkbook(book({ Hoja1: [["a"], ["b"]] }), 1, MX);
    expect(r2.warnings[0]).toContain("no tiene ninguna hoja");
  });

  it("acepta nombres de hoja con mayúsculas o acentos", async () => {
    const r = await validateWorkbook(book({ Técnicos: [H.tecnicos, ["Ana", "T-1"]] }), 1, MX);
    expect(r.sheets.tecnicos.ok).toHaveLength(1);
  });
});
