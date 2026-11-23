// src/routes/history.routes.js
// Historial (auditoría): actividades completadas y movimientos de inventario.
//
// Antes vivía en index.js. Correcciones respecto a esa versión:
//  - Los rangos de fecha se calculan en la zona horaria de la planta (el servidor corre en UTC
//    y las actividades de la tarde caían en el día o mes siguiente).
//  - Las actividades manuales y de emergencia traen su equipo (antes salían "sin equipo").
//  - Los totales por condición cubren todo el rango, no solo la página visible.
//  - Filtros en el servidor: técnico, equipo, con evidencia; ya no se filtra en el navegador.
//  - Exportación CSV para auditoría con los mismos filtros.

import { Router } from "express";
import { logger } from "../config/logger.js";
import {
  DEFAULT_TZ,
  safeTimeZone,
  zonedStartOfDay,
  zonedEndOfDay,
  zonedMonthRange,
  zonedDateTimeLabel,
  zonedDayDiff,
} from "../utils/tzRange.js";

const CONDITIONS = new Set(["BUENO", "REGULAR", "MALO", "CRITICO"]);
const MOVE_TYPES = new Set(["IN", "OUT", "ADJUST"]);
const EXPORT_LIMIT = 10000;

const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const ci = (q) => ({ contains: q, mode: "insensitive" });

function pageParams(query, maxSize = 200) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(Math.max(1, Number.parseInt(query.pageSize, 10) || 20), maxSize);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

async function plantTimeZone(prisma, plantId) {
  try {
    const plant = await prisma.plant.findFirst({ where: { id: plantId }, select: { timezone: true } });
    return safeTimeZone(plant?.timezone || DEFAULT_TZ);
  } catch {
    return DEFAULT_TZ;
  }
}

/** Rango de fechas (from/to YYYY-MM-DD o month YYYY-MM) en la zona de la planta. */
export function resolveRange(query, tz) {
  const fromStr = String(query.from || "").trim();
  const toStr = String(query.to || "").trim();
  const monthStr = String(query.month || "").trim();

  let from = fromStr ? zonedStartOfDay(fromStr, tz) : null;
  let to = toStr ? zonedEndOfDay(toStr, tz) : null;
  if (fromStr && !from) return { error: "Fecha 'desde' inválida" };
  if (toStr && !to) return { error: "Fecha 'hasta' inválida" };

  if (!fromStr && !toStr && monthStr) {
    const r = zonedMonthRange(monthStr, tz);
    if (!r) return { error: "Mes inválido" };
    ({ from, to } = r);
  }
  if (from && to && from > to) return { error: "La fecha 'desde' es posterior a 'hasta'" };
  return { from, to };
}

function technicianScope(req) {
  const role = String(req.user?.role || "").toUpperCase();
  if (role !== "TECHNICIAN") return null;
  const id = req.user?.technicianId != null ? Number(req.user.technicianId) : NaN;
  return Number.isFinite(id) ? id : -1; // sin técnico vinculado no ve nada
}

/* ─────────── Actividades ─────────── */

/**
 * where de actividades completadas.
 * `withCondition: false` deja fuera el filtro de condición (para los totales por condición).
 */
export function buildExecutionsWhere({ plantId, query, range, techScope, withCondition = true }) {
  const and = [{ plantId }, { status: "COMPLETED" }];

  if (range.from || range.to) {
    and.push({
      executedAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) },
    });
  }

  if (techScope != null) and.push({ technicianId: techScope });
  else {
    const techId = toId(query.technicianId);
    if (techId) and.push({ technicianId: techId });
  }

  const equipmentId = toId(query.equipmentId);
  if (equipmentId) and.push({ OR: [{ equipmentId }, { route: { is: { equipmentId } } }] });

  if (String(query.evidence || "") === "1") and.push({ evidenceImage: { not: null } }, { NOT: { evidenceImage: "" } });

  if (withCondition) {
    const condition = String(query.condition || "").toUpperCase().trim();
    if (CONDITIONS.has(condition)) and.push({ condition });
    else if (String(query.filter || "").toLowerCase() === "bad-condition") {
      and.push({ condition: { in: ["MALO", "CRITICO"] } });
    }
  }

  const q = String(query.q || "").trim();
  if (q) {
    const asId = /^#?\d+$/.test(q) ? Number(q.replace("#", "")) : null;
    and.push({
      OR: [
        ...(asId ? [{ id: asId }] : []),
        { observations: ci(q) },
        { manualTitle: ci(q) },
        { equipment: { is: { name: ci(q) } } },
        { equipment: { is: { code: ci(q) } } },
        { route: { is: { name: ci(q) } } },
        { route: { is: { equipment: { is: { name: ci(q) } } } } },
        { route: { is: { equipment: { is: { code: ci(q) } } } } },
        { route: { is: { lubricant: { is: { name: ci(q) } } } } },
        { route: { is: { lubricant: { is: { code: ci(q) } } } } },
        { technician: { is: { name: ci(q) } } },
        { technician: { is: { code: ci(q) } } },
      ],
    });
  }

  return { AND: and };
}

const EQUIPMENT_SELECT = {
  id: true,
  name: true,
  code: true,
  location: true,
  criticality: true,
  area: { select: { id: true, name: true } },
};

const EXECUTION_INCLUDE = {
  equipment: { select: EQUIPMENT_SELECT },
  route: {
    select: {
      id: true,
      name: true,
      routeKind: true,
      isEmergency: true,
      unit: true,
      quantity: true,
      points: true,
      method: true,
      instructions: true,
      imageUrl: true,
      lubricantType: true,
      lubricantName: true,
      equipmentId: true,
      equipment: { select: EQUIPMENT_SELECT },
      lubricant: { select: { id: true, name: true, code: true, unit: true } },
    },
  },
  technician: { select: { id: true, name: true, code: true } },
  lubricantMovements: {
    select: {
      id: true,
      type: true,
      quantity: true,
      stockBefore: true,
      stockAfter: true,
      createdAt: true,
      lubricant: { select: { id: true, name: true, code: true, unit: true } },
    },
    orderBy: { createdAt: "desc" },
  },
};

/** Tipo de actividad para la UI y la exportación. */
export function activityKind(ex) {
  if (String(ex?.sourceType || "").toUpperCase() === "OLP") return "OLP";
  if (ex?.route?.isEmergency || /^EMERGENTE\b/i.test(String(ex?.manualTitle || ""))) return "EMERGENCY";
  if (ex?.route) return String(ex.route.routeKind || "").toUpperCase() === "INSPECTION" ? "INSPECTION" : "ROUTE";
  if (String(ex?.origin || "").toUpperCase() === "ROUTE") return "DELETED_ROUTE";
  return "MANUAL";
}

const KIND_LABEL = {
  ROUTE: "Ruta de lubricación",
  INSPECTION: "Ruta de inspección",
  EMERGENCY: "Emergencia",
  OLP: "Orden preventiva",
  MANUAL: "Actividad manual",
  DELETED_ROUTE: "Ruta eliminada",
};

function serializeExecution(ex, tz) {
  const equipment = ex.route?.equipment || ex.equipment || null;
  const delayDays = ex.scheduledAt && ex.executedAt ? zonedDayDiff(ex.scheduledAt, ex.executedAt, tz) : null;
  return {
    ...ex,
    equipment,
    kind: activityKind(ex),
    delayDays,
  };
}

/* ─────────── Movimientos ─────────── */

export function buildMovementsWhere({ plantId, query, range, techScope }) {
  const and = [{ OR: [{ lubricant: { plantId } }, { execution: { is: { plantId } } }] }];

  if (range.from || range.to) {
    and.push({
      createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) },
    });
  }

  const type = String(query.type || "").toUpperCase().trim();
  if (MOVE_TYPES.has(type)) and.push({ type });

  const lubricantId = toId(query.lubricantId);
  if (lubricantId) and.push({ lubricantId });

  if (techScope != null) and.push({ execution: { is: { plantId, technicianId: techScope } } });

  const q = String(query.q || "").trim();
  if (q) {
    and.push({
      OR: [
        { reason: ci(q) },
        { note: ci(q) },
        { lubricant: { name: ci(q) } },
        { lubricant: { code: ci(q) } },
        { execution: { is: { manualTitle: ci(q) } } },
        { execution: { is: { route: { is: { name: ci(q) } } } } },
        { execution: { is: { equipment: { is: { name: ci(q) } } } } },
        { execution: { is: { route: { is: { equipment: { is: { name: ci(q) } } } } } } },
      ],
    });
  }

  return { AND: and };
}

const MOVEMENT_INCLUDE = {
  lubricant: { select: { id: true, name: true, code: true, unit: true } },
  execution: {
    select: {
      id: true,
      manualTitle: true,
      executedAt: true,
      technicianId: true,
      equipment: { select: { id: true, name: true, code: true } },
      technician: { select: { id: true, name: true, code: true } },
      route: { select: { id: true, name: true, equipment: { select: { id: true, name: true, code: true } } } },
    },
  },
};

function serializeMovement(m) {
  const ex = m.execution;
  return {
    ...m,
    execution: ex ? { ...ex, equipment: ex.route?.equipment || ex.equipment || null } : null,
  };
}

/* ─────────── CSV ─────────── */

export function toCsv(headers, rows) {
  const cell = (v) => {
    if (v == null) return "";
    let s = String(v);
    // Evita que Excel interprete fórmulas en texto capturado por usuarios (los números se dejan igual).
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(cell).join(",")];
  for (const r of rows) lines.push(r.map(cell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

const CONDITION_LABEL = { BUENO: "Buena", REGULAR: "Regular", MALO: "Mala", CRITICO: "Crítica" };
const MOVE_LABEL = { IN: "Entrada", OUT: "Salida", ADJUST: "Ajuste" };
const REASON_LABEL = { EXECUTION: "Consumo por actividad", EMERGENCY: "Actividad de emergencia" };
const reasonLabel = (r) => REASON_LABEL[String(r || "").trim().toUpperCase()] || r || "";

function sendCsv(res, filename, csv) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(csv);
}

const fileStamp = (range, tz) => {
  const a = range.from ? zonedDateTimeLabel(range.from, tz).slice(0, 10).split("/").reverse().join("-") : "inicio";
  const b = range.to ? zonedDateTimeLabel(range.to, tz).slice(0, 10).split("/").reverse().join("-") : "hoy";
  return `${a}_${b}`;
};

/* ─────────── Router ─────────── */

export default function historyRoutes({ prisma, auth }) {
  const router = Router();

  async function context(req, res) {
    const plantId = req.currentPlantId;
    if (!plantId) {
      res.status(400).json({ error: "PLANT_REQUIRED" });
      return null;
    }
    const tz = await plantTimeZone(prisma, plantId);
    const range = resolveRange(req.query, tz);
    if (range.error) {
      res.status(400).json({ error: range.error });
      return null;
    }
    return { plantId, tz, range, techScope: technicianScope(req) };
  }

  // GET /api/history/executions
  router.get("/executions", auth, async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { page, pageSize, skip } = pageParams(req.query);
      const where = buildExecutionsWhere({ ...ctx, query: req.query });
      const totalsWhere = buildExecutionsWhere({ ...ctx, query: req.query, withCondition: false });

      const [items, total, grouped, withEvidence] = await Promise.all([
        prisma.execution.findMany({
          where,
          include: EXECUTION_INCLUDE,
          orderBy: [{ executedAt: "desc" }, { id: "desc" }],
          skip,
          take: pageSize,
        }),
        prisma.execution.count({ where }),
        prisma.execution.groupBy({ by: ["condition"], where: totalsWhere, _count: { _all: true } }),
        prisma.execution.count({
          where: { AND: [totalsWhere, { evidenceImage: { not: null } }, { NOT: { evidenceImage: "" } }] },
        }),
      ]);

      const totals = { all: 0, BUENO: 0, REGULAR: 0, MALO: 0, CRITICO: 0, SIN_CONDICION: 0, withEvidence };
      for (const row of grouped) {
        const k = String(row.condition || "").toUpperCase();
        totals.all += row._count._all;
        if (CONDITIONS.has(k)) totals[k] += row._count._all;
        else totals.SIN_CONDICION += row._count._all;
      }

      return res.json({
        ok: true,
        items: items.map((ex) => serializeExecution(ex, ctx.tz)),
        meta: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), totals, timezone: ctx.tz },
      });
    } catch (e) {
      logger.error("Error history executions:", e);
      return res.status(500).json({ error: "Error obteniendo historial" });
    }
  });

  // GET /api/history/executions/export  (CSV)
  router.get("/executions/export", auth, async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const where = buildExecutionsWhere({ ...ctx, query: req.query });
      const items = await prisma.execution.findMany({
        where,
        include: EXECUTION_INCLUDE,
        orderBy: [{ executedAt: "desc" }, { id: "desc" }],
        take: EXPORT_LIMIT,
      });

      const headers = [
        "Folio", "Fecha de ejecución", "Fecha programada", "Días de retraso", "Tipo", "Actividad",
        "Equipo", "Código de equipo", "Área", "Ubicación", "Criticidad", "Técnico", "Código de técnico",
        "Lubricante", "Cantidad registrada", "Unidad registrada", "Descontado de inventario", "Unidad de inventario",
        "Stock antes", "Stock después", "Condición", "Observaciones", "Evidencia (URL)", "Nota de evidencia",
      ];
      const rows = items.map((raw) => {
        const ex = serializeExecution(raw, ctx.tz);
        const eq = ex.equipment || {};
        const mv = ex.lubricantMovements?.[0] || null;
        const lub = ex.route?.lubricant || mv?.lubricant || null;
        return [
          ex.id,
          zonedDateTimeLabel(ex.executedAt, ctx.tz),
          zonedDateTimeLabel(ex.scheduledAt, ctx.tz).slice(0, 10),
          ex.delayDays != null ? Math.max(0, ex.delayDays) : "",
          KIND_LABEL[ex.kind] || ex.kind,
          ex.route?.name || ex.manualTitle || "",
          eq.name || "",
          eq.code || "",
          eq.area?.name || "",
          eq.location || "",
          eq.criticality || "",
          ex.technician?.name || "",
          ex.technician?.code || "",
          lub ? `${lub.name}${lub.code ? ` (${lub.code})` : ""}` : ex.route?.lubricantName || ex.route?.lubricantType || "",
          ex.usedInputQuantity ?? ex.usedQuantity ?? "",
          ex.usedInputUnit || ex.route?.unit || "",
          // Lo realmente descontado es el movimiento de inventario (en la unidad del lubricante).
          mv ? mv.quantity : ex.usedConvertedQuantity ?? "",
          mv ? mv.lubricant?.unit || "" : ex.usedConvertedUnit || "",
          mv?.stockBefore ?? "",
          mv?.stockAfter ?? "",
          CONDITION_LABEL[String(ex.condition || "").toUpperCase()] || ex.condition || "",
          ex.observations || "",
          ex.evidenceImage || "",
          ex.evidenceNote || "",
        ];
      });

      return sendCsv(res, `historial-actividades_${fileStamp(ctx.range, ctx.tz)}.csv`, toCsv(headers, rows));
    } catch (e) {
      logger.error("Error history executions export:", e);
      return res.status(500).json({ error: "Error exportando historial" });
    }
  });

  // GET /api/history/lubricant-movements
  router.get("/lubricant-movements", auth, async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { page, pageSize, skip } = pageParams(req.query);
      const where = buildMovementsWhere({ ...ctx, query: req.query });
      const totalsWhere = buildMovementsWhere({ ...ctx, query: { ...req.query, type: "" } });

      const [items, total, grouped] = await Promise.all([
        prisma.lubricantMovement.findMany({
          where,
          include: MOVEMENT_INCLUDE,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip,
          take: pageSize,
        }),
        prisma.lubricantMovement.count({ where }),
        prisma.lubricantMovement.groupBy({ by: ["type"], where: totalsWhere, _count: { _all: true } }),
      ]);

      const totals = { all: 0, IN: 0, OUT: 0, ADJUST: 0 };
      for (const row of grouped) {
        const k = String(row.type || "").toUpperCase();
        totals.all += row._count._all;
        if (k in totals) totals[k] += row._count._all;
      }

      return res.json({
        ok: true,
        items: items.map(serializeMovement),
        meta: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), totals, timezone: ctx.tz },
      });
    } catch (e) {
      logger.error("Error history lubricant-movements:", e);
      return res.status(500).json({ error: "Error obteniendo movimientos" });
    }
  });

  // GET /api/history/lubricant-movements/export  (CSV)
  router.get("/lubricant-movements/export", auth, async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const where = buildMovementsWhere({ ...ctx, query: req.query });
      const items = await prisma.lubricantMovement.findMany({
        where,
        include: MOVEMENT_INCLUDE,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: EXPORT_LIMIT,
      });

      const headers = [
        "Folio", "Fecha", "Tipo", "Lubricante", "Código de lubricante", "Cantidad", "Unidad",
        "Cantidad capturada", "Unidad capturada", "Stock antes", "Stock después", "Motivo", "Nota",
        "Actividad (folio)", "Actividad", "Equipo", "Técnico",
      ];
      const rows = items.map((raw) => {
        const m = serializeMovement(raw);
        const ex = m.execution;
        return [
          m.id,
          zonedDateTimeLabel(m.createdAt, ctx.tz),
          MOVE_LABEL[String(m.type || "").toUpperCase()] || m.type,
          m.lubricant?.name || "",
          m.lubricant?.code || "",
          m.quantity,
          m.lubricant?.unit || "",
          m.inputQuantity ?? "",
          m.inputUnit || "",
          m.stockBefore ?? "",
          m.stockAfter ?? "",
          reasonLabel(m.reason),
          m.note || "",
          ex?.id ?? "",
          ex ? ex.route?.name || ex.manualTitle || "" : "",
          ex?.equipment?.name || "",
          ex?.technician?.name || "",
        ];
      });

      return sendCsv(res, `historial-movimientos_${fileStamp(ctx.range, ctx.tz)}.csv`, toCsv(headers, rows));
    } catch (e) {
      logger.error("Error history movements export:", e);
      return res.status(500).json({ error: "Error exportando movimientos" });
    }
  });

  return router;
}
