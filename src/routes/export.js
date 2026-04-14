import express from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = express.Router();

const DEFAULT_TIMEZONE = "America/Mexico_City";

function parseDateOnlyLocal(value) {
  if (!value) return null;
  const raw = String(value).trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0);
}

function dateKeyInTimezone(value, timezone = DEFAULT_TIMEZONE) {
  const dt = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(dt.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(dt);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function formatDateTimeInTimezone(value, timezone = DEFAULT_TIMEZONE) {
  if (!value) return "";
  const dt = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(dt.getTime())) return "";
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(dt);
}

function formatDateInTimezone(value, timezone = DEFAULT_TIMEZONE) {
  if (!value) return "";
  const dt = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(dt.getTime())) return "";
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
}

function toDateStart(v) {
  if (!v) return null;
  const d = parseDateOnlyLocal(v) || new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDateEnd(v) {
  if (!v) return null;
  const d = parseDateOnlyLocal(v) || new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - Number(n || 0));
  d.setHours(0, 0, 0, 0);
  return d;
}

function slug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function resourceLabel(resources = []) {
  const values = Array.from(new Set((resources || []).map((x) => String(x || "").toLowerCase())));
  if (values.length > 1) return "reporte-consolidado";
  const key = values[0] || "datos";
  const labels = {
    executions: "actividades",
    movements: "movimientos-inventario",
    routes: "rutas",
    failures: "fallas",
    emergents: "actividades-emergentes",
    condition_reports: "reportes-condicion",
  };
  return labels[key] || "datos";
}

async function buildExportFilename({ plantId, resources, extension, timezone = DEFAULT_TIMEZONE }) {
  const plant = plantId
    ? await prisma.plant.findUnique({ where: { id: plantId }, select: { name: true } })
    : null;
  const plantSlug = slug(plant?.name) || "planta";
  const date = dateKeyInTimezone(new Date(), timezone);
  return `lubriplan_${plantSlug}_${resourceLabel(resources)}_${date}.${extension}`;
}

function addHeaderRow(ws, headers) {
  ws.addRow(headers);
  const row = ws.getRow(1);
  row.font = { bold: true };

  row.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF3F4F6" },
    };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD1D5DB" } },
      left: { style: "thin", color: { argb: "FFD1D5DB" } },
      bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
      right: { style: "thin", color: { argb: "FFD1D5DB" } },
    };
  });
}

function autoFitColumns(ws) {
  ws.columns.forEach((column) => {
    let max = 12;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const len = String(cell.value ?? "").length;
      if (len > max) max = len;
    });
    column.width = Math.min(max + 2, 40);
  });
}

function addPdfSectionTitle(doc, title) {
  if (doc.y > 720) doc.addPage();
  doc.moveDown(0.5);
  doc.fontSize(14).fillColor("#0f172a").text(title, { underline: true });
  doc.moveDown(0.4);
}

function addPdfRows(doc, headers, rows) {
  doc.fontSize(9).fillColor("#111827");
  doc.text(headers.join(" | "));
  doc.moveDown(0.2);

  for (const row of rows) {
    if (doc.y > 740) doc.addPage();
    doc.fontSize(8).fillColor("#374151").text(row.map((v) => String(v ?? "")).join(" | "));
    doc.moveDown(0.15);
  }

  doc.moveDown(0.6);
}

/* =========================
   HELPERS DE DATA
========================= */

async function getExecutionsExportData({ currentPlantId, dateFrom, dateTo, req, timezone }) {
  const where = {
    plantId: currentPlantId,
    ...(dateFrom || dateTo
      ? {
          OR: [
            {
              scheduledAt: {
                ...(dateFrom ? { gte: dateFrom } : {}),
                ...(dateTo ? { lte: dateTo } : {}),
              },
            },
            {
              executedAt: {
                ...(dateFrom ? { gte: dateFrom } : {}),
                ...(dateTo ? { lte: dateTo } : {}),
              },
            },
          ],
        }
      : {}),
    ...(req.query.status ? { status: String(req.query.status).toUpperCase() } : {}),
    ...(req.query.techId ? { technicianId: Number(req.query.techId) } : {}),
  };

  const items = await prisma.execution.findMany({
    where,
    orderBy: { scheduledAt: "desc" },
    include: {
      route: {
        include: {
          equipment: true,
          lubricant: true,
        },
      },
      equipment: true,
      technician: true,
      lubricantMovements: {
        orderBy: { createdAt: "desc" },
        include: { lubricant: true },
      },
    },
  });

  return items.map((x) => {
    const latestMove = Array.isArray(x.lubricantMovements)
      ? x.lubricantMovements[0] || null
      : null;

    return {
      id: x.id,
      estado: x.status || "",
      origen: x.origin || "",
      actividad: x.manualTitle || x.route?.name || "",
      equipo: x.equipment?.name || x.route?.equipment?.name || "",
      tag: x.equipment?.code || x.route?.equipment?.code || x.route?.equipment?.tag || "",
      lubricante:
        latestMove?.lubricant?.name ||
        x.route?.lubricant?.name ||
        x.route?.lubricantType ||
        "",
      cantidadCaptura: x.usedInputQuantity ?? x.usedQuantity ?? "",
      unidadCaptura: x.usedInputUnit || latestMove?.inputUnit || x.route?.unit || "",
      cantidadInventario: x.usedConvertedQuantity ?? "",
      unidadInventario:
        x.usedConvertedUnit ||
        latestMove?.convertedUnit ||
        latestMove?.lubricant?.unit ||
        x.route?.lubricant?.unit ||
        "",
      tecnico: x.technician?.name || "",
      programada: x.scheduledAt ? formatDateTimeInTimezone(x.scheduledAt, timezone) : "",
      ejecutada: x.executedAt ? formatDateTimeInTimezone(x.executedAt, timezone) : "",
      condicion: x.condition || "",
      observaciones: x.observations || "",
    };
  });
}
async function getMovementsExportData({ currentPlantId, dateFrom, dateTo, req, timezone }) {
  const where = {
    ...(dateFrom || dateTo
      ? {
          OR: [
            {
              createdAt: {
                ...(dateFrom ? { gte: dateFrom } : {}),
                ...(dateTo ? { lte: dateTo } : {}),
              },
            },
            {
              execution: {
                is: {
                  executedAt: {
                    ...(dateFrom ? { gte: dateFrom } : {}),
                    ...(dateTo ? { lte: dateTo } : {}),
                  },
                },
              },
            },
          ],
        }
      : {}),
    ...(req.query.type ? { type: String(req.query.type).toUpperCase() } : {}),
    OR: [
      {
        lubricant: {
          is: {
            plantId: currentPlantId,
          },
        },
      },
      {
        execution: {
          is: {
            plantId: currentPlantId,
          },
        },
      },
    ],
  };

  const items = await prisma.lubricantMovement.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      lubricant: true,
      execution: {
        include: {
          technician: true,
          equipment: true,
          route: {
            include: {
              equipment: true,
            },
          },
        },
      },
    },
  });

  return items.map((x) => ({
    id: x.id,
    fecha: x.execution?.executedAt
      ? formatDateTimeInTimezone(x.execution.executedAt, timezone)
      : x.createdAt
      ? formatDateTimeInTimezone(x.createdAt, timezone)
      : "",
    tipo: x.type || "",
    lubricante: x.lubricant?.name || "",
    cantidad: x.quantity ?? "",
    unidad: x.lubricant?.unit || "",
    cantidadCaptura: x.inputQuantity ?? "",
    unidadCaptura: x.inputUnit || "",
    cantidadConvertida: x.convertedQuantity ?? "",
    unidadConvertida: x.convertedUnit || "",
    ejecucion: x.executionId || "",
    ruta: x.execution?.route?.name || x.execution?.manualTitle || "",
    equipo: x.execution?.route?.equipment?.name || x.execution?.equipment?.name || "",
    tecnico: x.execution?.technician?.name || "",
  }));
}

async function getRoutesExportData({ currentPlantId, timezone }) {
  const items = await prisma.route.findMany({
    where: { plantId: currentPlantId },
    orderBy: { id: "desc" },
    include: {
      equipment: true,
      lubricant: true,
      technician: true,
    },
  });

  return items.map((x) => ({
    id: x.id,
    nombre: x.name || "",
    equipo: x.equipment?.name || "",
    tag: x.equipment?.code || x.equipment?.tag || "",
    tipoLubricante: x.lubricantType || "",
    lubricanteInventario: x.lubricant?.name || x.lubricantName || "",
    cantidad: x.quantity ?? "",
    unidad: x.unit || "",
    metodo: x.method || "",
    puntos: x.points ?? "",
    frecuenciaDias: x.frequencyDays ?? "",
    tecnico: x.technician?.name || "",
    ultimaFecha: x.lastDate ? formatDateInTimezone(x.lastDate, timezone) : "",
    proximaFecha: x.nextDate ? formatDateInTimezone(x.nextDate, timezone) : "",
  }));
}

async function getFailuresExportData({ currentPlantId, dateFrom, dateTo, req, timezone }) {
  const severity = String(req.query.severity || "ALL").toUpperCase();

  const conditionWhere =
    severity === "ALL"
      ? { in: ["MALO", "CRITICO"] }
      : severity === "MALO"
      ? "MALO"
      : severity === "CRITICO"
      ? "CRITICO"
      : { in: ["MALO", "CRITICO"] };

  const items = await prisma.execution.findMany({
    where: {
      plantId: currentPlantId,
      status: "COMPLETED",
      condition: conditionWhere,
      ...(dateFrom || dateTo
        ? {
            executedAt: {
              ...(dateFrom ? { gte: dateFrom } : {}),
              ...(dateTo ? { lte: dateTo } : {}),
            },
          }
        : {}),
    },
    orderBy: { executedAt: "desc" },
    include: {
      route: {
        include: {
          equipment: true,
        },
      },
      technician: true,
    },
  });

  return items.map((x) => ({
    id: x.id,
    fecha: x.executedAt ? formatDateTimeInTimezone(x.executedAt, timezone) : "",
    condicion: x.condition || "",
    actividad: x.route?.name || x.manualTitle || "",
    equipo: x.route?.equipment?.name || "",
    tag: x.route?.equipment?.code || x.route?.equipment?.tag || "",
    tecnico: x.technician?.name || "",
    observaciones: x.observations || "",
  }));
}

async function getEmergentsExportData({ currentPlantId }) {
  const items = await prisma.route.findMany({
    where: {
      plantId: currentPlantId,
      isEmergency: true,
    },
    orderBy: { id: "desc" },
    include: {
      equipment: true,
      technician: true,
      lubricant: true,
    },
  });

  return items.map((x) => ({
    id: x.id,
    nombre: x.name || "",
    equipo: x.equipment?.name || "",
    tag: x.equipment?.code || x.equipment?.tag || "",
    tecnico: x.technician?.name || "",
    lubricante: x.lubricant?.name || x.lubricantName || x.lubricantType || "",
    cantidad: x.quantity ?? "",
    unidad: x.unit || "",
    metodo: x.method || "",
    instrucciones: x.instructions || "",
  }));
}

async function getConditionReportsExportData({
  currentPlantId,
  dateFrom,
  dateTo,
  req,
  timezone,
}) {
  const reportStatus = req.query.reportStatus
    ? String(req.query.reportStatus).toUpperCase()
    : "";
  const reportCondition = req.query.reportCondition
    ? String(req.query.reportCondition).toUpperCase()
    : "";
  const reportCategory = req.query.reportCategory
    ? String(req.query.reportCategory).toUpperCase()
    : "";

  const where = {
    plantId: currentPlantId,
    ...(dateFrom || dateTo
      ? {
          createdAt: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
      : {}),
    ...(reportStatus ? { status: reportStatus } : {}),
    ...(reportCondition ? { condition: reportCondition } : {}),
    ...(reportCategory ? { category: reportCategory } : {}),
  };

  const items = await prisma.conditionReport.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      equipment: true,
      reportedBy: true,
      correctiveExecution: true,
      dismissedBy: true,
    },
  });

  return items.map((x) => ({
    id: x.id,
    fecha: x.createdAt ? formatDateTimeInTimezone(x.createdAt, timezone) : "",
    equipo: x.equipment?.name || "",
    tag: x.equipment?.code || x.equipment?.tag || "",
    condicion: x.condition || "",
    categoria: x.category || "",
    descripcion: x.description || "",
    estado: x.status || "",
    reportadoPor: x.reportedBy?.name || "",
    evidencia: x.evidenceImage ? "Sí" : "No",
    descartadoPor: x.dismissedBy?.name || "",
    ejecucionCorrectiva: x.correctiveExecution?.id || "",
  }));
}

/* =========================
   XLSX
========================= */

router.get("/xlsx", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const currentPlantId = req.currentPlantId;
    if (!currentPlantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const plant = await prisma.plant.findUnique({
      where: { id: currentPlantId },
      select: { timezone: true },
    });
    const plantTimezone = String(plant?.timezone || DEFAULT_TIMEZONE);

    const resourcesRaw = String(req.query.resources || "executions");
    const resources = resourcesRaw
      .split(",")
      .map((x) => String(x || "").trim().toLowerCase())
      .filter(Boolean);

    const from = req.query.from ? toDateStart(req.query.from) : null;
    const to = req.query.to ? toDateEnd(req.query.to) : null;
    const days = req.query.days ? Number(req.query.days) : null;

    const dateFrom = from || (Number.isFinite(days) ? daysAgo(days) : null);
    const dateTo = to || new Date();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "LubriPlan";
    workbook.created = new Date();

    if (resources.includes("executions")) {
      const items = await getExecutionsExportData({
        currentPlantId,
        dateFrom,
        dateTo,
        req,
        timezone: plantTimezone,
      });
      const ws = workbook.addWorksheet("Ejecuciones");

      addHeaderRow(ws, [
        "ID",
        "Estado",
        "Origen",
        "Actividad",
        "Equipo",
        "TAG/Código",
        "Lubricante",
        "Cantidad captura",
        "Unidad captura",
        "Cantidad inventario",
        "Unidad inventario",
        "Técnico",
        "Programada",
        "Ejecutada",
        "Condición",
        "Observaciones",
      ]);

      for (const x of items) {
        ws.addRow([
          x.id,
          x.estado,
          x.origen,
          x.actividad,
          x.equipo,
          x.tag,
          x.lubricante,
          x.cantidadCaptura,
          x.unidadCaptura,
          x.cantidadInventario,
          x.unidadInventario,
          x.tecnico,
          x.programada,
          x.ejecutada,
          x.condicion,
          x.observaciones,
        ]);
      }

      autoFitColumns(ws);
    }

    if (resources.includes("movements")) {
      const items = await getMovementsExportData({
        currentPlantId,
        dateFrom,
        dateTo,
        req,
        timezone: plantTimezone,
      });
      const ws = workbook.addWorksheet("Movimientos");

      addHeaderRow(ws, [
        "ID",
        "Fecha",
        "Tipo",
        "Lubricante",
        "Cantidad",
        "Unidad",
        "Cantidad captura",
        "Unidad captura",
        "Cantidad convertida",
        "Unidad convertida",
        "Ejecución",
        "Ruta",
        "Equipo",
        "Técnico",
      ]);

      for (const x of items) {
        ws.addRow([
          x.id,
          x.fecha,
          x.tipo,
          x.lubricante,
          x.cantidad,
          x.unidad,
          x.cantidadCaptura,
          x.unidadCaptura,
          x.cantidadConvertida,
          x.unidadConvertida,
          x.ejecucion,
          x.ruta,
          x.equipo,
          x.tecnico,
        ]);
      }

      autoFitColumns(ws);
    }

    if (resources.includes("routes")) {
      const items = await getRoutesExportData({ currentPlantId, timezone: plantTimezone });
      const ws = workbook.addWorksheet("Rutas");

      addHeaderRow(ws, [
        "ID",
        "Nombre",
        "Equipo",
        "TAG/Código",
        "Tipo lubricante",
        "Lubricante inventario",
        "Cantidad",
        "Unidad",
        "Método",
        "Puntos",
        "Frecuencia días",
        "Técnico",
        "Última fecha",
        "Próxima fecha",
      ]);

      for (const x of items) {
        ws.addRow([
          x.id,
          x.nombre,
          x.equipo,
          x.tag,
          x.tipoLubricante,
          x.lubricanteInventario,
          x.cantidad,
          x.unidad,
          x.metodo,
          x.puntos,
          x.frecuenciaDias,
          x.tecnico,
          x.ultimaFecha,
          x.proximaFecha,
        ]);
      }

      autoFitColumns(ws);
    }

    if (resources.includes("failures")) {
      const items = await getFailuresExportData({
        currentPlantId,
        dateFrom,
        dateTo,
        req,
        timezone: plantTimezone,
      });
      const ws = workbook.addWorksheet("Fallas");

      addHeaderRow(ws, [
        "ID",
        "Fecha",
        "Condición",
        "Actividad",
        "Equipo",
        "TAG/Código",
        "Técnico",
        "Observaciones",
      ]);

      for (const x of items) {
        ws.addRow([
          x.id,
          x.fecha,
          x.condicion,
          x.actividad,
          x.equipo,
          x.tag,
          x.tecnico,
          x.observaciones,
        ]);
      }

      autoFitColumns(ws);
    }

    if (resources.includes("emergents")) {
      const items = await getEmergentsExportData({ currentPlantId });
      const ws = workbook.addWorksheet("Emergentes");

      addHeaderRow(ws, [
        "ID",
        "Nombre",
        "Equipo",
        "TAG/Código",
        "Técnico",
        "Lubricante",
        "Cantidad",
        "Unidad",
        "Método",
        "Instrucciones",
      ]);

      for (const x of items) {
        ws.addRow([
          x.id,
          x.nombre,
          x.equipo,
          x.tag,
          x.tecnico,
          x.lubricante,
          x.cantidad,
          x.unidad,
          x.metodo,
          x.instrucciones,
        ]);
      }

      autoFitColumns(ws);
    }

    if (resources.includes("condition_reports")) {
      const items = await getConditionReportsExportData({
        currentPlantId,
        dateFrom,
        dateTo,
        req,
        timezone: plantTimezone,
      });

      const ws = workbook.addWorksheet("Condición reportada");

      addHeaderRow(ws, [
        "ID",
        "Fecha",
        "Equipo",
        "TAG/Código",
        "Condición",
        "Categoría",
        "Descripción",
        "Estado",
        "Reportado por",
        "Evidencia",
        "Descartado por",
        "Ejecución correctiva",
      ]);

      for (const x of items) {
        ws.addRow([
          x.id,
          x.fecha,
          x.equipo,
          x.tag,
          x.condicion,
          x.categoria,
          x.descripcion,
          x.estado,
          x.reportadoPor,
          x.evidencia,
          x.descartadoPor,
          x.ejecucionCorrectiva,
        ]);
      }

      autoFitColumns(ws);
    }

    if (workbook.worksheets.length === 0) {
      const ws = workbook.addWorksheet("Export");
      addHeaderRow(ws, ["Mensaje"]);
      ws.addRow(["No se seleccionó ningún recurso válido"]);
      autoFitColumns(ws);
    }

    const filename = await buildExportFilename({
      plantId: currentPlantId,
      resources,
      extension: "xlsx",
      timezone: plantTimezone,
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    return res.end();
  } catch (e) {
    console.error("GET /export/xlsx error:", e);
    return res.status(500).json({ error: e?.message || "Error generando exportación XLSX" });
  }
});

/* =========================
   PDF
========================= */

router.get("/pdf", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const currentPlantId = req.currentPlantId;
    if (!currentPlantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const plant = await prisma.plant.findUnique({
      where: { id: currentPlantId },
      select: { timezone: true },
    });
    const plantTimezone = String(plant?.timezone || DEFAULT_TIMEZONE);

    const resourcesRaw = String(req.query.resources || "executions");
    const resources = resourcesRaw
      .split(",")
      .map((x) => String(x || "").trim().toLowerCase())
      .filter(Boolean);

    const from = req.query.from ? toDateStart(req.query.from) : null;
    const to = req.query.to ? toDateEnd(req.query.to) : null;
    const days = req.query.days ? Number(req.query.days) : null;

    const dateFrom = from || (Number.isFinite(days) ? daysAgo(days) : null);
    const dateTo = to || new Date();

    const filename = await buildExportFilename({
      plantId: currentPlantId,
      resources,
      extension: "pdf",
      timezone: plantTimezone,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const doc = new PDFDocument({
      margin: 42,
      size: "A4",
      bufferPages: true,
    });
    doc.pipe(res);

    doc.fontSize(18).fillColor("#0f172a").text("LubriPlan - Exportación", {
      align: "center",
    });
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor("#64748b").text(
      `Fecha de generación: ${formatDateTimeInTimezone(new Date(), plantTimezone)}`,
      { align: "center" }
    );
    doc.moveDown(1);

    if (resources.includes("executions")) {
      const items = await getExecutionsExportData({ currentPlantId, dateFrom, dateTo, req, timezone: plantTimezone });
      addPdfSectionTitle(doc, "Actividades / Ejecuciones");
      addPdfRows(
        doc,
        ["ID", "Estado", "Actividad", "Equipo", "Captura", "Inventario", "Técnico", "Programada", "Condición"],
        items.map((x) => [
          x.id,
          x.estado,
          x.actividad,
          x.equipo,
          `${x.cantidadCaptura || ""} ${x.unidadCaptura || ""}`.trim(),
          `${x.cantidadInventario || ""} ${x.unidadInventario || ""}`.trim(),
          x.tecnico,
          x.programada,
          x.condicion,
        ])
      );
    }

    if (resources.includes("movements")) {
      const items = await getMovementsExportData({ currentPlantId, dateFrom, dateTo, req, timezone: plantTimezone });
      addPdfSectionTitle(doc, "Movimientos");
      addPdfRows(
        doc,
        ["ID", "Fecha", "Tipo", "Lubricante", "Inventario", "Captura", "Equipo"],
        items.map((x) => [
          x.id,
          x.fecha,
          x.tipo,
          x.lubricante,
          `${x.cantidad || ""} ${x.unidad || ""}`.trim(),
          `${x.cantidadCaptura || ""} ${x.unidadCaptura || ""}`.trim(),
          x.equipo,
        ])
      );
    }

    if (resources.includes("routes")) {
      const items = await getRoutesExportData({ currentPlantId, timezone: plantTimezone });
      addPdfSectionTitle(doc, "Rutas");
      addPdfRows(
        doc,
        ["ID", "Nombre", "Equipo", "Lubricante", "Cantidad", "Método", "Técnico"],
        items.map((x) => [
          x.id,
          x.nombre,
          x.equipo,
          x.lubricanteInventario || x.tipoLubricante,
          `${x.cantidad} ${x.unidad}`.trim(),
          x.metodo,
          x.tecnico,
        ])
      );
    }

    if (resources.includes("failures")) {
      const items = await getFailuresExportData({ currentPlantId, dateFrom, dateTo, req, timezone: plantTimezone });
      addPdfSectionTitle(doc, "Fallas");
      addPdfRows(
        doc,
        ["ID", "Fecha", "Condición", "Actividad", "Equipo", "Técnico"],
        items.map((x) => [
          x.id,
          x.fecha,
          x.condicion,
          x.actividad,
          x.equipo,
          x.tecnico,
        ])
      );
    }

    if (resources.includes("emergents")) {
      const items = await getEmergentsExportData({ currentPlantId });
      addPdfSectionTitle(doc, "Actividades emergentes");
      addPdfRows(
        doc,
        ["ID", "Nombre", "Equipo", "Técnico", "Lubricante", "Método"],
        items.map((x) => [
          x.id,
          x.nombre,
          x.equipo,
          x.tecnico,
          x.lubricante,
          x.metodo,
        ])
      );
    }

    if (resources.includes("condition_reports")) {
      const items = await getConditionReportsExportData({
        currentPlantId,
        dateFrom,
        dateTo,
        req,
        timezone: plantTimezone,
      });

      addPdfSectionTitle(doc, "Condición reportada");
      addPdfRows(
        doc,
        ["ID", "Fecha", "Equipo", "Condición", "Categoría", "Estado", "Reportado por"],
        items.map((x) => [
          x.id,
          x.fecha,
          x.equipo,
          x.condicion,
          x.categoria,
          x.estado,
          x.reportadoPor,
        ])
      );
    }

    doc.end();
  } catch (e) {
    console.error("GET /export/pdf error:", e);
    if (!res.headersSent) {
      return res.status(500).json({ error: e?.message || "Error generando PDF" });
    }
  }
});

export default router;



