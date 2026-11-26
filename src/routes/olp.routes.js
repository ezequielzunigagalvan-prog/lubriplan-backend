// src/routes/olp.routes.js
// Órdenes de Lubricación Preventiva (OLP) — /api/preventive-orders
//
// En muchas plantas la lubricación se hace junto con el preventivo de mantenimiento, cuando el
// equipo está parado. La OLP agrupa las rutas de un equipo que se van a ejecutar en ese paro.
//
// Reglas:
//  - Al crear se eligen las rutas (algunas o todas). Incluye las rutas compartidas con otros equipos.
//  - Ejecutar una ruta desde la OLP cierra SU actividad pendiente/vencida (no crea una duplicada),
//    así el cumplimiento, el historial y el análisis la cuentan una sola vez. Queda marcada como OLP.
//  - La siguiente fecha de la ruta sale del día del preventivo (se reinicia el ciclo) y se deja
//    programada la siguiente actividad pendiente.
//  - Rutas compartidas: se registra la ejecución solo para este equipo y la ruta conserva su fecha
//    (los demás equipos siguen pendientes).
//  - Inventario: cantidad por punto × puntos con conversión de unidades, respeta preventNegativeStock.
//    El técnico puede capturar la cantidad real por punto.
//  - Foto obligatoria si la ruta o la orden la piden.
//  - Completar dos veces la misma ruta no descuenta dos veces.

import { Router } from "express";
import { logger } from "../config/logger.js";
import { startOfDay, endOfDay } from "../utils/routeScheduling.js";
import { ruleOf, toYmd, ymdToDate, nextAfterCompletion, describeRule } from "../utils/routeSchedule.js";
import { zonedYmd, safeTimeZone } from "../utils/tzRange.js";
import { syncOpenExecution, routeEquipmentIds } from "../services/routeExecutions.js";
import { computeRouteConsumption, round2 } from "../utils/units.js";
import { notifyIfLowStock } from "../services/inventory/lowStock.js";
import { normalizeImageInput } from "../lib/cloudinary.js";
import { logAudit } from "../services/audit.service.js";
import { notifyTechnicianAssignee, notifyManagers } from "../notifications/notify.js";

const ORDER_STATUSES = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
const ITEM_STATUSES = ["PENDING", "COMPLETED", "SKIPPED"];
const CONDITIONS = ["BUENO", "REGULAR", "MALO", "CRITICO"];

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sendError(res, err, tag) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  logger.error(`[OLP ${tag}]`, err);
  return res.status(500).json({ error: "Error procesando la orden preventiva" });
}

/** Fecha de calendario (YYYY-MM-DD o ISO) a mediodía UTC, como el resto de fechas programadas. */
function parseCalendarDate(v) {
  const s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ymdToDate(s);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return ymdToDate(d.toISOString().slice(0, 10));
}

const executionNote = (orderId) => `Ejecutado desde Orden Preventiva #${orderId}`;

async function assertTechnicianInPlant(db, technicianId, plantId) {
  if (technicianId == null) return null;
  const id = toId(technicianId);
  if (!id) throw new HttpError(400, "Técnico inválido");
  const tech = await db.technician.findFirst({
    where: { id, plantId, deletedAt: null },
    select: { id: true },
  });
  if (!tech) throw new HttpError(400, "El técnico no pertenece a esta planta");
  return id;
}

/** Rutas de lubricación/inspección del equipo (propias y compartidas), sin emergentes. */
async function equipmentRouteIds(db, equipmentId, plantId) {
  const routes = await db.route.findMany({
    where: {
      plantId,
      isEmergency: false,
      OR: [{ equipmentId }, { equipments: { some: { equipmentId } } }],
    },
    select: { id: true },
    orderBy: { name: "asc" },
  });
  return routes.map((r) => r.id);
}

/**
 * Rutas a incluir: `routeIds` (subconjunto) o todas si no se manda o `allRoutes` es true.
 * Valida que cada ruta sea del equipo.
 */
async function resolveSelectedRoutes(db, { equipmentId, plantId, routeIds, allRoutes }) {
  const available = await equipmentRouteIds(db, equipmentId, plantId);
  if (!available.length) throw new HttpError(400, "El equipo no tiene rutas de lubricación");
  if (allRoutes === true || routeIds == null) return available;
  if (!Array.isArray(routeIds)) throw new HttpError(400, "routeIds inválido");
  const wanted = [...new Set(routeIds.map(toId).filter(Boolean))];
  if (!wanted.length) throw new HttpError(400, "Selecciona al menos una ruta");
  const allowed = new Set(available);
  const foreign = wanted.filter((id) => !allowed.has(id));
  if (foreign.length) throw new HttpError(400, "Alguna ruta seleccionada no pertenece a este equipo");
  return wanted;
}

/**
 * Ejecuta un punto (ruta) de la orden dentro de una transacción.
 * Devuelve lo necesario para responder y para validar: ejecución, siguiente fecha, inventario.
 */
async function executeItem(tx, { order, item, plantId, executorTechnicianId, input }) {
  const route = await tx.route.findFirst({ where: { id: item.routeId, plantId }, include: { equipments: true } });
  if (!route) throw new HttpError(404, "La ruta de este punto ya no existe");

  const equipmentIds = routeEquipmentIds(route);
  const shared = equipmentIds.length > 1;
  const executedAt = new Date();

  const plant = await tx.plant.findFirst({ where: { id: plantId }, select: { timezone: true } });
  const executedYmd = zonedYmd(executedAt, safeTimeZone(plant?.timezone || "America/Mexico_City"));

  // ── Inventario ──
  let inventoryWarning = null;
  let consumption = null;
  let lubricant = null;
  if (route.lubricantId) {
    lubricant = await tx.lubricant.findFirst({
      where: { id: route.lubricantId, plantId },
      select: { id: true, name: true, unit: true, stock: true },
    });
  }
  const qtyRoute = input.usedQuantity != null ? { ...route, quantity: input.usedQuantity } : route;
  if (lubricant) {
    consumption = computeRouteConsumption(qtyRoute, lubricant.unit);
    if (!consumption.ok) {
      inventoryWarning = `No se descontó inventario: ${consumption.reason}`;
      consumption = null;
    } else {
      const settings = await tx.appSettings.findUnique({ where: { id: 1 }, select: { preventNegativeStock: true } });
      const preventNegativeStock = settings?.preventNegativeStock ?? true;
      if (preventNegativeStock && Number(lubricant.stock || 0) - consumption.inventoryQuantity < 0) {
        throw new HttpError(
          400,
          `Stock insuficiente de ${lubricant.name}: hay ${round2(lubricant.stock)} ${consumption.inventoryUnit}, se requieren ${consumption.inventoryQuantity}`
        );
      }
    }
  } else if (Number(qtyRoute.quantity) > 0 && String(route.routeKind || "").toUpperCase() !== "INSPECTION") {
    inventoryWarning = "No se descontó inventario: la ruta no tiene lubricante de inventario asignado";
  }

  const execData = {
    technicianId: executorTechnicianId,
    sourceType: "OLP",
    status: "COMPLETED",
    executedAt,
    condition: input.condition,
    observations: input.observations,
    evidenceImage: input.photoUrl,
    evidenceImagePublicId: input.photoPublicId || null,
    evidenceNote: executionNote(order.id),
    usedQuantity: consumption ? consumption.inputQuantity : null,
    usedInputQuantity: consumption ? consumption.inputQuantity : null,
    usedInputUnit: consumption ? consumption.inputUnit : null,
    usedConvertedQuantity: consumption ? consumption.convertedQuantity : null,
    usedConvertedUnit: consumption ? consumption.convertedUnit : null,
    inventoryDeductedAt: consumption ? executedAt : null,
    ...(shared ? { equipmentChecklist: equipmentIds.map((id) => ({ equipmentId: id, done: id === order.equipmentId, note: id === order.equipmentId ? "OLP" : null })) } : {}),
  };

  // ── Ejecución: cierra la actividad abierta de la ruta (si no es compartida) ──
  const open = shared
    ? null
    : await tx.execution.findFirst({
        where: { plantId, routeId: route.id, status: { in: ["PENDING", "OVERDUE"] } },
        orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
        select: { id: true, scheduledAt: true },
      });

  let execution;
  if (open) {
    // Adelantada por el preventivo: queda programada el día en que se hizo, así el cumplimiento
    // la cuenta en este periodo y el siguiente periodo solo tiene la nueva actividad.
    const early = toYmd(open.scheduledAt) > executedYmd;
    execution = await tx.execution.update({
      where: { id: open.id },
      data: { ...execData, ...(early ? { scheduledAt: ymdToDate(executedYmd) } : {}) },
    });
  } else {
    execution = await tx.execution.create({
      data: {
        plantId,
        routeId: route.id,
        equipmentId: shared ? order.equipmentId : route.equipmentId ?? order.equipmentId,
        origin: "ROUTE",
        scheduledAt: ymdToDate(executedYmd),
        ...execData,
      },
    });
  }

  let stock = null;
  let deductedLubricantId = null;
  if (consumption) {
    // decrement atómico: evita perder descuentos si dos técnicos completan a la vez
    const updatedLub = await tx.lubricant.update({
      where: { id: lubricant.id },
      data: { stock: { decrement: consumption.inventoryQuantity } },
      select: { stock: true },
    });
    const stockAfter = round2(updatedLub.stock);
    const stockBefore = round2(stockAfter + consumption.inventoryQuantity);
    await tx.lubricantMovement.create({
      data: {
        lubricantId: lubricant.id,
        executionId: execution.id,
        type: "OUT",
        quantity: consumption.inventoryQuantity,
        inputQuantity: consumption.inputQuantity,
        inputUnit: consumption.inputUnit,
        convertedQuantity: consumption.convertedQuantity,
        convertedUnit: consumption.convertedUnit,
        reason: "EXECUTION",
        note: [`OLP #${order.id}`, `Ejecucion #${execution.id}`, `Ruta: ${route.name}`, `Final: ${consumption.convertedQuantity} ${consumption.convertedUnit}`].join(" | "),
        stockBefore,
        stockAfter,
      },
    });
    deductedLubricantId = lubricant.id;
    stock = {
      lubricantId: lubricant.id,
      lubricantName: lubricant.name,
      quantity: consumption.inventoryQuantity,
      unit: consumption.inventoryUnit,
      stockBefore,
      stockAfter,
    };
  }

  // ── Reprogramación ──
  let nextDate = route.nextDate ?? null;
  if (!shared) {
    // Si la actividad ya tocaba (hoy o vencida) se respeta el calendario; si se adelantó por el
    // preventivo, el ciclo se reinicia desde el día de ejecución.
    const openYmd = toYmd(open?.scheduledAt) || toYmd(route.nextDate);
    const base = openYmd && openYmd <= executedYmd ? openYmd : executedYmd;
    const nextYmd = nextAfterCompletion(ruleOf(route), base, executedYmd);
    const routeTechnicianId = route.technicianId ?? executorTechnicianId ?? null;
    await tx.route.updateMany({
      where: { id: route.id, plantId },
      data: { lastDate: ymdToDate(executedYmd), nextDate: nextYmd ? ymdToDate(nextYmd) : null, technicianId: routeTechnicianId },
    });
    nextDate = nextYmd ? ymdToDate(nextYmd) : null;
    if (nextYmd) await syncOpenExecution(tx, { plantId, route, ymd: nextYmd, technicianId: routeTechnicianId });
  }

  return {
    execution: { id: execution.id, reusedOpen: Boolean(open), status: "COMPLETED" },
    routeName: route.name,
    shared,
    nextDate,
    stock,
    inventoryWarning,
    deductedLubricantId,
  };
}

/** Recalcula el estado de la orden después de mover un punto. */
async function refreshOrderStatus(tx, order) {
  const pendingItems = await tx.preventiveOrderItem.count({
    where: { preventiveOrderId: order.id, status: "PENDING" },
  });
  if (pendingItems === 0) {
    await tx.preventiveOrder.update({ where: { id: order.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    return "COMPLETED";
  }
  if (order.status === "OPEN" || order.status === "DRAFT") {
    await tx.preventiveOrder.update({ where: { id: order.id }, data: { status: "IN_PROGRESS" } });
    return "IN_PROGRESS";
  }
  return order.status;
}

function parseItemInput(body = {}) {
  const status = String(body.status || "COMPLETED").toUpperCase();
  if (!ITEM_STATUSES.includes(status)) throw new HttpError(400, "status inválido");
  const condition = body.condition ? String(body.condition).trim().toUpperCase() : "BUENO";
  if (!CONDITIONS.includes(condition)) throw new HttpError(400, "Condición inválida");
  let usedQuantity = null;
  if (body.usedQuantity !== undefined && body.usedQuantity !== null && body.usedQuantity !== "") {
    usedQuantity = Number(body.usedQuantity);
    if (!Number.isFinite(usedQuantity) || usedQuantity <= 0) throw new HttpError(400, "Cantidad utilizada inválida");
  }
  const observations = body.observations ? String(body.observations).trim().slice(0, 1000) || null : null;
  return { status, condition, usedQuantity, observations, photoUrl: body.photoUrl || null };
}

export default function olpRoutes({ prisma, auth, requireRole }) {
  const router = Router();
  const managers = requireRole(["ADMIN", "SUPERVISOR"]);

  router.use(auth);
  router.use((req, res, next) => {
    if (!req.currentPlantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
    next();
  });

  async function findOrder(id, plantId) {
    const orderId = toId(id);
    if (!orderId) throw new HttpError(400, "id inválido");
    const order = await prisma.preventiveOrder.findFirst({ where: { id: orderId, plantId } });
    if (!order) throw new HttpError(404, "Orden no encontrada");
    return order;
  }

  function assertCanExecute(req, order) {
    const role = String(req.user?.role || "").toUpperCase();
    const myTechnicianId = req.user?.technicianId != null ? Number(req.user.technicianId) : null;
    if (role === "TECHNICIAN" && order.assignedTo != null && order.assignedTo !== myTechnicianId) {
      throw new HttpError(403, "Esta orden está asignada a otro técnico");
    }
    if (role === "TECHNICIAN" && order.status === "DRAFT") {
      throw new HttpError(400, "La orden aún no está liberada");
    }
    // Quien ejecuta: el técnico logueado; si es supervisor, el técnico asignado a la orden.
    return myTechnicianId ?? order.assignedTo ?? null;
  }

  async function uploadPhoto(photoUrl, orderId, itemId) {
    if (!photoUrl) return { imageUrl: null, imagePublicId: null };
    try {
      return await normalizeImageInput(photoUrl, {
        folder: "lubriplan/execution-evidence",
        publicId: `olp_${orderId}_${itemId}_${Date.now()}`,
      });
    } catch (err) {
      logger.error(`[OLP PHOTO] Orden #${orderId} item #${itemId}`, err);
      throw new HttpError(400, "No se pudo subir la foto de evidencia");
    }
  }

  // ── GET /api/preventive-orders/equipment-routes/:equipmentId ── (rutas disponibles para elegir)
  router.get("/equipment-routes/:equipmentId", managers, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const equipmentId = toId(req.params.equipmentId);
      if (!equipmentId) return res.status(400).json({ error: "Equipo inválido" });
      const equipment = await prisma.equipment.findFirst({ where: { id: equipmentId, plantId }, select: { id: true, name: true, code: true } });
      if (!equipment) return res.status(404).json({ error: "Equipo no encontrado" });

      const routes = await prisma.route.findMany({
        where: { plantId, isEmergency: false, OR: [{ equipmentId }, { equipments: { some: { equipmentId } } }] },
        select: {
          id: true,
          name: true,
          routeKind: true,
          lubricantId: true,
          lubricantName: true,
          quantity: true,
          unit: true,
          points: true,
          method: true,
          frequencyType: true,
          frequencyDays: true,
          weeklyDays: true,
          monthlyAnchorDay: true,
          customIntervalDays: true,
          lastDate: true,
          nextDate: true,
          evidenceRequired: true,
          equipmentId: true,
          equipments: { select: { equipmentId: true } },
          technician: { select: { id: true, name: true } },
        },
        orderBy: { name: "asc" },
      });

      const plant = await prisma.plant.findFirst({ where: { id: plantId }, select: { timezone: true } });
      const todayYmd = zonedYmd(new Date(), safeTimeZone(plant?.timezone || "America/Mexico_City"));
      const open = routes.length
        ? await prisma.execution.findMany({
            where: { plantId, routeId: { in: routes.map((r) => r.id) }, status: { in: ["PENDING", "OVERDUE"] } },
            select: { routeId: true, scheduledAt: true },
            orderBy: { scheduledAt: "asc" },
          })
        : [];
      const openByRoute = new Map();
      for (const e of open) if (!openByRoute.has(e.routeId)) openByRoute.set(e.routeId, e.scheduledAt);

      const lubIds = [...new Set(routes.map((r) => r.lubricantId).filter(Boolean))];
      const lubs = lubIds.length
        ? await prisma.lubricant.findMany({ where: { id: { in: lubIds }, plantId }, select: { id: true, name: true, unit: true, stock: true } })
        : [];
      const lubById = new Map(lubs.map((l) => [l.id, l]));

      const data = routes.map((r) => {
        const ids = new Set([r.equipmentId, ...r.equipments.map((x) => x.equipmentId)].filter(Boolean));
        const dueYmd = toYmd(openByRoute.get(r.id) || r.nextDate);
        const consumption = r.lubricantId && lubById.get(r.lubricantId) ? computeRouteConsumption(r, lubById.get(r.lubricantId).unit) : null;
        return {
          id: r.id,
          name: r.name,
          routeKind: r.routeKind,
          lubricantName: lubById.get(r.lubricantId)?.name || r.lubricantName || null,
          lubricantStock: lubById.get(r.lubricantId) ? { stock: round2(lubById.get(r.lubricantId).stock), unit: lubById.get(r.lubricantId).unit } : null,
          quantity: r.quantity,
          unit: r.unit,
          points: r.points,
          method: r.method,
          frequencyText: describeRule(ruleOf(r)),
          lastDate: r.lastDate,
          nextDate: r.nextDate,
          dueYmd,
          dueState: !dueYmd ? "NONE" : dueYmd < todayYmd ? "OVERDUE" : dueYmd === todayYmd ? "TODAY" : "UPCOMING",
          evidenceRequired: r.evidenceRequired,
          sharedCount: ids.size,
          technician: r.technician,
          estimatedConsumption: consumption?.ok ? { quantity: consumption.inventoryQuantity, unit: consumption.inventoryUnit } : null,
        };
      });

      return res.json({ equipment, todayYmd, routes: data });
    } catch (err) {
      return sendError(res, err, "EQUIPMENT_ROUTES");
    }
  });

  // ── GET /api/preventive-orders ──
  router.get("/", async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));

      const where = { plantId };

      if (req.query.status) {
        const statuses = String(req.query.status)
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter((s) => ORDER_STATUSES.includes(s));
        if (!statuses.length) return res.status(400).json({ error: "status inválido" });
        where.status = statuses.length > 1 ? { in: statuses } : statuses[0];
      }

      // El técnico solo ve las órdenes liberadas que son suyas o que no tienen técnico.
      const role = String(req.user?.role || "").toUpperCase();
      if (role === "TECHNICIAN") {
        const myTechnicianId = req.user?.technicianId != null ? Number(req.user.technicianId) : null;
        where.AND = [
          { status: { not: "DRAFT" } },
          { OR: [{ assignedTo: myTechnicianId ?? -1 }, { assignedTo: null }] },
        ];
      }

      const assignedTo = toId(req.query.assignedTo);
      if (assignedTo) where.assignedTo = assignedTo;

      const equipmentId = toId(req.query.equipmentId);
      if (equipmentId) where.equipmentId = equipmentId;

      const q = String(req.query.q || "").trim();
      if (q) {
        where.OR = [
          { title: { contains: q, mode: "insensitive" } },
          { equipment: { name: { contains: q, mode: "insensitive" } } },
          { equipment: { code: { contains: q, mode: "insensitive" } } },
        ];
      }

      // Rango de fechas: completadas por fecha de cierre, el resto por fecha programada.
      const from = req.query.from ? startOfDay(req.query.from) : null;
      const to = req.query.to ? endOfDay(req.query.to) : null;
      if (from || to) {
        const dateField = where.status === "COMPLETED" ? "completedAt" : "scheduledDate";
        where[dateField] = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      }

      const [orders, total, counts] = await Promise.all([
        prisma.preventiveOrder.findMany({
          where,
          select: {
            id: true,
            title: true,
            status: true,
            scheduledDate: true,
            completedAt: true,
            createdAt: true,
            requiresPhoto: true,
            notes: true,
            equipment: { select: { id: true, name: true, code: true } },
            assignedToUser: { select: { id: true, name: true } },
            _count: { select: { items: true } },
          },
          orderBy: [{ scheduledDate: "desc" }, { id: "desc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.preventiveOrder.count({ where }),
        prisma.preventiveOrder.groupBy({
          by: ["status"],
          where: { plantId, ...(where.AND ? { AND: where.AND } : {}) },
          _count: { _all: true },
        }),
      ]);

      const itemCounts = orders.length
        ? await prisma.preventiveOrderItem.groupBy({
            by: ["preventiveOrderId", "status"],
            where: { preventiveOrderId: { in: orders.map((o) => o.id) } },
            _count: { _all: true },
          })
        : [];
      const doneById = new Map();
      for (const r of itemCounts) {
        const cur = doneById.get(r.preventiveOrderId) || { completed: 0, skipped: 0 };
        if (r.status === "COMPLETED") cur.completed += r._count._all;
        if (r.status === "SKIPPED") cur.skipped += r._count._all;
        doneById.set(r.preventiveOrderId, cur);
      }

      const data = orders.map((order) => {
        const d = doneById.get(order.id) || { completed: 0, skipped: 0 };
        return { ...order, progress: { completed: d.completed, skipped: d.skipped, total: order._count.items } };
      });

      const byStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
      for (const c of counts) byStatus[c.status] = c._count._all;

      const totalPages = Math.ceil(total / limit);
      return res.json({ data, total, page, totalPages, counts: byStatus, meta: { total, page, limit, totalPages } });
    } catch (err) {
      return sendError(res, err, "LIST");
    }
  });

  // ── GET /api/preventive-orders/:id ──
  router.get("/:id", async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const orderId = toId(req.params.id);
      if (!orderId) return res.status(400).json({ error: "id inválido" });

      const order = await prisma.preventiveOrder.findFirst({
        where: { id: orderId, plantId },
        include: {
          plant: { select: { name: true } },
          equipment: { select: { id: true, name: true, code: true, location: true } },
          createdByUser: { select: { id: true, name: true } },
          assignedToUser: { select: { id: true, name: true, code: true } },
          items: {
            orderBy: { id: "asc" },
            include: {
              route: {
                select: {
                  id: true,
                  name: true,
                  routeKind: true,
                  lubricantId: true,
                  lubricantName: true,
                  lubricantType: true,
                  quantity: true,
                  unit: true,
                  points: true,
                  frequencyType: true,
                  frequencyDays: true,
                  method: true,
                  instructions: true,
                  weeklyDays: true,
                  monthlyAnchorDay: true,
                  customIntervalDays: true,
                  lastDate: true,
                  nextDate: true,
                  evidenceRequired: true,
                  equipmentId: true,
                  equipments: { select: { equipmentId: true } },
                },
              },
              completedByUser: { select: { name: true } },
            },
          },
        },
      });

      if (!order) return res.status(404).json({ error: "Orden no encontrada" });

      const role = String(req.user?.role || "").toUpperCase();
      if (role === "TECHNICIAN") {
        const mine = req.user?.technicianId != null ? Number(req.user.technicianId) : null;
        if (order.status === "DRAFT" || (order.assignedTo != null && order.assignedTo !== mine)) {
          return res.status(403).json({ error: "Esta orden no está disponible para ti" });
        }
      }

      // Ejecución generada por cada punto (historial, inventario) y lubricante de la ruta.
      const routeIds = order.items.map((i) => i.routeId);
      const [executions, lubs] = await Promise.all([
        routeIds.length
          ? prisma.execution.findMany({
              where: { plantId, routeId: { in: routeIds }, sourceType: "OLP", evidenceNote: executionNote(order.id) },
              select: {
                id: true,
                routeId: true,
                executedAt: true,
                condition: true,
                usedConvertedQuantity: true,
                usedConvertedUnit: true,
                evidenceImage: true,
                lubricantMovements: { select: { quantity: true, lubricant: { select: { name: true, unit: true } } } },
              },
            })
          : [],
        (async () => {
          const ids = [...new Set(order.items.map((i) => i.route?.lubricantId).filter(Boolean))];
          return ids.length ? prisma.lubricant.findMany({ where: { id: { in: ids }, plantId }, select: { id: true, name: true, unit: true, stock: true } }) : [];
        })(),
      ]);
      const execByRoute = new Map(executions.map((e) => [e.routeId, e]));
      const lubById = new Map(lubs.map((l) => [l.id, l]));

      const items = order.items.map((it) => {
        const r = it.route;
        const lub = r?.lubricantId ? lubById.get(r.lubricantId) : null;
        const consumption = r && lub ? computeRouteConsumption(r, lub.unit) : null;
        const ex = execByRoute.get(it.routeId) || null;
        const ids = r ? new Set([r.equipmentId, ...(r.equipments || []).map((x) => x.equipmentId)].filter(Boolean)) : new Set();
        return {
          ...it,
          route: r ? { ...r, equipments: undefined, frequencyText: describeRule(ruleOf(r)), sharedCount: ids.size, lubricant: lub ? { ...lub, stock: round2(lub.stock) } : null } : null,
          estimatedConsumption: consumption?.ok ? { quantity: consumption.inventoryQuantity, unit: consumption.inventoryUnit } : null,
          execution: ex
            ? {
                id: ex.id,
                executedAt: ex.executedAt,
                condition: ex.condition,
                usedQuantity: ex.usedConvertedQuantity,
                usedUnit: ex.usedConvertedUnit,
                evidenceImage: ex.evidenceImage,
                movements: ex.lubricantMovements.map((m) => ({ quantity: m.quantity, lubricant: m.lubricant?.name, unit: m.lubricant?.unit })),
              }
            : null,
        };
      });

      return res.json({ ...order, items });
    } catch (err) {
      return sendError(res, err, "DETAIL");
    }
  });

  // ── POST /api/preventive-orders ──
  router.post("/", managers, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const body = req.body || {};
      const equipmentId = toId(body.equipmentId);
      if (!equipmentId || !body.scheduledDate) {
        return res.status(400).json({ error: "Equipo y fecha son requeridos" });
      }
      const date = parseCalendarDate(body.scheduledDate);
      if (!date) return res.status(400).json({ error: "Fecha inválida" });

      const equipment = await prisma.equipment.findFirst({ where: { id: equipmentId, plantId }, select: { id: true, name: true } });
      if (!equipment) return res.status(404).json({ error: "Equipo no encontrado" });

      const assignedTo = await assertTechnicianInPlant(prisma, body.assignedTo || null, plantId);
      const routeIds = await resolveSelectedRoutes(prisma, { equipmentId, plantId, routeIds: body.routeIds, allRoutes: body.allRoutes });
      const release = body.release === true;

      const order = await prisma.preventiveOrder.create({
        data: {
          plantId,
          equipmentId,
          title: String(body.title || "").trim() || `Preventivo ${equipment.name} · ${toYmd(date).split("-").reverse().join("/")}`,
          scheduledDate: date,
          status: release ? "OPEN" : "DRAFT",
          createdBy: req.user.id,
          assignedTo,
          notes: body.notes ? String(body.notes).trim() : null,
          requiresPhoto: body.requiresPhoto === true,
          items: { create: routeIds.map((routeId) => ({ routeId, status: "PENDING" })) },
        },
        include: { items: true },
      });

      logAudit({ plantId, userId: req.user.id, action: "CREATE", model: "PreventiveOrder", recordId: order.id, changes: { after: { equipmentId, routes: routeIds.length, status: order.status } }, ip: req.ip });
      if (release && assignedTo) notifyAssigned(plantId, order, equipment.name);

      return res.status(201).json(order);
    } catch (err) {
      return sendError(res, err, "CREATE");
    }
  });

  function notifyAssigned(plantId, order, equipmentName) {
    notifyTechnicianAssignee(prisma, {
      plantId,
      technicianId: order.assignedTo,
      type: "EXEC_ASSIGNED",
      title: "Orden de lubricación preventiva asignada",
      message: `${equipmentName || "Equipo"} · ${order.items?.length || 0} ruta(s) · ${toYmd(order.scheduledDate)}`,
      link: `/preventive-orders/${order.id}`,
    }).catch((e) => logger.error("[OLP NOTIFY]", e));
  }

  // ── PUT /api/preventive-orders/:id ── (editar borrador u orden liberada sin avance)
  router.put("/:id", managers, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const order = await findOrder(req.params.id, plantId);
      if (order.status !== "DRAFT" && order.status !== "OPEN") {
        return res.status(400).json({ error: "Solo se pueden editar órdenes que no han iniciado" });
      }

      const body = req.body || {};
      const data = {};

      if (body.title !== undefined) data.title = String(body.title || "").trim() || order.title;
      if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
      if (body.requiresPhoto !== undefined) data.requiresPhoto = body.requiresPhoto === true;
      if (body.scheduledDate !== undefined) {
        const date = parseCalendarDate(body.scheduledDate);
        if (!date) return res.status(400).json({ error: "Fecha inválida" });
        data.scheduledDate = date;
      }
      if (body.assignedTo !== undefined) {
        data.assignedTo = await assertTechnicianInPlant(prisma, body.assignedTo || null, plantId);
      }

      const newEquipmentId = body.equipmentId !== undefined ? toId(body.equipmentId) : order.equipmentId;
      if (!newEquipmentId) return res.status(400).json({ error: "Equipo inválido" });
      const changeRoutes = newEquipmentId !== order.equipmentId || body.routeIds !== undefined || body.allRoutes !== undefined;

      const updated = await prisma.$transaction(async (tx) => {
        if (changeRoutes) {
          if (newEquipmentId !== order.equipmentId) {
            const equipment = await tx.equipment.findFirst({ where: { id: newEquipmentId, plantId }, select: { id: true } });
            if (!equipment) throw new HttpError(404, "Equipo no encontrado");
            data.equipmentId = newEquipmentId;
          }
          const done = await tx.preventiveOrderItem.count({ where: { preventiveOrderId: order.id, status: { not: "PENDING" } } });
          if (done) throw new HttpError(400, "La orden ya tiene rutas ejecutadas; no se pueden cambiar");
          const routeIds = await resolveSelectedRoutes(tx, {
            equipmentId: newEquipmentId,
            plantId,
            routeIds: body.routeIds,
            allRoutes: body.allRoutes,
          });
          await tx.preventiveOrderItem.deleteMany({ where: { preventiveOrderId: order.id } });
          await tx.preventiveOrderItem.createMany({
            data: routeIds.map((routeId) => ({ preventiveOrderId: order.id, routeId, status: "PENDING" })),
          });
        }
        return tx.preventiveOrder.update({ where: { id: order.id }, data, include: { items: true } });
      });

      return res.json(updated);
    } catch (err) {
      return sendError(res, err, "UPDATE");
    }
  });

  // ── DELETE /api/preventive-orders/:id ── (solo borradores)
  router.delete("/:id", managers, async (req, res) => {
    try {
      const order = await findOrder(req.params.id, req.currentPlantId);
      if (order.status !== "DRAFT") {
        return res.status(400).json({ error: "Solo se pueden eliminar borradores; las liberadas se cancelan" });
      }
      await prisma.$transaction([
        prisma.preventiveOrderItem.deleteMany({ where: { preventiveOrderId: order.id } }),
        prisma.preventiveOrder.delete({ where: { id: order.id } }),
      ]);
      logAudit({ plantId: req.currentPlantId, userId: req.user.id, action: "DELETE", model: "PreventiveOrder", recordId: order.id, changes: { before: { title: order.title } }, ip: req.ip });
      return res.json({ ok: true });
    } catch (err) {
      return sendError(res, err, "DELETE");
    }
  });

  // ── POST /api/preventive-orders/:id/cancel ── (cancela una orden liberada; lo ejecutado se queda)
  router.post("/:id/cancel", managers, async (req, res) => {
    try {
      const order = await findOrder(req.params.id, req.currentPlantId);
      if (order.status === "COMPLETED" || order.status === "CANCELLED") {
        return res.status(400).json({ error: "La orden ya está cerrada" });
      }
      const reason = String(req.body?.reason || "").trim();
      const updated = await prisma.preventiveOrder.update({
        where: { id: order.id },
        data: { status: "CANCELLED", notes: reason ? [order.notes, `Cancelada: ${reason}`].filter(Boolean).join("\n") : order.notes },
      });
      logAudit({ plantId: req.currentPlantId, userId: req.user.id, action: "STATE_CHANGE", model: "PreventiveOrder", recordId: order.id, changes: { before: { status: order.status }, after: { status: "CANCELLED", reason } }, ip: req.ip });
      return res.json(updated);
    } catch (err) {
      return sendError(res, err, "CANCEL");
    }
  });

  // ── POST /api/preventive-orders/:id/open ── (liberar al técnico)
  router.post("/:id/open", managers, async (req, res) => {
    try {
      const order = await findOrder(req.params.id, req.currentPlantId);
      if (order.status !== "DRAFT" && order.status !== "OPEN") {
        return res.status(400).json({ error: "Solo se pueden liberar órdenes en borrador" });
      }
      const updated = await prisma.preventiveOrder.update({
        where: { id: order.id },
        data: { status: "OPEN" },
        include: { items: true, equipment: { select: { name: true } } },
      });
      if (order.status === "DRAFT" && updated.assignedTo) notifyAssigned(req.currentPlantId, updated, updated.equipment?.name);
      return res.json(updated);
    } catch (err) {
      return sendError(res, err, "OPEN");
    }
  });

  // ── PUT /api/preventive-orders/:id/start ── (asignar técnico y poner en proceso)
  router.put("/:id/start", async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const order = await findOrder(req.params.id, plantId);
      if (order.status === "COMPLETED" || order.status === "CANCELLED") {
        return res.status(400).json({ error: "La orden ya está cerrada" });
      }
      const role = String(req.user?.role || "").toUpperCase();
      const requested = req.body?.assignedTo ?? (role === "TECHNICIAN" ? req.user?.technicianId : order.assignedTo);
      if (!requested) return res.status(400).json({ error: "assignedTo es requerido" });

      const assignedTo = await assertTechnicianInPlant(prisma, requested, plantId);
      if (role === "TECHNICIAN") {
        if (order.status === "DRAFT") return res.status(400).json({ error: "La orden aún no está liberada" });
        if (assignedTo !== Number(req.user?.technicianId)) return res.status(403).json({ error: "Solo puedes iniciar órdenes a tu nombre" });
        if (order.assignedTo != null && order.assignedTo !== assignedTo) return res.status(403).json({ error: "Esta orden está asignada a otro técnico" });
      }

      const updated = await prisma.preventiveOrder.update({
        where: { id: order.id },
        data: { status: "IN_PROGRESS", assignedTo },
        include: { assignedToUser: { select: { id: true, name: true } } },
      });
      return res.json(updated);
    } catch (err) {
      return sendError(res, err, "START");
    }
  });

  // ── PUT /api/preventive-orders/:id/items/:itemId ── (completar / omitir una ruta)
  router.put("/:id/items/:itemId", async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const order = await findOrder(req.params.id, plantId);
      const itemId = toId(req.params.itemId);
      if (!itemId) return res.status(400).json({ error: "itemId inválido" });
      if (order.status === "COMPLETED" || order.status === "CANCELLED") {
        return res.status(400).json({ error: "La orden ya está cerrada" });
      }
      const executorTechnicianId = assertCanExecute(req, order);
      const input = parseItemInput(req.body);
      if (input.status === "SKIPPED" && !input.observations) {
        return res.status(400).json({ error: "Indica el motivo para omitir la ruta" });
      }

      // Validación de foto antes de subirla (y antes de abrir la transacción).
      const preItem = await prisma.preventiveOrderItem.findFirst({ where: { id: itemId, preventiveOrderId: order.id } });
      if (!preItem) return res.status(404).json({ error: "Item no encontrado" });
      if (input.status === "COMPLETED" && preItem.status !== "COMPLETED" && !input.photoUrl) {
        const r = await prisma.route.findFirst({ where: { id: preItem.routeId, plantId } });
        if (order.requiresPhoto || r?.evidenceRequired) {
          return res.status(400).json({ error: "Esta ruta requiere foto de evidencia", code: "PHOTO_REQUIRED" });
        }
      }
      if (input.photoUrl && preItem.status !== "COMPLETED") {
        const up = await uploadPhoto(input.photoUrl, order.id, itemId);
        input.photoUrl = up.imageUrl;
        input.photoPublicId = up.imagePublicId;
      }

      const result = await prisma.$transaction(async (tx) => {
        // Bloquea la fila del punto: dos envíos a la vez no ejecutan la ruta dos veces.
        if (typeof tx.$queryRaw === "function") {
          await tx.$queryRaw`SELECT id FROM "PreventiveOrderItem" WHERE id = ${itemId} FOR UPDATE`;
        }
        const item = await tx.preventiveOrderItem.findFirst({ where: { id: itemId, preventiveOrderId: order.id } });
        if (!item) throw new HttpError(404, "Item no encontrado");

        if (item.status === "COMPLETED") {
          // Ya se ejecutó: no se crea otra ejecución ni se descuenta otra vez.
          if (input.status !== "COMPLETED") throw new HttpError(400, "Esta ruta ya fue ejecutada y no se puede revertir");
          const same = await tx.preventiveOrderItem.update({
            where: { id: item.id },
            data: { observations: input.observations ?? item.observations },
            include: { completedByUser: { select: { name: true } }, route: { select: { name: true } } },
          });
          return { updatedItem: same, alreadyCompleted: true };
        }

        let exec = null;
        if (input.status === "COMPLETED") {
          exec = await executeItem(tx, { order, item, plantId, executorTechnicianId, input });
        }

        const updatedItem = await tx.preventiveOrderItem.update({
          where: { id: item.id },
          data: {
            status: input.status,
            observations: input.observations,
            photoUrl: input.photoUrl,
            completedAt: input.status === "PENDING" ? null : new Date(),
            completedBy: input.status === "PENDING" ? null : executorTechnicianId,
          },
          include: { completedByUser: { select: { name: true } }, route: { select: { name: true } } },
        });

        const orderStatus = await refreshOrderStatus(tx, order);
        return { updatedItem, exec, orderStatus, alreadyCompleted: false };
      });

      afterExecute(plantId, order, [result], input.condition);

      return res.json({
        ...result.updatedItem,
        ...(result.exec
          ? { execution: result.exec.execution, nextDate: result.exec.nextDate, stock: result.exec.stock, shared: result.exec.shared }
          : {}),
        ...(result.exec?.inventoryWarning ? { inventoryWarning: result.exec.inventoryWarning } : {}),
        ...(result.orderStatus ? { orderStatus: result.orderStatus } : {}),
        ...(result.alreadyCompleted ? { alreadyCompleted: true } : {}),
      });
    } catch (err) {
      return sendError(res, err, "ITEM");
    }
  });

  // ── POST /api/preventive-orders/:id/items/complete-all ── (ejecutar todas las rutas pendientes)
  router.post("/:id/items/complete-all", async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const order = await findOrder(req.params.id, plantId);
      if (order.status === "COMPLETED" || order.status === "CANCELLED") {
        return res.status(400).json({ error: "La orden ya está cerrada" });
      }
      const executorTechnicianId = assertCanExecute(req, order);
      const input = parseItemInput({ ...req.body, status: "COMPLETED", usedQuantity: null, photoUrl: null });

      const items = await prisma.preventiveOrderItem.findMany({
        where: { preventiveOrderId: order.id, status: "PENDING" },
        include: { route: { select: { id: true, name: true, evidenceRequired: true } } },
        orderBy: { id: "asc" },
      });

      const results = [];
      for (const it of items) {
        if (order.requiresPhoto || it.route?.evidenceRequired) {
          results.push({ itemId: it.id, routeName: it.route?.name, ok: false, error: "Requiere foto de evidencia", code: "PHOTO_REQUIRED" });
          continue;
        }
        try {
          // Una transacción por ruta: si una falla (p. ej. stock), las demás sí se ejecutan.
          const r = await prisma.$transaction(async (tx) => {
            if (typeof tx.$queryRaw === "function") {
              await tx.$queryRaw`SELECT id FROM "PreventiveOrderItem" WHERE id = ${it.id} FOR UPDATE`;
            }
            const fresh = await tx.preventiveOrderItem.findFirst({ where: { id: it.id, preventiveOrderId: order.id } });
            if (!fresh || fresh.status !== "PENDING") return { skipped: true };
            const exec = await executeItem(tx, { order, item: fresh, plantId, executorTechnicianId, input });
            await tx.preventiveOrderItem.update({
              where: { id: it.id },
              data: { status: "COMPLETED", observations: input.observations, completedAt: new Date(), completedBy: executorTechnicianId },
            });
            return { exec };
          });
          if (!r.skipped) {
            results.push({ itemId: it.id, routeName: it.route?.name, ok: true, nextDate: r.exec.nextDate, stock: r.exec.stock, shared: r.exec.shared, inventoryWarning: r.exec.inventoryWarning || null, exec: r.exec });
          }
        } catch (err) {
          if (!(err instanceof HttpError)) logger.error(`[OLP COMPLETE_ALL] Orden #${order.id} item #${it.id}`, err);
          results.push({ itemId: it.id, routeName: it.route?.name, ok: false, error: err instanceof HttpError ? err.message : "Error al ejecutar la ruta" });
        }
      }

      const orderStatus = await prisma.$transaction((tx) => refreshOrderStatus(tx, order));
      afterExecute(plantId, order, results.filter((r) => r.ok), input.condition);

      return res.json({
        orderStatus,
        completed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results: results.map(({ exec, ...rest }) => rest),
      });
    } catch (err) {
      return sendError(res, err, "COMPLETE_ALL");
    }
  });

  /** Avisos después de ejecutar: stock bajo, condición crítica y advertencias de inventario. */
  function afterExecute(plantId, order, results, condition) {
    const lubIds = new Set();
    for (const r of results) {
      const exec = r.exec;
      if (!exec) continue;
      if (exec.deductedLubricantId) lubIds.add(exec.deductedLubricantId);
      if (exec.inventoryWarning) logger.warn(`[OLP] Orden #${order.id} ruta ${exec.routeName}: ${exec.inventoryWarning}`);
    }
    for (const lubricantId of lubIds) notifyIfLowStock(prisma, { plantId, lubricantId });
    const executed = results.filter((r) => r.exec);
    if (condition === "CRITICO" && executed.length) {
      notifyManagers(prisma, {
        plantId,
        type: "EXEC_CONDITION_CRITICAL",
        title: "Condición crítica en orden preventiva",
        message: `OLP #${order.id} · ${executed.map((r) => r.exec.routeName).join(", ")}`,
        link: `/preventive-orders/${order.id}`,
      }).catch((e) => logger.error("[OLP NOTIFY CRITICAL]", e));
    }
  }

  // ── PUT /api/preventive-orders/:id/complete ── (cerrar con firma)
  router.put("/:id/complete", async (req, res) => {
    try {
      const order = await findOrder(req.params.id, req.currentPlantId);
      if (order.status === "CANCELLED") {
        return res.status(400).json({ error: "La orden está cancelada" });
      }
      assertCanExecute(req, order);

      const pendingItems = await prisma.preventiveOrderItem.count({
        where: { preventiveOrderId: order.id, status: "PENDING" },
      });
      if (pendingItems > 0) {
        return res.status(400).json({
          error: `Faltan ${pendingItems} ruta(s) por ejecutar u omitir antes de cerrar la orden`,
        });
      }

      // La reprogramación de rutas ya se hizo al ejecutar cada ruta.
      const signatureImage = req.body?.signatureImage || null;
      const completedOrder = await prisma.preventiveOrder.update({
        where: { id: order.id },
        data: {
          status: "COMPLETED",
          completedAt: order.completedAt ?? new Date(),
          ...(signatureImage ? { signatureImage } : {}),
        },
        include: {
          items: { include: { route: { select: { id: true, name: true, nextDate: true, lastDate: true } } } },
        },
      });

      if (order.status !== "COMPLETED") {
        logAudit({ plantId: req.currentPlantId, userId: req.user.id, action: "STATE_CHANGE", model: "PreventiveOrder", recordId: order.id, changes: { before: { status: order.status }, after: { status: "COMPLETED" } }, ip: req.ip });
      }
      return res.json(completedOrder);
    } catch (err) {
      return sendError(res, err, "COMPLETE");
    }
  });

  return router;
}
