// src/routes/export.js
// Exportación a Excel y PDF. Cada recurso se define una sola vez (columnas + consulta) y
// de ahí salen el Excel y el PDF, para que ambos tengan exactamente los mismos datos.
//
// Correcciones respecto a la versión anterior:
//  - Fechas del filtro y de las celdas en la hora de la planta (antes, UTC del servidor).
//  - Estado "Vencida" para las pendientes con fecha pasada (antes salían como PENDING).
//  - "Descontado de inventario" = movimiento real en la unidad del lubricante (antes, otra unidad).
//  - Fallas de actividades manuales/emergencias con su equipo (antes salían sin equipo).
//  - "Emergencias" solo incluye emergencias (antes mezclaba correctivas y manuales).
//  - Los filtros de reportes de condición se aplican (la pantalla mandaba otros nombres).
//  - Textos en español (estados, tipos de movimiento, motivos) y stock antes/después.
//  - Nuevos: equipos, inventario de lubricantes, técnicos y catálogo en formato de importación.

import express from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { logger } from "../config/logger.js";
import {
  DEFAULT_TZ,
  safeTimeZone,
  zonedStartOfDay,
  zonedEndOfDay,
  zonedYmd,
  zonedDateTimeLabel,
} from "../utils/tzRange.js";

const router = express.Router();
const managers = [requireAuth, requireRole(["ADMIN", "SUPERVISOR"])];
const MAX_ROWS = 50000;

/* ───────── Etiquetas ───────── */
const up = (v) => String(v || "").trim().toUpperCase();
const STATUS = { COMPLETED: "Completada", PENDING: "Pendiente", OVERDUE: "Vencida", IN_PROGRESS: "En proceso", CANCELLED: "Cancelada" };
const CONDITION = { BUENO: "Buena", REGULAR: "Regular", MALO: "Mala", CRITICO: "Crítica" };
const MOVE = { IN: "Entrada", OUT: "Salida", ADJUST: "Ajuste" };
const REASON = { EXECUTION: "Consumo por actividad", EMERGENCY: "Actividad de emergencia" };
const REPORT_STATUS = { OPEN: "Abierto", IN_PROGRESS: "En corrección", RESOLVED: "Resuelto", DISMISSED: "Descartado" };
const CATEGORY = { FUGA: "Fuga", RUIDO: "Ruido", VIBRACION: "Vibración", TEMPERATURA: "Temperatura", CONTAMINACION: "Contaminación", OTRO: "Otro" };
const CRIT = { CRITICA: "Crítica", ALTA: "Alta", MEDIA: "Media", BAJA: "Baja" };
const critLabel = (c) => CRIT[up(c).normalize("NFD").replace(/[̀-ͯ]/g, "")] || c || "";
const isEmergency = (x) => /^EMERGENTE\b/i.test(String(x?.manualTitle || ""));

function originLabel(x) {
  if (String(x.sourceType || "").toUpperCase() === "OLP") return "Orden preventiva";
  if (x.routeId) return "Ruta";
  if (isEmergency(x)) return "Emergencia";
  if (/^Correctiva\b/i.test(String(x.manualTitle || ""))) return "Correctiva";
  return "Manual";
}

/* ───────── Contexto de la petición ───────── */
async function buildContext(req) {
  const plantId = req.currentPlantId;
  const plant = await prisma.plant.findFirst({ where: { id: plantId }, select: { name: true, timezone: true } });
  const tz = safeTimeZone(plant?.timezone || DEFAULT_TZ);
  const today = zonedYmd(new Date(), tz);

  const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "").slice(0, 10)) ? String(v).slice(0, 10) : null);
  let fromYmd = ymd(req.query.from);
  let toYmd = ymd(req.query.to);
  if (!fromYmd && req.query.days) {
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 0, 1), 3650);
    fromYmd = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  }
  if (!toYmd) toYmd = today;
  if (fromYmd && fromYmd > toYmd) {
    const e = new Error("La fecha 'desde' es posterior a 'hasta'");
    e.status = 400;
    throw e;
  }
  const q = (k, ...alts) => [k, ...alts].map((x) => req.query[x]).find((v) => v != null && String(v).trim() !== "");
  return {
    plantId,
    plantName: plant?.name || "",
    tz,
    today,
    fromYmd,
    toYmd,
    from: fromYmd ? zonedStartOfDay(fromYmd, tz) : null,
    to: zonedEndOfDay(toYmd, tz),
    q,
    dt: (v) => (v ? zonedDateTimeLabel(v, tz) : ""),
    d: (v) => (v ? zonedYmd(v, tz) : ""),
  };
}

const range = (ctx) => ({ ...(ctx.from ? { gte: ctx.from } : {}), ...(ctx.to ? { lte: ctx.to } : {}) });
const eqOf = (x) => x.route?.equipment || x.equipment || null;

/* ───────── Recursos ───────── */
// columns: [encabezado, clave, ancho (Excel), ancho relativo (PDF)]
export const RESOURCES = {
  executions: {
    label: "Actividades",
    sheet: "Actividades",
    dated: true,
    columns: [
      ["Folio", "id", 8, 0.6], ["Estado", "estado", 12, 1], ["Origen", "origen", 14, 1], ["Actividad", "actividad", 34, 2.4],
      ["Equipo", "equipo", 26, 1.8], ["Código", "codigo", 14, 1], ["Técnico", "tecnico", 20, 1.4], ["Programada", "programada", 12, 1],
      ["Ejecutada", "ejecutada", 17, 1.2], ["Días de retraso", "retraso", 10, 0.7], ["Lubricante", "lubricante", 24, 1.6],
      ["Cantidad registrada", "cantidad", 12, 0.8], ["Unidad", "unidad", 9, 0.6], ["Descontado inventario", "descontado", 12, 0.9],
      ["Unidad inventario", "unidadInv", 10, 0.6], ["Condición", "condicion", 10, 0.8], ["Observaciones", "observaciones", 40, 2.4],
    ],
    async load(ctx) {
      const status = up(ctx.q("status"));
      const techId = Number(ctx.q("techId", "technicianId"));
      const where = {
        plantId: ctx.plantId,
        OR: [{ scheduledAt: range(ctx) }, { executedAt: range(ctx) }],
        ...(Number.isInteger(techId) && techId > 0 ? { technicianId: techId } : {}),
      };
      // "Vencida" no siempre está guardado como estado: es pendiente con fecha anterior a hoy.
      const todayStart = zonedStartOfDay(ctx.today, ctx.tz);
      if (status === "COMPLETED") where.status = "COMPLETED";
      else if (status === "OVERDUE") Object.assign(where, { status: { in: ["PENDING", "OVERDUE"] }, scheduledAt: { ...range(ctx), lt: todayStart } });
      else if (status === "PENDING") Object.assign(where, { status: { in: ["PENDING", "OVERDUE"] }, scheduledAt: { gte: todayStart, ...(ctx.to ? { lte: ctx.to } : {}) } });

      const items = await prisma.execution.findMany({
        where,
        orderBy: [{ scheduledAt: "desc" }, { id: "desc" }],
        take: MAX_ROWS,
        include: {
          route: { select: { name: true, unit: true, equipment: { select: { name: true, code: true } }, lubricant: { select: { name: true, unit: true } } } },
          equipment: { select: { name: true, code: true } },
          technician: { select: { name: true } },
          lubricantMovements: { where: { type: "OUT" }, orderBy: { createdAt: "desc" }, take: 1, select: { quantity: true, lubricant: { select: { name: true, unit: true } } } },
        },
      });
      return items.map((x) => {
        const mv = x.lubricantMovements?.[0] || null;
        const done = up(x.status) === "COMPLETED";
        const sd = ctx.d(x.scheduledAt);
        const ed = done ? ctx.d(x.executedAt) : "";
        const late = done && sd && ed ? Math.round((Date.parse(`${ed}T00:00:00Z`) - Date.parse(`${sd}T00:00:00Z`)) / 86400000) : null;
        const estado = done ? STATUS.COMPLETED : sd && sd < ctx.today ? STATUS.OVERDUE : STATUS[up(x.status)] || x.status;
        return {
          id: x.id,
          estado,
          origen: originLabel(x),
          actividad: x.route?.name || x.manualTitle || "",
          equipo: eqOf(x)?.name || "",
          codigo: eqOf(x)?.code || "",
          tecnico: x.technician?.name || "",
          programada: sd,
          ejecutada: done ? ctx.dt(x.executedAt) : "",
          retraso: late != null ? Math.max(0, late) : "",
          lubricante: mv?.lubricant?.name || x.route?.lubricant?.name || "",
          cantidad: x.usedInputQuantity ?? x.usedQuantity ?? "",
          unidad: x.usedInputUnit || x.route?.unit || "",
          descontado: mv ? mv.quantity : "",
          unidadInv: mv ? mv.lubricant?.unit || "" : "",
          condicion: CONDITION[up(x.condition)] || x.condition || "",
          observaciones: x.observations || "",
        };
      });
    },
  },

  movements: {
    label: "Movimientos de inventario",
    sheet: "Movimientos",
    dated: true,
    columns: [
      ["Folio", "id", 8, 0.6], ["Fecha", "fecha", 17, 1.2], ["Tipo", "tipo", 10, 0.8], ["Lubricante", "lubricante", 28, 2], ["Código", "codigo", 12, 0.9],
      ["Cantidad", "cantidad", 10, 0.8], ["Unidad", "unidad", 8, 0.6], ["Stock antes", "antes", 10, 0.8], ["Stock después", "despues", 10, 0.8],
      ["Motivo", "motivo", 24, 1.6], ["Nota", "nota", 30, 2], ["Actividad (folio)", "actividadId", 10, 0.7], ["Actividad", "actividad", 30, 2],
      ["Equipo", "equipo", 24, 1.6], ["Técnico", "tecnico", 20, 1.3],
    ],
    async load(ctx) {
      const type = up(ctx.q("type"));
      const items = await prisma.lubricantMovement.findMany({
        where: {
          AND: [
            { OR: [{ lubricant: { plantId: ctx.plantId } }, { execution: { is: { plantId: ctx.plantId } } }] },
            { createdAt: range(ctx) },
            ...(MOVE[type] ? [{ type }] : []),
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MAX_ROWS,
        include: {
          lubricant: { select: { name: true, code: true, unit: true } },
          execution: {
            select: {
              id: true,
              manualTitle: true,
              technician: { select: { name: true } },
              equipment: { select: { name: true, code: true } },
              route: { select: { name: true, equipment: { select: { name: true, code: true } } } },
            },
          },
        },
      });
      return items.map((m) => ({
        id: m.id,
        fecha: ctx.dt(m.createdAt),
        tipo: MOVE[up(m.type)] || m.type,
        lubricante: m.lubricant?.name || "",
        codigo: m.lubricant?.code || "",
        cantidad: m.quantity,
        unidad: m.lubricant?.unit || "",
        antes: m.stockBefore ?? "",
        despues: m.stockAfter ?? "",
        motivo: REASON[up(m.reason)] || m.reason || "",
        nota: m.note || "",
        actividadId: m.execution?.id || "",
        actividad: m.execution ? m.execution.route?.name || m.execution.manualTitle || "" : "",
        equipo: m.execution ? eqOf(m.execution)?.name || "" : "",
        tecnico: m.execution?.technician?.name || "",
      }));
    },
  },

  routes: {
    label: "Rutas",
    sheet: "Rutas",
    columns: [
      ["ID", "id", 7, 0.5], ["Ruta", "nombre", 34, 2.2], ["Equipo", "equipo", 26, 1.8], ["Código equipo", "codigo", 14, 1], ["Lubricante", "lubricante", 26, 1.8],
      ["Cantidad", "cantidad", 10, 0.7], ["Unidad", "unidad", 10, 0.7], ["Puntos", "puntos", 8, 0.5], ["Método", "metodo", 16, 1], ["Frecuencia (días)", "frecuencia", 10, 0.8],
      ["Técnico", "tecnico", 20, 1.3], ["Última", "ultima", 12, 0.9], ["Próxima", "proxima", 12, 0.9],
    ],
    async load(ctx) {
      const items = await prisma.route.findMany({
        where: { plantId: ctx.plantId },
        orderBy: [{ equipment: { name: "asc" } }, { name: "asc" }],
        take: MAX_ROWS,
        include: { equipment: { select: { name: true, code: true } }, lubricant: { select: { name: true } }, technician: { select: { name: true } } },
      });
      return items.map((r) => ({
        id: r.id,
        nombre: r.name,
        equipo: r.equipment?.name || "",
        codigo: r.equipment?.code || "",
        lubricante: r.lubricant?.name || r.lubricantName || r.lubricantType || "",
        cantidad: r.quantity ?? "",
        unidad: r.unit === "BOMBAZOS" && r.pumpStrokeValue ? `bombazos (${r.pumpStrokeValue} ${r.pumpStrokeUnit || ""})` : r.unit || "",
        puntos: r.points ?? "",
        metodo: r.method || "",
        frecuencia: r.frequencyDays ?? "",
        tecnico: r.technician?.name || "",
        ultima: ctx.d(r.lastDate),
        proxima: ctx.d(r.nextDate),
      }));
    },
  },

  failures: {
    label: "Hallazgos (condición mala o crítica)",
    sheet: "Hallazgos",
    dated: true,
    columns: [
      ["Folio", "id", 8, 0.6], ["Fecha", "fecha", 17, 1.2], ["Condición", "condicion", 10, 0.8], ["Actividad", "actividad", 34, 2.4],
      ["Equipo", "equipo", 26, 1.8], ["Código", "codigo", 14, 1], ["Criticidad", "criticidad", 10, 0.8], ["Técnico", "tecnico", 20, 1.3], ["Observaciones", "observaciones", 44, 3],
    ],
    async load(ctx) {
      const sev = up(ctx.q("severity"));
      const items = await prisma.execution.findMany({
        where: {
          plantId: ctx.plantId,
          status: "COMPLETED",
          executedAt: range(ctx),
          condition: sev === "MALO" || sev === "CRITICO" ? sev : { in: ["MALO", "CRITICO"] },
        },
        orderBy: { executedAt: "desc" },
        take: MAX_ROWS,
        include: {
          route: { select: { name: true, equipment: { select: { name: true, code: true, criticality: true } } } },
          equipment: { select: { name: true, code: true, criticality: true } },
          technician: { select: { name: true } },
        },
      });
      return items.map((x) => ({
        id: x.id,
        fecha: ctx.dt(x.executedAt),
        condicion: CONDITION[up(x.condition)] || x.condition,
        actividad: x.route?.name || x.manualTitle || "",
        equipo: eqOf(x)?.name || "",
        codigo: eqOf(x)?.code || "",
        criticidad: critLabel(eqOf(x)?.criticality),
        tecnico: x.technician?.name || "",
        observaciones: x.observations || "",
      }));
    },
  },

  emergents: {
    label: "Emergencias",
    sheet: "Emergencias",
    dated: true,
    columns: [
      ["Folio", "id", 8, 0.6], ["Fecha", "fecha", 17, 1.2], ["Actividad", "actividad", 40, 2.6], ["Equipo", "equipo", 26, 1.8], ["Código", "codigo", 14, 1],
      ["Técnico", "tecnico", 20, 1.3], ["Lubricante", "lubricante", 24, 1.6], ["Cantidad", "cantidad", 10, 0.7], ["Unidad", "unidad", 8, 0.6],
      ["Condición", "condicion", 10, 0.8], ["Observaciones", "observaciones", 40, 2.4],
    ],
    async load(ctx) {
      const items = await prisma.execution.findMany({
        where: { plantId: ctx.plantId, routeId: null, manualTitle: { startsWith: "EMERGENTE" }, OR: [{ executedAt: range(ctx) }, { scheduledAt: range(ctx) }] },
        orderBy: [{ executedAt: "desc" }, { scheduledAt: "desc" }],
        take: MAX_ROWS,
        include: {
          equipment: { select: { name: true, code: true } },
          technician: { select: { name: true } },
          lubricantMovements: { where: { type: "OUT" }, take: 1, select: { quantity: true, lubricant: { select: { name: true, unit: true } } } },
        },
      });
      return items.map((x) => {
        const mv = x.lubricantMovements?.[0] || null;
        return {
          id: x.id,
          fecha: ctx.dt(x.executedAt || x.scheduledAt),
          actividad: x.manualTitle || "",
          equipo: x.equipment?.name || "",
          codigo: x.equipment?.code || "",
          tecnico: x.technician?.name || "",
          lubricante: mv?.lubricant?.name || "",
          cantidad: mv ? mv.quantity : x.usedInputQuantity ?? "",
          unidad: mv ? mv.lubricant?.unit || "" : x.usedInputUnit || "",
          condicion: CONDITION[up(x.condition)] || x.condition || "",
          observaciones: x.observations || "",
        };
      });
    },
  },

  condition_reports: {
    label: "Reportes de condición",
    sheet: "Reportes de condición",
    dated: true,
    columns: [
      ["Folio", "id", 8, 0.6], ["Detectado", "detectado", 11, 0.8], ["Registrado", "fecha", 17, 1.1], ["Equipo", "equipo", 26, 1.7], ["Código", "codigo", 14, 1], ["Condición", "condicion", 10, 0.8],
      ["Categoría", "categoria", 13, 0.9], ["Descripción", "descripcion", 44, 3], ["Estado", "estado", 13, 0.9], ["Reportado por", "reporto", 20, 1.3],
      ["Evidencia", "evidencia", 9, 0.6], ["Descartado por", "descarto", 20, 1.2], ["Actividad correctiva", "correctiva", 10, 0.8], ["Resuelto", "resuelto", 17, 1.1],
    ],
    async load(ctx) {
      const status = up(ctx.q("reportStatus", "status"));
      const condition = up(ctx.q("reportCondition", "condition"));
      const category = up(ctx.q("reportCategory", "category"));
      const items = await prisma.conditionReport.findMany({
        where: {
          plantId: ctx.plantId,
          createdAt: range(ctx),
          ...(REPORT_STATUS[status] ? { status } : {}),
          ...(CONDITION[condition] ? { condition } : {}),
          ...(CATEGORY[category] ? { category } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: MAX_ROWS,
        include: {
          equipment: { select: { name: true, code: true } },
          reportedBy: { select: { name: true } },
          dismissedBy: { select: { name: true } },
          correctiveExecution: { select: { id: true } },
        },
      });
      return items.map((r) => ({
        id: r.id,
        // detectedAt es solo fecha (sin hora): se muestra tal cual, sin convertir de zona.
        detectado: r.detectedAt ? new Date(r.detectedAt).toISOString().slice(0, 10) : "",
        fecha: ctx.dt(r.createdAt),
        equipo: r.equipment?.name || "",
        codigo: r.equipment?.code || "",
        condicion: CONDITION[up(r.condition)] || r.condition || "",
        categoria: CATEGORY[up(r.category)] || r.category || "",
        descripcion: r.description || "",
        estado: REPORT_STATUS[up(r.status)] || r.status,
        reporto: r.reportedBy?.name || "",
        evidencia: r.evidenceImage ? "Sí" : "No",
        descarto: r.dismissedBy?.name || "",
        correctiva: r.correctiveExecution?.id || "",
        resuelto: ctx.dt(r.resolvedAt),
      }));
    },
  },

  equipment: {
    label: "Equipos",
    sheet: "Equipos",
    columns: [
      ["ID", "id", 7, 0.5], ["Código", "codigo", 14, 1], ["Equipo", "nombre", 30, 2.2], ["Área", "area", 18, 1.2], ["Ubicación", "ubicacion", 20, 1.3],
      ["Criticidad", "criticidad", 10, 0.8], ["Estado", "estado", 10, 0.8], ["Marca", "marca", 14, 1], ["Modelo", "modelo", 14, 1], ["Rutas", "rutas", 7, 0.5], ["Descripción", "descripcion", 36, 2.4],
    ],
    async load(ctx) {
      const items = await prisma.equipment.findMany({
        where: { plantId: ctx.plantId },
        orderBy: [{ area: { name: "asc" } }, { name: "asc" }],
        take: MAX_ROWS,
        include: { area: { select: { name: true } }, _count: { select: { routes: true } } },
      });
      return items.map((e) => ({
        id: e.id,
        codigo: e.code || "",
        nombre: e.name,
        area: e.area?.name || "",
        ubicacion: e.location || "",
        criticidad: critLabel(e.criticality),
        estado: up(e.status) === "INACTIVO" ? "Inactivo" : "Activo",
        marca: e.brand || "",
        modelo: e.model || "",
        rutas: e._count?.routes ?? 0,
        descripcion: e.description || "",
      }));
    },
  },

  lubricants: {
    label: "Inventario de lubricantes",
    sheet: "Inventario",
    columns: [
      ["ID", "id", 7, 0.5], ["Código", "codigo", 12, 0.9], ["Lubricante", "nombre", 30, 2.2], ["Tipo", "tipo", 18, 1.2], ["Marca", "marca", 14, 1],
      ["Viscosidad", "viscosidad", 10, 0.7], ["Unidad", "unidad", 8, 0.6], ["Stock", "stock", 10, 0.8], ["Mínimo", "minimo", 10, 0.8], ["Estado", "estado", 11, 0.8],
      ["Costo unitario", "costo", 11, 0.9], ["Valor en stock", "valor", 12, 1], ["Ubicación", "ubicacion", 16, 1.1],
    ],
    async load(ctx) {
      const items = await prisma.lubricant.findMany({ where: { plantId: ctx.plantId }, orderBy: { name: "asc" }, take: MAX_ROWS });
      return items.map((l) => {
        const stock = Number(l.stock || 0);
        const min = l.minStock == null ? null : Number(l.minStock);
        return {
          id: l.id,
          codigo: l.code || "",
          nombre: l.name,
          tipo: l.type || "",
          marca: l.brand || "",
          viscosidad: l.viscosity || "",
          unidad: l.unit || "",
          stock: Math.round(stock * 100) / 100,
          minimo: min ?? "",
          estado: stock <= 0 ? "Agotado" : min != null && stock <= min ? "Bajo" : "OK",
          costo: l.unitCost ?? "",
          valor: l.unitCost != null ? Math.round(stock * Number(l.unitCost) * 100) / 100 : "",
          ubicacion: l.location || "",
        };
      });
    },
  },

  technicians: {
    label: "Técnicos",
    sheet: "Técnicos",
    columns: [
      ["ID", "id", 7, 0.5], ["Código", "codigo", 12, 0.9], ["Nombre", "nombre", 28, 2], ["Especialidad", "especialidad", 22, 1.5], ["Estado", "estado", 10, 0.8],
      ["Correo", "correo", 26, 1.8], ["Teléfono", "telefono", 14, 1], ["Rutas", "rutas", 7, 0.5], ["Acceso a la app", "acceso", 10, 0.8],
    ],
    async load(ctx) {
      const items = await prisma.technician.findMany({
        where: { plantId: ctx.plantId, deletedAt: null },
        orderBy: { name: "asc" },
        take: MAX_ROWS,
        include: { _count: { select: { routes: true } }, user: { select: { id: true, active: true } } },
      });
      return items.map((t) => ({
        id: t.id,
        codigo: t.code,
        nombre: t.name,
        especialidad: t.specialty || "",
        estado: t.status || "",
        correo: t.email || "",
        telefono: t.phone || "",
        rutas: t._count?.routes ?? 0,
        acceso: t.user?.active ? "Sí" : "No",
      }));
    },
  },
};

function parseResources(req) {
  const list = String(req.query.resources || "executions")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => RESOURCES[x]);
  return [...new Set(list)];
}

function fileStamp(ctx, resources) {
  const slug = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const what = resources.length === 1 ? slug(RESOURCES[resources[0]].label) : "reporte-consolidado";
  return `lubriplan_${slug(ctx.plantName) || "planta"}_${what}_${ctx.today}`;
}

const periodText = (ctx) => (ctx.fromYmd ? `${ctx.fromYmd} a ${ctx.toYmd}` : `hasta ${ctx.toYmd}`);

/* ───────── Excel ───────── */
function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.height = 20;
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  if (ws.columnCount) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

async function buildWorkbook(ctx, resources) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "LubriPlan";
  wb.created = new Date();

  const info = wb.addWorksheet("Información");
  info.columns = [{ width: 24 }, { width: 60 }];
  info.addRows([
    ["Planta", ctx.plantName],
    ["Generado", zonedDateTimeLabel(new Date(), ctx.tz)],
    ["Periodo", periodText(ctx)],
    ["Zona horaria", ctx.tz],
  ]);
  info.getColumn(1).font = { bold: true };

  for (const key of resources) {
    const def = RESOURCES[key];
    const rows = await def.load(ctx);
    info.addRow([def.label, `${rows.length} registro${rows.length === 1 ? "" : "s"}${def.dated ? "" : " (estado actual, sin filtro de fechas)"}`]);
    const ws = wb.addWorksheet(def.sheet.slice(0, 31));
    ws.columns = def.columns.map(([header, k, width]) => ({ header, key: k, width }));
    for (const r of rows) ws.addRow(r);
    styleHeader(ws);
  }
  return wb;
}

/* ───────── PDF (tabla) ───────── */
function drawTable(doc, def, rows) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totalRel = def.columns.reduce((s, c) => s + c[3], 0);
  const widths = def.columns.map((c) => (c[3] / totalRel) * width);
  const bottom = doc.page.height - doc.page.margins.bottom;
  const font = 6.5;

  const header = () => {
    let x = left;
    const y = doc.y;
    doc.rect(left, y, width, 14).fill("#1f2937");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(font);
    def.columns.forEach((c, i) => {
      doc.text(c[0], x + 2, y + 4, { width: widths[i] - 4, height: 10, ellipsis: true, lineBreak: false });
      x += widths[i];
    });
    doc.y = y + 15;
    doc.font("Helvetica").fillColor("#111827");
  };

  header();
  rows.forEach((r, idx) => {
    const cells = def.columns.map((c) => String(r[c[1]] ?? ""));
    const h = Math.min(
      40,
      Math.max(...cells.map((t, i) => doc.fontSize(font).heightOfString(t, { width: widths[i] - 4 }))) + 4
    );
    if (doc.y + h > bottom) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    if (idx % 2) doc.rect(left, y, width, h).fill("#f3f4f6").fillColor("#111827");
    let x = left;
    cells.forEach((t, i) => {
      doc.fontSize(font).text(t, x + 2, y + 2, { width: widths[i] - 4, height: h - 2, ellipsis: true });
      x += widths[i];
    });
    doc.y = y + h;
  });
  if (!rows.length) doc.fontSize(8).fillColor("#6b7280").text("Sin registros en el periodo.", left, doc.y + 4);
  doc.moveDown(1);
}

/* ───────── Rutas HTTP ───────── */
function sendError(res, e, label) {
  if (e?.status === 400) return res.status(400).json({ error: e.message });
  logger.error(label, e);
  return res.status(500).json({ error: "No se pudo generar la exportación" });
}

router.get("/xlsx", ...managers, async (req, res) => {
  try {
    if (!req.currentPlantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
    const ctx = await buildContext(req);
    const resources = parseResources(req);
    if (!resources.length) return res.status(400).json({ error: "Selecciona qué exportar" });
    const wb = await buildWorkbook(ctx, resources);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileStamp(ctx, resources)}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  } catch (e) {
    return sendError(res, e, "GET /export/xlsx");
  }
});

router.get("/pdf", ...managers, async (req, res) => {
  try {
    if (!req.currentPlantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
    const ctx = await buildContext(req);
    const resources = parseResources(req);
    if (!resources.length) return res.status(400).json({ error: "Selecciona qué exportar" });

    const data = [];
    for (const key of resources) data.push([RESOURCES[key], await RESOURCES[key].load(ctx)]);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileStamp(ctx, resources)}.pdf"`);
    const doc = new PDFDocument({ size: "LETTER", layout: "landscape", margin: 28 });
    doc.pipe(res);
    doc.font("Helvetica-Bold").fontSize(15).fillColor("#111827").text(`LubriPlan · ${ctx.plantName}`);
    doc.font("Helvetica").fontSize(9).fillColor("#4b5563").text(`Periodo: ${periodText(ctx)} · Generado ${zonedDateTimeLabel(new Date(), ctx.tz)} (${ctx.tz})`);
    doc.moveDown(0.8);
    data.forEach(([def, rows], i) => {
      if (i > 0) doc.addPage();
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111827").text(`${def.label} · ${rows.length} registro${rows.length === 1 ? "" : "s"}`);
      doc.moveDown(0.3);
      drawTable(doc, def, rows.slice(0, 5000));
      if (rows.length > 5000) doc.fontSize(8).fillColor("#b45309").text(`Se muestran 5,000 de ${rows.length}. Usa Excel para el listado completo.`);
    });
    doc.end();
    return undefined;
  } catch (e) {
    if (res.headersSent) {
      logger.error("GET /export/pdf (stream)", e);
      return res.end();
    }
    return sendError(res, e, "GET /export/pdf");
  }
});

/**
 * Catálogo de la planta en el MISMO formato de la plantilla de importación.
 * Sirve como respaldo y para copiar equipos, lubricantes, técnicos y rutas a otra planta.
 */
router.get("/catalog", ...managers, async (req, res) => {
  try {
    if (!req.currentPlantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
    const ctx = await buildContext(req);
    const [equipments, lubricants, technicians, routes] = await Promise.all([
      prisma.equipment.findMany({ where: { plantId: ctx.plantId }, orderBy: { code: "asc" }, include: { area: { select: { name: true } } } }),
      prisma.lubricant.findMany({ where: { plantId: ctx.plantId }, orderBy: { code: "asc" } }),
      prisma.technician.findMany({ where: { plantId: ctx.plantId, deletedAt: null }, orderBy: { code: "asc" } }),
      prisma.route.findMany({
        where: { plantId: ctx.plantId },
        include: { equipment: { select: { code: true } }, lubricant: { select: { code: true } }, technician: { select: { code: true } } },
        orderBy: { id: "asc" },
      }),
    ]);
    const { buildTemplateWorkbook } = await import("./import.js");
    const wb = buildTemplateWorkbook({
      equipos: equipments.map((e) => [e.code || "", e.name, e.area?.name || "", e.location || "", up(e.status) === "INACTIVO" ? "Inactivo" : "Activo", critLabel(e.criticality), e.description || "", e.brand || "", e.model || ""]),
      lubricantes: lubricants.map((l) => [l.code || "", l.name, /grasa/i.test(`${l.type} ${l.name}`) ? "Grasa" : "Aceite", l.viscosity || "", l.unit || "", l.stock, l.minStock ?? "", l.brand || "", l.unitCost ?? ""]),
      tecnicos: technicians.map((t) => [t.name, t.code, t.specialty || "", t.status || "Activo"]),
      rutas: routes.map((r) => [
        r.equipment?.code || "",
        r.name,
        r.frequencyDays,
        r.lubricant?.code || "",
        r.quantity ?? "",
        r.unit === "BOMBAZOS" ? "BOMBAZOS" : r.unit || "",
        r.unit === "BOMBAZOS" ? r.pumpStrokeValue ?? "" : "",
        r.unit === "BOMBAZOS" ? r.pumpStrokeUnit || "" : "",
        r.technician?.code || "",
        r.points ?? "",
        r.method || "",
        ctx.d(r.lastDate),
        r.instructions || "",
      ]),
    });
    const warnings = [
      equipments.some((e) => !e.code) ? "Hay equipos sin código: sus rutas no se pueden importar en otra planta hasta asignarles código." : null,
      lubricants.some((l) => !l.code) ? "Hay lubricantes sin código: asígnales uno antes de importar sus rutas." : null,
    ].filter(Boolean);
    if (warnings.length) {
      const ws = wb.getWorksheet("instrucciones");
      for (const w of warnings) ws.addRow(["Aviso", w]);
    }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileStamp(ctx, [])}_catalogo.xlsx"`.replace("reporte-consolidado_", ""));
    await wb.xlsx.write(res);
    return res.end();
  } catch (e) {
    return sendError(res, e, "GET /export/catalog");
  }
});

export default router;
