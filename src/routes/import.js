import express from "express";
import ExcelJS from "exceljs";
import multer from "multer";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const SHEETS = ["equipos", "lubricantes", "tecnicos", "rutas"];
const WORKSHEET_NAMES = {
  equipos: "equipos",
  lubricantes: "lubricantes",
  tecnicos: "tecnicos",
  rutas: "rutas",
};
const VALID_STATUS = new Set(["ACTIVO", "INACTIVO"]);
const VALID_CRITICALITY = new Set(["ALTA", "MEDIA", "BAJA"]);
const VALID_LUBRICANT_TYPES = new Set(["ACEITE", "GRASA"]);
const VALID_UNITS = new Set(["L", "ML", "KG", "G", "BOMBAZOS"]);

function clean(value) {
  return String(value ?? "").trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function normalizeRouteName(value) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function normalizeHeader(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_");
}

function rowValue(row, key) {
  return row[key] ?? row[normalizeHeader(key)] ?? "";
}

function parseSheetDate(value) {
  if (!value) return null;

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0);
  }

  const raw = clean(value);
  if (!raw) return null;

  let y;
  let m;
  let d;

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    [y, m, d] = raw.slice(0, 10).split("-").map(Number);
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) {
    const parts = raw.split("/").map(Number);
    d = parts[0];
    m = parts[1];
    y = parts[2];
  }

  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days));
  d.setHours(12, 0, 0, 0);
  return d;
}

function startOfDay(value) {
  const d = parseSheetDate(value);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function toSafeNoon(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
}

function resolveImportedNextRouteDate(lastDate, frequencyDays) {
  const parsedLast = startOfDay(lastDate);
  const days = Number(frequencyDays);
  if (!parsedLast || !Number.isFinite(days) || days <= 0) return null;
  const out = new Date(parsedLast);
  out.setDate(out.getDate() + days);
  out.setHours(0, 0, 0, 0);
  return out;
}

function normalizeRouteMethod(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function dateToYmd(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sheetToRows(sheet) {
  if (!sheet) return [];
  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell((cell, col) => {
    headers[col] = normalizeHeader(cell.value);
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = { _row: rowNumber };
    let hasValue = false;

    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const value = cell.value?.text ?? cell.value?.result ?? cell.value;
      if (clean(value) !== "") hasValue = true;
      item[key] = value;
    });

    if (hasValue) rows.push(item);
  });

  return rows;
}

function addTemplateSheet(workbook, name, headers, examples) {
  const ws = workbook.addWorksheet(name);
  ws.addRow(headers);
  for (const example of examples) ws.addRow(example);

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
  });
  ws.columns.forEach((col) => {
    col.width = 24;
  });
}

async function readWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

function pushError(errors, row, message) {
  errors.push({ row, message });
}

async function validateEquipos(rows = [], plantId) {
  const errors = [];
  const ok = [];
  const seen = new Set();
  const codes = rows.map((r) => upper(rowValue(r, "codigo"))).filter(Boolean);
  const existing = codes.length
    ? await prisma.equipment.findMany({ where: { code: { in: codes } }, select: { code: true, plantId: true } })
    : [];
  const existingByCode = new Map(existing.map((x) => [upper(x.code), x]));

  for (const row of rows) {
    const codigo = upper(rowValue(row, "codigo"));
    const nombre = clean(rowValue(row, "nombre"));
    const area = clean(rowValue(row, "area"));
    const ubicacion = clean(rowValue(row, "ubicacion"));
    const estado = upper(rowValue(row, "estado")) || "ACTIVO";
    const criticidad = upper(rowValue(row, "criticidad")) || null;
    const descripcion = clean(rowValue(row, "descripcion"));
    const rowErrors = [];

    if (!codigo) rowErrors.push("codigo es obligatorio");
    if (!nombre) rowErrors.push("nombre es obligatorio");
    if (!VALID_STATUS.has(estado)) rowErrors.push("estado debe ser Activo o Inactivo");
    if (criticidad && !VALID_CRITICALITY.has(criticidad)) rowErrors.push("criticidad debe ser Alta, Media o Baja");
    if (codigo && seen.has(codigo)) rowErrors.push("codigo duplicado en el archivo");
    if (codigo && existingByCode.has(codigo)) rowErrors.push("codigo ya existe en LubriPlan");

    if (rowErrors.length) {
      for (const msg of rowErrors) pushError(errors, row._row, msg);
    } else {
      seen.add(codigo);
      ok.push({ row: row._row, codigo, nombre, area, ubicacion, estado, criticidad, descripcion });
    }
  }

  return { ok, errors };
}

async function validateLubricantes(rows = [], plantId) {
  const errors = [];
  const ok = [];
  const seen = new Set();
  const codes = rows.map((r) => upper(rowValue(r, "codigo"))).filter(Boolean);
  const existing = codes.length
    ? await prisma.lubricant.findMany({ where: { plantId, code: { in: codes } }, select: { code: true } })
    : [];
  const existingCodes = new Set(existing.map((x) => upper(x.code)));

  for (const row of rows) {
    const codigo = upper(rowValue(row, "codigo"));
    const nombre = clean(rowValue(row, "nombre"));
    const tipo = upper(rowValue(row, "tipo"));
    const viscosidad = clean(rowValue(row, "viscosidad"));
    const unidad = upper(rowValue(row, "unidad"));
    const stock = toNumber(rowValue(row, "stock"));
    const minStock = toNumber(rowValue(row, "minStock"));
    const marca = clean(rowValue(row, "marca"));
    const rowErrors = [];

    if (!codigo) rowErrors.push("codigo es obligatorio");
    if (!nombre) rowErrors.push("nombre es obligatorio");
    if (!VALID_LUBRICANT_TYPES.has(tipo)) rowErrors.push("tipo debe ser Aceite o Grasa");
    if (!VALID_UNITS.has(unidad)) rowErrors.push("unidad debe ser L, ml, kg o g");
    if (stock == null || stock < 0) rowErrors.push("stock debe ser numero mayor o igual a cero");
    if (minStock != null && minStock < 0) rowErrors.push("minStock no puede ser negativo");
    if (codigo && seen.has(codigo)) rowErrors.push("codigo duplicado en el archivo");
    if (codigo && existingCodes.has(codigo)) rowErrors.push("codigo ya existe en LubriPlan");

    if (rowErrors.length) {
      for (const msg of rowErrors) pushError(errors, row._row, msg);
    } else {
      seen.add(codigo);
      ok.push({ row: row._row, codigo, nombre, tipo, viscosidad, unidad, stock, minStock, marca });
    }
  }

  return { ok, errors };
}

async function validateTecnicos(rows = [], plantId) {
  const errors = [];
  const ok = [];
  const seen = new Set();
  const codes = rows.map((r) => upper(rowValue(r, "codigo"))).filter(Boolean);
  const existing = codes.length
    ? await prisma.technician.findMany({ where: { plantId, code: { in: codes }, deletedAt: null }, select: { code: true } })
    : [];
  const existingCodes = new Set(existing.map((x) => upper(x.code)));

  for (const row of rows) {
    const nombre = clean(rowValue(row, "nombre"));
    const codigo = upper(rowValue(row, "codigo"));
    const especialidad = clean(rowValue(row, "especialidad")) || "Lubricacion";
    const estatus = clean(rowValue(row, "estatus")) || "Activo";
    const estatusNorm = upper(estatus);
    const rowErrors = [];

    if (!nombre) rowErrors.push("nombre es obligatorio");
    if (!codigo) rowErrors.push("codigo es obligatorio");
    if (!VALID_STATUS.has(estatusNorm)) rowErrors.push("estatus debe ser Activo o Inactivo");
    if (codigo && seen.has(codigo)) rowErrors.push("codigo duplicado en el archivo");
    if (codigo && existingCodes.has(codigo)) rowErrors.push("codigo ya existe en LubriPlan");

    if (rowErrors.length) {
      for (const msg of rowErrors) pushError(errors, row._row, msg);
    } else {
      seen.add(codigo);
      ok.push({ row: row._row, nombre, codigo, especialidad, estatus: estatusNorm === "ACTIVO" ? "Activo" : "Inactivo" });
    }
  }

  return { ok, errors };
}

async function validateRutas(rows = [], plantId, staged = {}) {
  const errors = [];
  const ok = [];
  const equipmentCodes = rows.map((r) => upper(rowValue(r, "equipo_codigo"))).filter(Boolean);
  const lubricantCodes = rows.map((r) => upper(rowValue(r, "lubricante_codigo"))).filter(Boolean);
  const technicianCodes = rows.map((r) => upper(rowValue(r, "tecnico_codigo"))).filter(Boolean);

  const [equipments, lubricants, technicians] = await Promise.all([
    equipmentCodes.length ? prisma.equipment.findMany({ where: { plantId, code: { in: equipmentCodes } }, select: { id: true, code: true } }) : [],
    lubricantCodes.length ? prisma.lubricant.findMany({ where: { plantId, code: { in: lubricantCodes } }, select: { id: true, code: true, type: true, name: true } }) : [],
    technicianCodes.length ? prisma.technician.findMany({ where: { plantId, code: { in: technicianCodes }, deletedAt: null }, select: { id: true, code: true } }) : [],
  ]);

  const equipmentByCode = new Map(equipments.map((x) => [upper(x.code), x]));
  const lubricantByCode = new Map(lubricants.map((x) => [upper(x.code), x]));
  const technicianByCode = new Map(technicians.map((x) => [upper(x.code), x]));
  const seenRoutes = new Set();

  for (const item of staged.equipos || []) equipmentByCode.set(upper(item.codigo), { id: item.id ?? null, code: item.codigo });
  for (const item of staged.lubricantes || []) {
    lubricantByCode.set(upper(item.codigo), {
      id: item.id ?? null,
      code: item.codigo,
      type: item.tipo,
      name: item.nombre,
    });
  }
  for (const item of staged.tecnicos || []) technicianByCode.set(upper(item.codigo), { id: item.id ?? null, code: item.codigo });

  for (const row of rows) {
    const equipoCodigo = upper(rowValue(row, "equipo_codigo"));
    const nombre = clean(rowValue(row, "nombre"));
    const frecuenciaDias = toNumber(rowValue(row, "frecuencia_dias"));
    const lubricanteCodigo = upper(rowValue(row, "lubricante_codigo"));
    const cantidad = toNumber(rowValue(row, "cantidad"));
    const unidad = upper(rowValue(row, "unidad"));
    const equivalenciaBombazo = toNumber(rowValue(row, "equivalencia_bombazo"));
    const unidadEquivalenciaBombazo = upper(rowValue(row, "unidad_equivalencia_bombazo"));
    const tecnicoCodigo = upper(rowValue(row, "tecnico_codigo"));
    const puntosLubricacion = toNumber(rowValue(row, "puntos_lubricacion"));
    const metodoAplicacion = clean(rowValue(row, "metodo_aplicacion"));
    const instrucciones = clean(rowValue(row, "instrucciones"));
    const ultimaFecha = parseSheetDate(rowValue(row, "ultima_fecha_lubricacion"));
    const rowErrors = [];

    const equipment = equipmentByCode.get(equipoCodigo);
    const lubricant = lubricantByCode.get(lubricanteCodigo);
    const technician = tecnicoCodigo ? technicianByCode.get(tecnicoCodigo) : null;
    const proximaFecha = resolveImportedNextRouteDate(ultimaFecha, frecuenciaDias);
    const normalizedMethod = normalizeRouteMethod(metodoAplicacion);

    if (!equipoCodigo) rowErrors.push("equipo_codigo es obligatorio");
    if (equipoCodigo && !equipment) rowErrors.push("equipo_codigo no existe");
    if (!nombre) rowErrors.push("nombre es obligatorio");
    if (frecuenciaDias == null || frecuenciaDias <= 0) rowErrors.push("frecuencia_dias debe ser mayor a cero");
    if (!lubricanteCodigo) rowErrors.push("lubricante_codigo es obligatorio");
    if (lubricanteCodigo && !lubricant) rowErrors.push("lubricante_codigo no existe");
    if (cantidad == null || cantidad < 0) rowErrors.push("cantidad debe ser mayor o igual a cero");
    if (!VALID_UNITS.has(unidad)) rowErrors.push("unidad debe ser L, ml, kg, g o BOMBAZOS");
    if (tecnicoCodigo && !technician) rowErrors.push("tecnico_codigo no existe");
    if (puntosLubricacion != null && (!Number.isFinite(puntosLubricacion) || puntosLubricacion <= 0)) {
      rowErrors.push("puntos_lubricacion debe ser mayor a cero");
    }
    if (!ultimaFecha) rowErrors.push("ultima_fecha_lubricacion es obligatoria");
    if (unidad === "BOMBAZOS") {
      if (equivalenciaBombazo == null || equivalenciaBombazo <= 0) {
        rowErrors.push("equivalencia_bombazo debe ser mayor a cero cuando la unidad es BOMBAZOS");
      }
      if (!unidadEquivalenciaBombazo || !new Set(["L", "ML", "KG", "G"]).has(unidadEquivalenciaBombazo)) {
        rowErrors.push("unidad_equivalencia_bombazo debe ser L, ml, kg o g cuando la unidad es BOMBAZOS");
      }
    }

    const fileRouteKey = `${equipoCodigo}|${normalizeRouteName(nombre)}|${lubricanteCodigo}|${normalizedMethod}`;
    if (seenRoutes.has(fileRouteKey)) rowErrors.push("ruta duplicada en el archivo");

    if (equipment?.id && lubricant?.id) {
      const duplicate = await prisma.route.findFirst({
        where: {
          plantId,
          equipmentId: equipment.id,
          lubricantId: lubricant.id,
          normalizedName: normalizeRouteName(nombre),
          method: normalizedMethod,
        },
        select: { id: true },
      });
      if (duplicate) rowErrors.push("ruta ya existe para ese equipo, nombre, lubricante y metodo");
    }

    if (rowErrors.length) {
      for (const msg of rowErrors) pushError(errors, row._row, msg);
    } else {
      seenRoutes.add(fileRouteKey);
      ok.push({
        row: row._row,
        equipo_codigo: equipoCodigo,
        nombre,
        frecuencia_dias: frecuenciaDias,
        lubricante_codigo: lubricanteCodigo,
        cantidad,
        unidad,
        equivalencia_bombazo: unidad === "BOMBAZOS" ? equivalenciaBombazo : null,
        unidad_equivalencia_bombazo: unidad === "BOMBAZOS" ? unidadEquivalenciaBombazo : null,
        tecnico_codigo: tecnicoCodigo,
        puntos_lubricacion: puntosLubricacion,
        metodo_aplicacion: metodoAplicacion,
        instrucciones,
        ultima_fecha_lubricacion: dateToYmd(ultimaFecha),
        proxima_fecha: dateToYmd(proximaFecha),
        equipmentId: equipment.id ?? null,
        lubricantId: lubricant.id ?? null,
        technicianId: technician?.id ?? null,
        lubricantType: upper(lubricant.type) || (unidad === "L" || unidad === "ML" ? "ACEITE" : "GRASA"),
        lubricantName: lubricant.name || null,
      });
    }
  }

  return { ok, errors };
}

async function validateWorkbook(workbook, plantId) {
  const result = {};
  const raw = {};
  for (const sheetKey of SHEETS) raw[sheetKey] = sheetToRows(workbook.getWorksheet(WORKSHEET_NAMES[sheetKey]));

  result.equipos = await validateEquipos(raw.equipos, plantId);
  result.lubricantes = await validateLubricantes(raw.lubricantes, plantId);
  result.tecnicos = await validateTecnicos(raw.tecnicos, plantId);
  result.rutas = await validateRutas(raw.rutas, plantId, {
    equipos: result.equipos.ok,
    lubricantes: result.lubricantes.ok,
    tecnicos: result.tecnicos.ok,
  });

  return result;
}

function summaryFromResult(result) {
  return Object.fromEntries(
    SHEETS.map((sheetKey) => [sheetKey, { ok: result[sheetKey]?.ok?.length || 0, errors: result[sheetKey]?.errors?.length || 0 }])
  );
}

async function createEquipos(rows, plantId, tx) {
  const created = [];
  for (const row of rows || []) {
    let areaId = null;
    if (row.area) {
      const area = await tx.equipmentArea.upsert({
        where: { plantId_name: { plantId, name: row.area } },
        update: {},
        create: { plantId, name: row.area },
      });
      areaId = area.id;
    }

    const item = await tx.equipment.create({
      data: {
        plantId,
        code: row.codigo,
        name: row.nombre,
        location: row.ubicacion || "Sin ubicacion",
        status: row.estado,
        criticality: row.criticidad,
        description: row.descripcion || null,
        areaId,
      },
      select: { id: true, code: true, name: true },
    });
    created.push({ id: item.id, codigo: item.code, nombre: item.name });
  }
  return created;
}

async function createLubricantes(rows, plantId, tx) {
  const created = [];
  for (const row of rows || []) {
    const item = await tx.lubricant.create({
      data: {
        plantId,
        code: row.codigo,
        name: row.nombre,
        type: row.tipo,
        viscosity: row.viscosidad || null,
        unit: String(row.unidad || "").toLowerCase(),
        stock: Number(row.stock || 0),
        minStock: row.minStock == null ? null : Number(row.minStock),
        brand: row.marca || null,
      },
      select: { id: true, code: true, name: true, type: true },
    });
    created.push({ id: item.id, codigo: item.code, nombre: item.name, tipo: item.type });
  }
  return created;
}

async function createTecnicos(rows, plantId, tx) {
  const created = [];
  for (const row of rows || []) {
    const item = await tx.technician.create({
      data: {
        plantId,
        code: row.codigo,
        name: row.nombre,
        specialty: row.especialidad || "Lubricacion",
        status: row.estatus || "Activo",
      },
      select: { id: true, code: true, name: true },
    });
    created.push({ id: item.id, codigo: item.code, nombre: item.name });
  }
  return created;
}

async function createRutas(rows, plantId, tx, staged) {
  const created = [];
  const equipmentByCode = new Map((staged.equipos || []).map((x) => [upper(x.codigo), x]));
  const lubricantByCode = new Map((staged.lubricantes || []).map((x) => [upper(x.codigo), x]));
  const technicianByCode = new Map((staged.tecnicos || []).map((x) => [upper(x.codigo), x]));

  for (const row of rows || []) {
    let equipment = equipmentByCode.get(upper(row.equipo_codigo));
    if (!equipment) {
      equipment = await tx.equipment.findFirst({ where: { plantId, code: upper(row.equipo_codigo) }, select: { id: true, code: true, name: true } });
    }

    let lubricant = lubricantByCode.get(upper(row.lubricante_codigo));
    if (!lubricant) {
      lubricant = await tx.lubricant.findFirst({ where: { plantId, code: upper(row.lubricante_codigo) }, select: { id: true, code: true, name: true, type: true } });
    }

    let technician = null;
    if (row.tecnico_codigo) {
      technician = technicianByCode.get(upper(row.tecnico_codigo));
      if (!technician) {
        technician = await tx.technician.findFirst({ where: { plantId, code: upper(row.tecnico_codigo), deletedAt: null }, select: { id: true, code: true } });
      }
    }

    if (!equipment || !lubricant) throw new Error(`Ruta fila ${row.row}: referencia no encontrada`);

    const lastDate = parseSheetDate(row.ultima_fecha_lubricacion);
    const nextDate = resolveImportedNextRouteDate(lastDate, row.frecuencia_dias);
    const scheduledAt = nextDate ? toSafeNoon(nextDate) : toSafeNoon(new Date());
    const pointsInt =
      row.puntos_lubricacion === "" || row.puntos_lubricacion == null
        ? null
        : Number(row.puntos_lubricacion);
    const normalizedMethod = normalizeRouteMethod(row.metodo_aplicacion);

    const route = await tx.route.create({
      data: {
        plantId,
        equipmentId: equipment.id,
        lubricantId: lubricant.id,
        technicianId: technician?.id ?? null,
        name: row.nombre,
        normalizedName: normalizeRouteName(row.nombre),
        lubricantType: row.lubricantType || upper(lubricant.type) || "ACEITE",
        lubricantName: null,
        quantity: Number(row.cantidad),
        unit: String(row.unidad).trim().toUpperCase() === "BOMBAZOS" ? "BOMBAZOS" : String(row.unidad).toLowerCase(),
        pumpStrokeValue: String(row.unidad).trim().toUpperCase() === "BOMBAZOS" ? Number(row.equivalencia_bombazo) : null,
        pumpStrokeUnit: String(row.unidad).trim().toUpperCase() === "BOMBAZOS" ? String(row.unidad_equivalencia_bombazo || "").toLowerCase() : null,
        frequencyDays: Number(row.frecuencia_dias),
        method: normalizedMethod,
        points: pointsInt,
        instructions: row.instrucciones || null,
        lastDate,
        nextDate,
      },
      select: { id: true, name: true },
    });

    await tx.execution.create({
      data: {
        plantId,
        routeId: route.id,
        equipmentId: equipment.id,
        technicianId: technician?.id ?? null,
        status: "PENDING",
        scheduledAt,
      },
    });

    created.push({ id: route.id, nombre: route.name });
  }

  return created;
}

router.get("/template", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "LubriPlan";
  workbook.created = new Date();

  addTemplateSheet(
    workbook,
    "instrucciones",
    ["seccion", "detalle"],
    [
      ["Equipos", "Llena una fila por equipo. El codigo debe ser unico por planta."],
      ["Lubricantes", "Usa unidad base L, ML, KG o G segun el producto."],
      ["Tecnicos", "El codigo del tecnico debe ser unico por planta."],
      ["Rutas", "Si unidad = BOMBAZOS, llena equivalencia_bombazo y unidad_equivalencia_bombazo."],
      ["Rutas", "Agrega puntos_lubricacion y metodo_aplicacion para describir mejor la ruta."],
      ["Rutas", "ultima_fecha_lubricacion debe ir en formato AAAA-MM-DD o DD/MM/AAAA."],
    ]
  );

  addTemplateSheet(workbook, "equipos", ["codigo", "nombre", "area", "ubicacion", "estado", "criticidad", "descripcion"], [
    ["EQ-001", "Compresor GA75", "Produccion", "Linea 1", "Activo", "Alta", "Compresor principal"],
  ]);

  addTemplateSheet(workbook, "lubricantes", ["codigo", "nombre", "tipo", "viscosidad", "unidad", "stock", "minStock", "marca"], [
    ["LUB-001", "Aceite hidraulico ISO 68", "Aceite", "68", "L", 120, 20, "Shell"],
  ]);

  addTemplateSheet(workbook, "tecnicos", ["nombre", "codigo", "especialidad", "estatus"], [
    ["Luis Hernandez", "TEC-01", "Lubricacion general", "Activo"],
  ]);

  addTemplateSheet(
    workbook,
    "rutas",
    [
      "Equipo_codigo",
      "Nombre",
      "Frecuencia_dias",
      "Lubricante_codigo",
      "Cantidad",
      "Unidad",
      "Equivalencia_bombazo",
      "Unidad_equivalencia_bombazo",
      "Tecnico_codigo",
      "Puntos_lubricacion",
      "Metodo_aplicacion",
      "ultima_fecha_lubricacion",
      "Instrucciones",
    ],
    [
      ["EQ-001", "Revision nivel aceite", 7, "LUB-001", 0.5, "L", "", "", "TEC-01", 1, "llenado", "2026-04-01", "Verificar nivel y rellenar si es necesario"],
      ["EQ-002", "Engrase de rodamientos", 15, "LUB-002", 3, "BOMBAZOS", 8, "G", "TEC-01", 4, "engrase manual", "2026-04-02", "Aplicar tres bombazos por punto"],
    ]
  );

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="lubriplan_plantilla_importacion.xlsx"');
  await workbook.xlsx.write(res);
  return res.end();
});

router.post("/preview", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), upload.single("file"), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
    if (!req.file?.buffer) return res.status(400).json({ error: "Archivo requerido" });

    const workbook = await readWorkbook(req.file.buffer);
    const result = await validateWorkbook(workbook, plantId);
    return res.json({ ok: true, summary: summaryFromResult(result), sheets: result });
  } catch (error) {
    console.error("Import preview error:", error);
    return res.status(500).json({ error: "Error validando archivo" });
  }
});

router.post("/commit", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const sheets = req.body?.sheets || {};
    const hasErrors = SHEETS.some((sheetKey) => (sheets?.[sheetKey]?.errors || []).length > 0);
    if (hasErrors) return res.status(400).json({ error: "Corrige los errores antes de importar" });

    const created = await prisma.$transaction(async (tx) => {
      const staged = { equipos: [], lubricantes: [], tecnicos: [], rutas: [] };
      staged.equipos = await createEquipos(sheets.equipos?.ok || [], plantId, tx);
      staged.lubricantes = await createLubricantes(sheets.lubricantes?.ok || [], plantId, tx);
      staged.tecnicos = await createTecnicos(sheets.tecnicos?.ok || [], plantId, tx);
      staged.rutas = await createRutas(sheets.rutas?.ok || [], plantId, tx, staged);
      return staged;
    });

    return res.json({ ok: true, created, summary: Object.fromEntries(SHEETS.map((sheetKey) => [sheetKey, created[sheetKey]?.length || 0])) });
  } catch (error) {
    console.error("Import commit error:", error);
    return res.status(500).json({ error: error?.message || "Error importando archivo" });
  }
});

export default router;

