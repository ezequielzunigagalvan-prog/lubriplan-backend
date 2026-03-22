import express from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = express.Router();

function toDateStart(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDateEnd(v) {
  if (!v) return null;
  const d = new Date(v);
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

async function getExecutionsExportData({ currentPlantId, dateFrom, dateTo, req }) {
  const where = {
    plantId: currentPlantId,
    ...(dateFrom || dateTo
      ? {
          scheduledAt: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
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
      programada: x.scheduledAt ? new Date(x.scheduledAt).toLocaleString("es-MX") : "",
      ejecutada: x.executedAt ? new Date(x.executedAt).toLocaleString("es-MX") : "",
      condicion: x.condition || "",
      observaciones: x.observations || "",
    };
  });
}
async function getMovementsExportData({ currentPlantId, dateFrom, dateTo, req }) {
  const where = {
    ...(dateFrom || dateTo
      ? {
          createdAt: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
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
    fecha: x.createdAt ? new Date(x.createdAt).toLocaleString("es-MX") : "",
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

async function getRoutesExportData({ currentPlantId }) {
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
    ultimaFecha: x.lastDate ? new Date(x.lastDate).toLocaleDateString("es-MX") : "",
    proximaFecha: x.nextDate ? new Date(x.nextDate).toLocaleDateString("es-MX") : "",
  }));
}

async function getFailuresExportData({ currentPlantId, dateFrom, dateTo, req }) {
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
    fecha: x.executedAt ? new Date(x.executedAt).toLocaleString("es-MX") : "",
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
    fecha: x.createdAt ? new Date(x.createdAt).toLocaleString("es-MX") : "",
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
      const items = await getExecutionsExportData({ currentPlantId, dateFrom, dateTo, req });
      const ws = workbook.addWorksheet("Ejecuciones");

      addHeaderRow(ws, [
        "ID",
        "Estado",
        "Origen",
        "Actividad",
        "Equipo",
        "TAG/Codigo",
        "Lubricante",
        "Cantidad captura",
        "Unidad captura",
        "Cantidad inventario",
        "Unidad inventario",
        "Tecnico",
        "Programada",
        "Ejecutada",
        "Condicion",
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
      const items = await getMovementsExportData({ currentPlantId, dateFrom, dateTo, req });
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
        "Ejecucion",
        "Ruta",
        "Equipo",
        "Tecnico",
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
      const items = await getRoutesExportData({ currentPlantId });
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
      const items = await getFailuresExportData({ currentPlantId, dateFrom, dateTo, req });
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

    const filename = `lubriplan_export_${new Date().toISOString().slice(0, 10)}.xlsx`;

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

    const filename = `lubriplan_export_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const doc = new PDFDocument({
      margin: 42,
      size: "A4",
      bufferPages: true,
    });
    doc.pipe(res);

    doc.fontSize(18).fillColor("#0f172a").text("LubriPlan - Exportacion", {
      align: "center",
    });
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor("#64748b").text(
      `Fecha de generacion: ${new Date().toLocaleString("es-MX")}`,
      { align: "center" }
    );
    doc.moveDown(1);

    if (resources.includes("executions")) {
      const items = await getExecutionsExportData({ currentPlantId, dateFrom, dateTo, req });
      addPdfSectionTitle(doc, "Actividades / Ejecuciones");
      addPdfRows(
        doc,
        ["ID", "Estado", "Actividad", "Equipo", "Captura", "Inventario", "Tecnico", "Programada", "Condicion"],
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
      const items = await getMovementsExportData({ currentPlantId, dateFrom, dateTo, req });
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
      const items = await getRoutesExportData({ currentPlantId });
      addPdfSectionTitle(doc, "Rutas");
      addPdfRows(
        doc,
        ["ID", "Nombre", "Equipo", "Lubricante", "Cantidad", "Metodo", "Tecnico"],
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
      const items = await getFailuresExportData({ currentPlantId, dateFrom, dateTo, req });
      addPdfSectionTitle(doc, "Fallas");
      addPdfRows(
        doc,
        ["ID", "Fecha", "Condicion", "Actividad", "Equipo", "Tecnico"],
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
        ["ID", "Nombre", "Equipo", "Tecnico", "Lubricante", "Metodo"],
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
      });

      addPdfSectionTitle(doc, "Condicion reportada");
      addPdfRows(
        doc,
        ["ID", "Fecha", "Equipo", "Condicion", "Categoria", "Estado", "Reportado por"],
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


