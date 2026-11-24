// src/routes/import.js
// Importación masiva desde Excel: equipos, lubricantes, técnicos y rutas.
//
// Correcciones respecto a la versión anterior:
//  - SEGURIDAD: al confirmar, el servidor volvía a crear lo que el navegador le mandaba sin validarlo.
//    Ahora se vuelve a subir el archivo y se valida de nuevo en el servidor antes de guardar.
//  - El código de equipo es único en todo el sistema: se valida contra todas las plantas
//    (antes pasaba la validación y fallaba al guardar con un error genérico).
//  - Los códigos de técnicos eliminados también cuentan (la base de datos no permite repetirlos).
//  - Criticidad "Crítica" aceptada; acentos y mayúsculas indistintos.
//  - Lo que ya existe se OMITE (aviso) en lugar de bloquear todo el archivo.
//  - Transacción con tiempo suficiente para archivos grandes (antes fallaba a los 5 segundos).
//  - Lectura robusta de celdas (texto con formato, fórmulas, fechas de Excel) y aviso de columnas faltantes.
//  - Fechas en la zona horaria de la planta; se rechaza una última fecha en el futuro.
//  - Registro en auditoría de cada importación.

import express from "express";
import ExcelJS from "exceljs";
import multer from "multer";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { logger } from "../config/logger.js";
import { logAudit } from "../services/audit.service.js";
import { DEFAULT_TZ, safeTimeZone, zonedStartOfDay, zonedYmd } from "../utils/tzRange.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const managers = [requireAuth, requireRole(["ADMIN", "SUPERVISOR"])];

export const SHEETS = ["equipos", "lubricantes", "tecnicos", "rutas"];
const MAX_ROWS = 2000;

export const TEMPLATE_COLUMNS = {
  equipos: ["codigo", "nombre", "area", "ubicacion", "estado", "criticidad", "descripcion", "marca", "modelo"],
  lubricantes: ["codigo", "nombre", "tipo", "viscosidad", "unidad", "stock", "minStock", "marca", "costo_unitario"],
  tecnicos: ["nombre", "codigo", "especialidad", "estatus"],
  rutas: [
    "equipo_codigo", "nombre", "frecuencia_dias", "lubricante_codigo", "cantidad", "unidad", "equivalencia_bombazo",
    "unidad_equivalencia_bombazo", "tecnico_codigo", "puntos_lubricacion", "metodo_aplicacion", "ultima_fecha_lubricacion", "instrucciones",
  ],
};
const REQUIRED_COLUMNS = {
  equipos: ["codigo", "nombre"],
  lubricantes: ["codigo", "nombre", "tipo", "unidad", "stock"],
  tecnicos: ["nombre", "codigo"],
  rutas: ["equipo_codigo", "nombre", "frecuencia_dias", "lubricante_codigo", "cantidad", "unidad", "ultima_fecha_lubricacion"],
};

/* ───────── Normalización ───────── */
export const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const fold = (v) => clean(v).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
export const normalizeHeader = (v) => fold(v).toLowerCase().replace(/[\s-]+/g, "_");
export const normalizeCode = (v) => fold(v).replace(/\s+/g, "-");
const normalizeRouteName = (v) => clean(v).toLowerCase();
const normalizeMethod = (v) => clean(v).toLowerCase();

export function toNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = clean(value).replace(/\s/g, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, ""); // 1,234.5
  else s = s.replace(",", "."); // 1,5
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const STATUS = { ACTIVO: "ACTIVO", ACTIVE: "ACTIVO", INACTIVO: "INACTIVO", INACTIVE: "INACTIVO" };
const CRITICALITY = { CRITICA: "CRITICA", CRITICO: "CRITICA", ALTA: "ALTA", MEDIA: "MEDIA", BAJA: "BAJA" };
const LUB_TYPES = { ACEITE: "Aceite", GRASA: "Grasa" };
const LUB_UNITS = { L: "L", LT: "L", LTS: "L", LITRO: "L", LITROS: "L", ML: "ml", KG: "kg", G: "g", GR: "g" };
const ROUTE_UNITS = { ...LUB_UNITS, BOMBAZO: "BOMBAZOS", BOMBAZOS: "BOMBAZOS" };

/** Valor legible de una celda de ExcelJS (texto con formato, fórmulas, hipervínculos, fechas). */
export function cellValue(v) {
  if (v == null) return "";
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return cellValue(v.result);
    if ("text" in v) return cellValue(v.text);
    if ("hyperlink" in v) return String(v.hyperlink);
    if ("error" in v) return "";
    return "";
  }
  return v;
}

/** Fecha de la hoja como YYYY-MM-DD (acepta fecha de Excel, AAAA-MM-DD y DD/MM/AAAA). */
export function parseSheetYmd(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    // ExcelJS entrega las fechas a medianoche UTC del día capturado.
    return value.toISOString().slice(0, 10);
  }
  const raw = clean(value);
  let y;
  let m;
  let d;
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(raw)) [y, m, d] = raw.slice(0, 10).split("-").map(Number);
  else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) [d, m, y] = raw.split("/").map(Number);
  if (!y || !m || !d || m > 12 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 31/02
  return dt.toISOString().slice(0, 10);
}

const addDaysYmd = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const noonInTz = (ymd, tz) => new Date(zonedStartOfDay(ymd, tz).getTime() + 12 * 3600000);

/* ───────── Lectura del libro ───────── */
function findSheet(workbook, key) {
  return workbook.worksheets.find((ws) => normalizeHeader(ws.name) === key) || null;
}

export function sheetToRows(sheet) {
  if (!sheet) return { rows: [], headers: [] };
  const headers = [];
  sheet.getRow(1).eachCell((cell, col) => {
    headers[col] = normalizeHeader(cellValue(cell.value));
  });
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = { _row: rowNumber };
    let hasValue = false;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const value = cellValue(cell.value);
      if (clean(value instanceof Date ? "x" : value) !== "") hasValue = true;
      item[key] = value;
    });
    if (hasValue) rows.push(item);
  });
  return { rows, headers: headers.filter(Boolean) };
}

const get = (row, key) => row[normalizeHeader(key)] ?? "";

/* ───────── Validación ───────── */
function bucket() {
  return { ok: [], errors: [], skipped: [] };
}

async function validateEquipos(rows, plantId) {
  const out = bucket();
  const codes = rows.map((r) => normalizeCode(get(r, "codigo"))).filter(Boolean);
  // El código de equipo es único en todo el sistema. plantId explícito evita el filtro automático por planta.
  const existing = codes.length
    ? await prisma.equipment.findMany({ where: { plantId: { gt: 0 }, code: { in: codes } }, select: { code: true, plantId: true } })
    : [];
  const byCode = new Map(existing.map((e) => [normalizeCode(e.code), e]));
  const seen = new Set();

  for (const r of rows) {
    const codigo = normalizeCode(get(r, "codigo"));
    const nombre = clean(get(r, "nombre"));
    const estadoRaw = fold(get(r, "estado"));
    const critRaw = fold(get(r, "criticidad"));
    const errs = [];
    if (!codigo) errs.push("Falta el código");
    if (!nombre) errs.push("Falta el nombre");
    if (estadoRaw && !STATUS[estadoRaw]) errs.push(`Estado "${clean(get(r, "estado"))}" no válido (usa Activo o Inactivo)`);
    if (critRaw && !CRITICALITY[critRaw]) errs.push(`Criticidad "${clean(get(r, "criticidad"))}" no válida (usa Crítica, Alta, Media o Baja)`);
    if (codigo && seen.has(codigo)) errs.push(`El código ${codigo} está repetido en el archivo`);
    if (errs.length) {
      errs.forEach((message) => out.errors.push({ row: r._row, message }));
      continue;
    }
    seen.add(codigo);
    const found = byCode.get(codigo);
    if (found) {
      out.skipped.push({
        row: r._row,
        codigo,
        message: found.plantId === plantId ? `El equipo ${codigo} ya existe: se omite` : `El código ${codigo} ya lo usa un equipo de otra planta: se omite`,
        otherPlant: found.plantId !== plantId,
      });
      continue;
    }
    out.ok.push({
      row: r._row,
      codigo,
      nombre,
      area: clean(get(r, "area")),
      ubicacion: clean(get(r, "ubicacion")),
      estado: STATUS[estadoRaw] || "ACTIVO",
      criticidad: CRITICALITY[critRaw] || "MEDIA",
      descripcion: clean(get(r, "descripcion")),
      marca: clean(get(r, "marca")),
      modelo: clean(get(r, "modelo")),
    });
  }
  return out;
}

async function validateLubricantes(rows, plantId) {
  const out = bucket();
  const existing = await prisma.lubricant.findMany({ where: { plantId, code: { not: null } }, select: { code: true } });
  const existingCodes = new Set(existing.map((x) => normalizeCode(x.code)));
  const seen = new Set();

  for (const r of rows) {
    const codigo = normalizeCode(get(r, "codigo"));
    const nombre = clean(get(r, "nombre"));
    const tipo = LUB_TYPES[fold(get(r, "tipo"))];
    const unidad = LUB_UNITS[fold(get(r, "unidad"))];
    const stock = toNumber(get(r, "stock"));
    const minStockRaw = get(r, "minstock");
    const minStock = toNumber(minStockRaw);
    const costRaw = get(r, "costo_unitario");
    const costo = toNumber(costRaw);
    const errs = [];
    if (!codigo) errs.push("Falta el código");
    if (!nombre) errs.push("Falta el nombre");
    if (!tipo) errs.push(`Tipo "${clean(get(r, "tipo"))}" no válido (usa Aceite o Grasa)`);
    if (!unidad) errs.push(`Unidad "${clean(get(r, "unidad"))}" no válida (usa L, ml, kg o g)`);
    if (stock == null || stock < 0) errs.push("El stock debe ser un número mayor o igual a cero");
    if (clean(minStockRaw) !== "" && (minStock == null || minStock < 0)) errs.push("El stock mínimo debe ser un número mayor o igual a cero");
    if (clean(costRaw) !== "" && (costo == null || costo < 0)) errs.push("El costo unitario debe ser un número mayor o igual a cero");
    if (codigo && seen.has(codigo)) errs.push(`El código ${codigo} está repetido en el archivo`);
    if (errs.length) {
      errs.forEach((message) => out.errors.push({ row: r._row, message }));
      continue;
    }
    seen.add(codigo);
    if (existingCodes.has(codigo)) {
      out.skipped.push({ row: r._row, codigo, message: `El lubricante ${codigo} ya existe: se omite (su stock no se modifica)` });
      continue;
    }
    out.ok.push({ row: r._row, codigo, nombre, tipo, unidad, stock, minStock, costo, viscosidad: clean(get(r, "viscosidad")), marca: clean(get(r, "marca")) });
  }
  return out;
}

async function validateTecnicos(rows, plantId) {
  const out = bucket();
  // Incluye técnicos eliminados: la base de datos no permite repetir su código en la planta.
  const existing = await prisma.technician.findMany({ where: { plantId }, select: { code: true, deletedAt: true } });
  const byCode = new Map(existing.map((t) => [normalizeCode(t.code), t]));
  const seen = new Set();

  for (const r of rows) {
    const nombre = clean(get(r, "nombre"));
    const codigo = normalizeCode(get(r, "codigo"));
    const estatusRaw = fold(get(r, "estatus"));
    const errs = [];
    if (!nombre) errs.push("Falta el nombre");
    if (!codigo) errs.push("Falta el código");
    if (estatusRaw && !STATUS[estatusRaw]) errs.push(`Estatus "${clean(get(r, "estatus"))}" no válido (usa Activo o Inactivo)`);
    if (codigo && seen.has(codigo)) errs.push(`El código ${codigo} está repetido en el archivo`);
    const found = codigo ? byCode.get(codigo) : null;
    if (found?.deletedAt) errs.push(`El código ${codigo} perteneció a un técnico eliminado; usa otro código`);
    if (errs.length) {
      errs.forEach((message) => out.errors.push({ row: r._row, message }));
      continue;
    }
    seen.add(codigo);
    if (found) {
      out.skipped.push({ row: r._row, codigo, message: `El técnico ${codigo} ya existe: se omite` });
      continue;
    }
    out.ok.push({
      row: r._row,
      nombre,
      codigo,
      especialidad: clean(get(r, "especialidad")) || "Lubricación",
      estatus: STATUS[estatusRaw] === "INACTIVO" ? "Inactivo" : "Activo",
    });
  }
  return out;
}

async function validateRutas(rows, plantId, staged, tz) {
  const out = bucket();
  const warnings = [];
  const today = zonedYmd(new Date(), tz);
  const [equipments, lubricants, technicians, routes] = await Promise.all([
    prisma.equipment.findMany({ where: { plantId, code: { not: null } }, select: { id: true, code: true } }),
    prisma.lubricant.findMany({ where: { plantId, code: { not: null } }, select: { id: true, code: true, name: true, type: true } }),
    prisma.technician.findMany({ where: { plantId, deletedAt: null }, select: { id: true, code: true, status: true } }),
    prisma.route.findMany({ where: { plantId }, select: { equipmentId: true, lubricantId: true, normalizedName: true, method: true } }),
  ]);
  const eqByCode = new Map(equipments.map((x) => [normalizeCode(x.code), x]));
  const lubByCode = new Map(lubricants.map((x) => [normalizeCode(x.code), x]));
  const techByCode = new Map(technicians.map((x) => [normalizeCode(x.code), x]));
  for (const x of staged.equipos) eqByCode.set(x.codigo, { id: null, code: x.codigo, staged: true });
  for (const x of staged.lubricantes) lubByCode.set(x.codigo, { id: null, code: x.codigo, name: x.nombre, type: x.tipo, staged: true });
  for (const x of staged.tecnicos) techByCode.set(x.codigo, { id: null, code: x.codigo, status: x.estatus, staged: true });
  const existingRoutes = new Set(routes.map((r) => `${r.equipmentId}|${r.lubricantId}|${r.normalizedName}|${r.method || ""}`));
  const seen = new Set();
  let overdueOnImport = 0;

  for (const r of rows) {
    const equipoCodigo = normalizeCode(get(r, "equipo_codigo"));
    const nombre = clean(get(r, "nombre"));
    const frecuencia = toNumber(get(r, "frecuencia_dias"));
    const lubCodigo = normalizeCode(get(r, "lubricante_codigo"));
    const cantidad = toNumber(get(r, "cantidad"));
    const unidad = ROUTE_UNITS[fold(get(r, "unidad"))];
    const eqBomb = toNumber(get(r, "equivalencia_bombazo"));
    const eqBombUnit = LUB_UNITS[fold(get(r, "unidad_equivalencia_bombazo"))];
    const techCodigo = normalizeCode(get(r, "tecnico_codigo"));
    const puntosRaw = get(r, "puntos_lubricacion");
    const puntos = toNumber(puntosRaw);
    const metodo = clean(get(r, "metodo_aplicacion"));
    const ultima = parseSheetYmd(get(r, "ultima_fecha_lubricacion"));
    const equipment = eqByCode.get(equipoCodigo);
    const lubricant = lubByCode.get(lubCodigo);
    const technician = techCodigo ? techByCode.get(techCodigo) : null;
    const errs = [];

    if (!equipoCodigo) errs.push("Falta el código del equipo");
    else if (!equipment) errs.push(`El equipo ${equipoCodigo} no existe en esta planta ni en el archivo`);
    if (!nombre) errs.push("Falta el nombre de la ruta");
    if (frecuencia == null || frecuencia < 1 || !Number.isInteger(frecuencia)) errs.push("La frecuencia debe ser un número entero de días (1 o más)");
    if (!lubCodigo) errs.push("Falta el código del lubricante");
    else if (!lubricant) errs.push(`El lubricante ${lubCodigo} no existe en esta planta ni en el archivo`);
    if (cantidad == null || cantidad <= 0) errs.push("La cantidad debe ser mayor a cero");
    if (!unidad) errs.push(`Unidad "${clean(get(r, "unidad"))}" no válida (usa L, ml, kg, g o BOMBAZOS)`);
    if (unidad === "BOMBAZOS") {
      if (eqBomb == null || eqBomb <= 0) errs.push("Con BOMBAZOS indica cuánto equivale un bombazo (equivalencia_bombazo)");
      if (!eqBombUnit) errs.push("Con BOMBAZOS indica la unidad del bombazo (g, kg, ml o L)");
    }
    if (techCodigo && !technician) errs.push(`El técnico ${techCodigo} no existe en esta planta ni en el archivo`);
    if (clean(puntosRaw) !== "" && (puntos == null || puntos < 1 || !Number.isInteger(puntos))) errs.push("Los puntos de lubricación deben ser un número entero (1 o más)");
    if (!ultima) errs.push("La última fecha de lubricación falta o no es válida (AAAA-MM-DD o DD/MM/AAAA)");
    else if (ultima > today) errs.push(`La última fecha (${ultima}) está en el futuro`);

    const key = `${equipoCodigo}|${lubCodigo}|${normalizeRouteName(nombre)}|${normalizeMethod(metodo)}`;
    if (!errs.length && seen.has(key)) errs.push("Ruta repetida en el archivo (mismo equipo, lubricante, nombre y método)");
    if (errs.length) {
      errs.forEach((message) => out.errors.push({ row: r._row, message }));
      continue;
    }
    seen.add(key);
    if (equipment.id && lubricant.id && existingRoutes.has(`${equipment.id}|${lubricant.id}|${normalizeRouteName(nombre)}|${normalizeMethod(metodo)}`)) {
      out.skipped.push({ row: r._row, message: `La ruta "${nombre}" ya existe en ${equipoCodigo}: se omite` });
      continue;
    }
    if (technician && String(technician.status || "").toUpperCase() === "INACTIVO") {
      warnings.push(`Fila ${r._row}: el técnico ${techCodigo} está inactivo; la ruta quedará asignada a él.`);
    }
    const proxima = addDaysYmd(ultima, frecuencia);
    if (proxima < today) overdueOnImport += 1;
    out.ok.push({
      row: r._row,
      equipo_codigo: equipoCodigo,
      lubricante_codigo: lubCodigo,
      tecnico_codigo: techCodigo || null,
      nombre,
      frecuencia,
      cantidad,
      unidad,
      equivalencia_bombazo: unidad === "BOMBAZOS" ? eqBomb : null,
      unidad_equivalencia_bombazo: unidad === "BOMBAZOS" ? eqBombUnit : null,
      puntos: puntos ?? null,
      metodo,
      instrucciones: clean(get(r, "instrucciones")),
      ultima,
      proxima,
    });
  }
  if (overdueOnImport) {
    warnings.push(`${overdueOnImport} ruta${overdueOnImport === 1 ? "" : "s"} quedará${overdueOnImport === 1 ? "" : "n"} con su próxima actividad ya vencida (última fecha + frecuencia es anterior a hoy).`);
  }
  return { ...out, warnings };
}

export async function validateWorkbook(workbook, plantId, tz) {
  const sheets = {};
  const warnings = [];
  const raw = {};
  let foundAny = false;

  for (const key of SHEETS) {
    const ws = findSheet(workbook, key);
    if (!ws) {
      raw[key] = [];
      continue;
    }
    foundAny = true;
    const { rows, headers } = sheetToRows(ws);
    const missing = REQUIRED_COLUMNS[key].filter((c) => !headers.includes(normalizeHeader(c)));
    if (rows.length && missing.length) {
      raw[key] = [];
      sheets[key] = { ...bucket(), errors: [{ row: 1, message: `Faltan columnas: ${missing.join(", ")}. Descarga la plantilla para ver el formato.` }] };
      continue;
    }
    if (rows.length > MAX_ROWS) {
      raw[key] = [];
      sheets[key] = { ...bucket(), errors: [{ row: 1, message: `La hoja tiene ${rows.length} filas; el máximo por importación es ${MAX_ROWS}. Divide el archivo.` }] };
      continue;
    }
    raw[key] = rows;
  }

  if (!foundAny) {
    return {
      sheets: Object.fromEntries(SHEETS.map((k) => [k, bucket()])),
      warnings: ["El archivo no tiene ninguna hoja llamada equipos, lubricantes, tecnicos o rutas. Usa la plantilla de LubriPlan."],
    };
  }

  sheets.equipos = sheets.equipos || (await validateEquipos(raw.equipos, plantId));
  sheets.lubricantes = sheets.lubricantes || (await validateLubricantes(raw.lubricantes, plantId));
  sheets.tecnicos = sheets.tecnicos || (await validateTecnicos(raw.tecnicos, plantId));
  if (!sheets.rutas) {
    const rutas = await validateRutas(raw.rutas, plantId, { equipos: sheets.equipos.ok, lubricantes: sheets.lubricantes.ok, tecnicos: sheets.tecnicos.ok }, tz);
    warnings.push(...rutas.warnings);
    delete rutas.warnings;
    sheets.rutas = rutas;
  }
  if (sheets.equipos.skipped.some((s) => s.otherPlant)) {
    warnings.push("Algunos códigos de equipo ya los usa otra planta: el código de equipo es único en todo LubriPlan.");
  }
  return { sheets, warnings };
}

export function summarize(sheets) {
  return Object.fromEntries(
    SHEETS.map((k) => [k, { ok: sheets[k]?.ok?.length || 0, errors: sheets[k]?.errors?.length || 0, skipped: sheets[k]?.skipped?.length || 0 }])
  );
}

/* ───────── Creación ───────── */
async function createAll(tx, plantId, sheets, tz) {
  const ids = { equipos: new Map(), lubricantes: new Map(), tecnicos: new Map() };
  const counts = { equipos: 0, lubricantes: 0, tecnicos: 0, rutas: 0, actividades: 0 };

  for (const e of sheets.equipos.ok) {
    let areaId = null;
    if (e.area) {
      const area = await tx.equipmentArea.upsert({
        where: { plantId_name: { plantId, name: e.area } },
        update: {},
        create: { plantId, name: e.area },
        select: { id: true },
      });
      areaId = area.id;
    }
    const item = await tx.equipment.create({
      data: {
        plantId,
        code: e.codigo,
        name: e.nombre,
        location: e.ubicacion || "Sin ubicación",
        status: e.estado,
        criticality: e.criticidad,
        description: e.descripcion || null,
        brand: e.marca || null,
        model: e.modelo || null,
        areaId,
      },
      select: { id: true },
    });
    ids.equipos.set(e.codigo, item.id);
    counts.equipos += 1;
  }

  for (const l of sheets.lubricantes.ok) {
    const item = await tx.lubricant.create({
      data: {
        plantId,
        code: l.codigo,
        name: l.nombre,
        type: l.tipo,
        unit: l.unidad,
        stock: l.stock,
        minStock: l.minStock,
        unitCost: l.costo,
        viscosity: l.viscosidad || null,
        brand: l.marca || null,
      },
      select: { id: true },
    });
    ids.lubricantes.set(l.codigo, item.id);
    counts.lubricantes += 1;
    if (l.stock > 0) {
      await tx.lubricantMovement.create({
        data: { lubricantId: item.id, type: "IN", quantity: l.stock, reason: "Stock inicial (importación)", stockBefore: 0, stockAfter: l.stock },
      });
    }
  }

  for (const t of sheets.tecnicos.ok) {
    const item = await tx.technician.create({
      data: { plantId, code: t.codigo, name: t.nombre, specialty: t.especialidad, status: t.estatus },
      select: { id: true },
    });
    ids.tecnicos.set(t.codigo, item.id);
    counts.tecnicos += 1;
  }

  // Códigos existentes de la planta, comparados ya normalizados (mayúsculas, sin acentos).
  if (sheets.rutas.ok.length) {
    const [eqs, lubs, techs] = await Promise.all([
      tx.equipment.findMany({ where: { plantId, code: { not: null } }, select: { id: true, code: true } }),
      tx.lubricant.findMany({ where: { plantId, code: { not: null } }, select: { id: true, code: true } }),
      tx.technician.findMany({ where: { plantId, deletedAt: null }, select: { id: true, code: true } }),
    ]);
    for (const x of eqs) if (!ids.equipos.has(normalizeCode(x.code))) ids.equipos.set(normalizeCode(x.code), x.id);
    for (const x of lubs) if (!ids.lubricantes.has(normalizeCode(x.code))) ids.lubricantes.set(normalizeCode(x.code), x.id);
    for (const x of techs) if (!ids.tecnicos.has(normalizeCode(x.code))) ids.tecnicos.set(normalizeCode(x.code), x.id);
  }
  const lookup = async (map, model, code) => map.get(code) ?? null;

  for (const r of sheets.rutas.ok) {
    const equipmentId = await lookup(ids.equipos, "equipment", r.equipo_codigo);
    const lubricantId = await lookup(ids.lubricantes, "lubricant", r.lubricante_codigo);
    const technicianId = r.tecnico_codigo ? await lookup(ids.tecnicos, "technician", r.tecnico_codigo) : null;
    if (!equipmentId || !lubricantId) throw new Error(`Ruta de la fila ${r.row}: no se encontró el equipo o el lubricante`);
    const lub = await tx.lubricant.findFirst({ where: { id: lubricantId }, select: { type: true, name: true } });
    const isGrease = /grasa/i.test(`${lub?.type} ${lub?.name}`);

    const route = await tx.route.create({
      data: {
        plantId,
        equipmentId,
        lubricantId,
        technicianId,
        name: r.nombre,
        normalizedName: normalizeRouteName(r.nombre),
        lubricantType: isGrease ? "GRASA" : "ACEITE",
        quantity: r.cantidad,
        unit: r.unidad,
        pumpStrokeValue: r.equivalencia_bombazo,
        pumpStrokeUnit: r.unidad_equivalencia_bombazo,
        frequencyDays: r.frecuencia,
        method: normalizeMethod(r.metodo) || null,
        points: r.puntos,
        instructions: r.instrucciones || null,
        lastDate: noonInTz(r.ultima, tz),
        nextDate: noonInTz(r.proxima, tz),
      },
      select: { id: true },
    });
    counts.rutas += 1;

    await tx.execution.create({
      data: { plantId, routeId: route.id, equipmentId, technicianId, status: "PENDING", scheduledAt: noonInTz(r.proxima, tz) },
    });
    counts.actividades += 1;
  }
  return counts;
}

/* ───────── Plantilla ───────── */
const EXAMPLES = {
  equipos: [["EQ-001", "Compresor GA75", "Producción", "Línea 1", "Activo", "Alta", "Compresor principal", "Atlas Copco", "GA75"]],
  lubricantes: [
    ["LUB-001", "Aceite hidráulico ISO 68", "Aceite", "68", "L", 120, 20, "Shell", 95],
    ["LUB-002", "Grasa EP2 complejo de litio", "Grasa", "NLGI 2", "kg", 18, 4, "Mobil", 180],
  ],
  tecnicos: [["Luis Hernández", "TEC-01", "Lubricación general", "Activo"]],
  rutas: [
    ["EQ-001", "Revisión de nivel de aceite", 7, "LUB-001", 0.5, "L", "", "", "TEC-01", 1, "llenado", "2026-04-01", "Verificar nivel y rellenar si es necesario"],
    ["EQ-001", "Engrase de rodamientos", 15, "LUB-002", 3, "BOMBAZOS", 1.2, "g", "TEC-01", 4, "engrase manual", "01/04/2026", "Tres bombazos por punto"],
  ],
};

export function buildTemplateWorkbook(data = EXAMPLES) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "LubriPlan";
  wb.created = new Date();

  const info = wb.addWorksheet("instrucciones");
  info.columns = [{ header: "seccion", width: 16 }, { header: "detalle", width: 110 }];
  info.addRows([
    ["General", "No cambies los nombres de las hojas ni de las columnas. Puedes dejar hojas vacías. Los registros que ya existen se omiten."],
    ["General", `Máximo ${MAX_ROWS} filas por hoja. Las columnas obligatorias se marcan en la segunda fila de cada hoja.`],
    ["equipos", "codigo y nombre obligatorios. El código es único en todo LubriPlan. estado: Activo/Inactivo. criticidad: Crítica, Alta, Media o Baja."],
    ["lubricantes", "tipo: Aceite o Grasa. unidad: L, ml, kg o g. stock en esa unidad; se registra como entrada inicial. costo_unitario por unidad (opcional)."],
    ["tecnicos", "codigo único por planta (incluye técnicos eliminados). estatus: Activo o Inactivo."],
    ["rutas", "equipo_codigo, lubricante_codigo y tecnico_codigo deben existir en la planta o venir en este mismo archivo."],
    ["rutas", "frecuencia_dias entero. unidad: L, ml, kg, g o BOMBAZOS; con BOMBAZOS llena equivalencia_bombazo y unidad_equivalencia_bombazo."],
    ["rutas", "ultima_fecha_lubricacion AAAA-MM-DD o DD/MM/AAAA, no futura. La primera actividad se programa en última fecha + frecuencia."],
  ]);
  info.getRow(1).font = { bold: true };

  for (const key of SHEETS) {
    const ws = wb.addWorksheet(key);
    const cols = TEMPLATE_COLUMNS[key];
    ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.max(14, c.length + 4) }));
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.eachCell((cell, col) => {
      const required = REQUIRED_COLUMNS[key].includes(cols[col - 1]);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: required ? "FFC2410C" : "FF1F2937" } };
      cell.note = required ? "Obligatorio" : "Opcional";
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of data[key] || []) ws.addRow(row);
  }
  return wb;
}

/* ───────── Rutas HTTP ───────── */
async function plantTz(plantId) {
  const plant = await prisma.plant.findFirst({ where: { id: plantId }, select: { timezone: true } });
  return safeTimeZone(plant?.timezone || DEFAULT_TZ);
}

async function readUpload(req, res) {
  if (!req.currentPlantId) {
    res.status(400).json({ error: "PLANT_REQUIRED" });
    return null;
  }
  if (!req.file?.buffer) {
    res.status(400).json({ error: "Adjunta el archivo de Excel (.xlsx)" });
    return null;
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(req.file.buffer);
  } catch {
    res.status(400).json({ error: "No se pudo leer el archivo. Debe ser un Excel .xlsx (no .xls ni .csv)." });
    return null;
  }
  return wb;
}

router.get("/template", ...managers, async (req, res) => {
  try {
    const wb = buildTemplateWorkbook();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="lubriplan_plantilla_importacion.xlsx"');
    await wb.xlsx.write(res);
    return res.end();
  } catch (e) {
    logger.error("Import template error:", e);
    return res.status(500).json({ error: "No se pudo generar la plantilla" });
  }
});

router.post("/preview", ...managers, upload.single("file"), async (req, res) => {
  try {
    const wb = await readUpload(req, res);
    if (!wb) return undefined;
    const tz = await plantTz(req.currentPlantId);
    const { sheets, warnings } = await validateWorkbook(wb, req.currentPlantId, tz);
    return res.json({ ok: true, summary: summarize(sheets), sheets, warnings });
  } catch (e) {
    logger.error("Import preview error:", e);
    return res.status(500).json({ error: "Error validando el archivo" });
  }
});

// Confirmar: se vuelve a subir el MISMO archivo y se valida otra vez en el servidor.
router.post("/commit", ...managers, upload.single("file"), async (req, res) => {
  try {
    const wb = await readUpload(req, res);
    if (!wb) return undefined;
    const plantId = req.currentPlantId;
    const tz = await plantTz(plantId);
    const { sheets, warnings } = await validateWorkbook(wb, plantId, tz);
    const summary = summarize(sheets);
    if (SHEETS.some((k) => summary[k].errors)) {
      return res.status(400).json({ error: "El archivo tiene errores. Corrígelos y vuelve a validar.", summary, sheets, warnings });
    }
    if (!SHEETS.some((k) => summary[k].ok)) {
      return res.status(400).json({ error: "No hay registros nuevos para importar.", summary, sheets, warnings });
    }

    const created = await prisma.$transaction((tx) => createAll(tx, plantId, sheets, tz), { timeout: 120000, maxWait: 10000 });

    logger.info("[IMPORT] Importación completada", { plantId, userId: req.user?.id, created });
    logAudit({
      plantId,
      userId: req.user?.id,
      action: "CREATE",
      model: "Importación",
      recordId: req.file?.originalname || "archivo",
      changes: { after: created, skipped: Object.fromEntries(SHEETS.map((k) => [k, summary[k].skipped])) },
      ip: req.ip,
    }).catch(() => {});

    return res.json({ ok: true, created, summary, warnings });
  } catch (e) {
    if (e?.code === "P2002") {
      return res.status(409).json({ error: "Otro registro con el mismo código se creó mientras importabas. Vuelve a validar el archivo." });
    }
    logger.error("Import commit error:", e);
    return res.status(500).json({ error: "No se pudo completar la importación. No se guardó ningún registro." });
  }
});

export default router;
