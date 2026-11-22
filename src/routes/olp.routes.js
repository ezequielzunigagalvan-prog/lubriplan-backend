// src/routes/olp.routes.js
// Órdenes de Lubricación Preventiva (OLP) — /api/preventive-orders
//
// Antes vivían escritas directo en index.js, antes del rate-limit y del contexto de planta.
// Correcciones respecto a esa versión:
//  - Completar un punto corre en una transacción (ejecución + inventario + reprogramación).
//  - El descuento de inventario usa la misma regla que la ejecución normal:
//    cantidad por punto × puntos, conversión de bombazos y de unidades, y respeta preventNegativeStock.
//  - Completar dos veces el mismo punto ya no crea otra ejecución ni descuenta otra vez.
//  - La actividad pendiente/vencida de la ruta se mueve a la siguiente fecha (como la ejecución normal),
//    en vez de quedarse pendiente y volverse "vencida".
//  - Cerrar la orden guarda la firma y la fecha, y exige que no queden puntos pendientes.
//  - Nuevo PUT /:id para editar borradores (el frontend ya lo llamaba y recibía 404).
//  - El listado acepta from/to y equipmentId, y devuelve `meta` para la paginación del historial.

import { Router } from "express";
import { logger } from "../config/logger.js";
import { resolveNextRouteDate, startOfDay, endOfDay, toSafeNoon } from "../utils/routeScheduling.js";
import { computeRouteConsumption, round2 } from "../utils/units.js";
import { notifyIfLowStock } from "../services/inventory/lowStock.js";

const ORDER_STATUSES = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
const ITEM_STATUSES = ["PENDING", "COMPLETED", "SKIPPED"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sendError(res, err, tag) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(`[OLP ${tag}]`, err);
  return res.status(500).json({ error: "Error procesando la orden preventiva" });
}

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

/**
 * Reprograma la ruta después de ejecutarla y mueve su actividad pendiente/vencida
 * a la siguiente fecha. Misma regla que PATCH /api/executions/:id/complete.
 */
async function rescheduleRoute(tx, { route, plantId, executedAt, technicianId }) {
  const executedDay = startOfDay(executedAt);
  const nextRouteDate = resolveNextRouteDate({
    lastDate: executedDay,
    nextDate: null,
    frequencyDays: route.frequencyDays,
    frequencyType: route.frequencyType,
    weeklyDays: Array.isArray(route.weeklyDays) ? route.weeklyDays : [],
    monthlyAnchorDay: route.monthlyAnchorDay,
    customIntervalDays: route.customIntervalDays,
  });

  await tx.route.updateMany({
    where: { id: route.id, plantId },
    data: {
      lastDate: executedDay,
      nextDate: nextRouteDate,
      ...(technicianId ? { technicianId } : {}),
    },
  });

  if (!nextRouteDate) return nextRouteDate;

  const nd = toSafeNoon(nextRouteDate);
  const start = startOfDay(nd);
  const end = endOfDay(nd);

  const pending = await tx.execution.findFirst({
    where: { plantId, routeId: route.id, status: { in: ["PENDING", "OVERDUE"] } },
    orderBy: { scheduledAt: "asc" },
    select: { id: true },
  });

  const existingSameDay = await tx.execution.findFirst({
    where: {
      plantId,
      routeId: route.id,
      status: "PENDING",
      scheduledAt: { gte: start, lte: end },
      ...(pending ? { NOT: { id: pending.id } } : {}),
    },
    select: { id: true },
  });

  const assignTech = technicianId ?? route.technicianId ?? null;

  if (pending) {
    if (!existingSameDay) {
      await tx.execution.updateMany({
        where: { id: pending.id, plantId },
        data: { scheduledAt: nd, status: "PENDING", technicianId: assignTech, equipmentId: route.equipmentId },
      });
    } else {
      await tx.execution.deleteMany({ where: { id: pending.id, plantId } });
    }
  } else if (!existingSameDay) {
    await tx.execution.create({
      data: {
        plantId,
        routeId: route.id,
        equipmentId: route.equipmentId,
        technicianId: assignTech,
        status: "PENDING",
        scheduledAt: nd,
      },
    });
  }

  return nextRouteDate;
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

      const assignedTo = toId(req.query.assignedTo);
      if (assignedTo) where.assignedTo = assignedTo;

      const equipmentId = toId(req.query.equipmentId);
      if (equipmentId) where.equipmentId = equipmentId;

      // Rango de fechas: completadas por fecha de cierre, el resto por fecha programada.
      const from = req.query.from ? startOfDay(req.query.from) : null;
      const to = req.query.to ? endOfDay(req.query.to) : null;
      if (from || to) {
        const dateField = where.status === "COMPLETED" ? "completedAt" : "scheduledDate";
        where[dateField] = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      }

      const [orders, total] = await Promise.all([
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
            equipment: { select: { id: true, name: true } },
            assignedToUser: { select: { id: true, name: true } },
            _count: { select: { items: true } },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.preventiveOrder.count({ where }),
      ]);

      const completedCounts = orders.length
        ? await prisma.preventiveOrderItem.groupBy({
            by: ["preventiveOrderId"],
            where: { preventiveOrderId: { in: orders.map((o) => o.id) }, status: "COMPLETED" },
            _count: { _all: true },
          })
        : [];
      const completedById = new Map(completedCounts.map((r) => [r.preventiveOrderId, r._count._all]));

      const data = orders.map((order) => ({
        ...order,
        progress: { completed: completedById.get(order.id) || 0, total: order._count.items },
      }));

      const totalPages = Math.ceil(total / limit);
      return res.json({ data, total, page, totalPages, meta: { total, page, limit, totalPages } });
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
          equipment: { select: { id: true, name: true, code: true } },
          createdByUser: { select: { id: true, name: true } },
          assignedToUser: { select: { id: true, name: true } },
          items: {
            include: {
              route: {
                select: {
                  id: true,
                  name: true,
                  lubricantName: true,
                  lubricantType: true,
                  quantity: true,
                  unit: true,
                  frequencyType: true,
                  frequencyDays: true,
                  method: true,
                  instructions: true,
                  imageUrl: true,
                  weeklyDays: true,
                  lastDate: true,
                  nextDate: true,
                },
              },
              completedByUser: { select: { name: true } },
            },
          },
        },
      });

      if (!order) return res.status(404).json({ error: "Orden no encontrada" });
      return res.json(order);
    } catch (err) {
      return sendError(res, err, "DETAIL");
    }
  });

  // ── POST /api/preventive-orders ──
  router.post("/", managers, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const { scheduledDate, title, notes } = req.body || {};
      const equipmentId = toId(req.body?.equipmentId);

      if (!equipmentId || !scheduledDate) {
        return res.status(400).json({ error: "Equipo y fecha son requeridos" });
      }
      const date = new Date(scheduledDate);
      if (Number.isNaN(date.getTime())) return res.status(400).json({ error: "Fecha inválida" });

      const equipment = await prisma.equipment.findFirst({
        where: { id: equipmentId, plantId },
        select: { id: true },
      });
      if (!equipment) return res.status(404).json({ error: "Equipo no encontrado" });

      const assignedTo = await assertTechnicianInPlant(prisma, req.body?.assignedTo || null, plantId);

      const routes = await prisma.route.findMany({
        where: { equipmentId, plantId },
        select: { id: true },
      });
      if (!routes.length) {
        return res.status(400).json({ error: "El equipo no tiene rutas de lubricación" });
      }

      const order = await prisma.preventiveOrder.create({
        data: {
          plantId,
          equipmentId,
          title: title || `Preventivo ${date.toLocaleDateString("es-MX")}`,
          scheduledDate: date,
          status: "DRAFT",
          createdBy: req.user.id,
          assignedTo,
          notes: notes || null,
          requiresPhoto: false,
          items: { create: routes.map((r) => ({ routeId: r.id, status: "PENDING" })) },
        },
        include: { items: true },
      });

      return res.status(201).json(order);
    } catch (err) {
      return sendError(res, err, "CREATE");
    }
  });

  // ── PUT /api/preventive-orders/:id ── (editar borrador)
  router.put("/:id", managers, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const order = await findOrder(req.params.id, plantId);
      if (order.status !== "DRAFT") {
        return res.status(400).json({ error: "Solo se pueden editar órdenes en borrador" });
      }

      const body = req.body || {};
      const data = {};

      if (body.title !== undefined) data.title = String(body.title || "").trim() || order.title;
      if (body.notes !== undefined) data.notes = body.notes || null;
      if (body.scheduledDate !== undefined) {
        const date = new Date(body.scheduledDate);
        if (Number.isNaN(date.getTime())) return res.status(400).json({ error: "Fecha inválida" });
        data.scheduledDate = date;
      }
      if (body.assignedTo !== undefined) {
        data.assignedTo = await assertTechnicianInPlant(prisma, body.assignedTo || null, plantId);
      }

      const newEquipmentId = body.equipmentId !== undefined ? toId(body.equipmentId) : order.equipmentId;
      if (!newEquipmentId) return res.status(400).json({ error: "Equipo inválido" });

      const updated = await prisma.$transaction(async (tx) => {
        if (newEquipmentId !== order.equipmentId) {
          const equipment = await tx.equipment.findFirst({
            where: { id: newEquipmentId, plantId },
            select: { id: true },
          });
          if (!equipment) throw new HttpError(404, "Equipo no encontrado");

          const routes = await tx.route.findMany({
            where: { equipmentId: newEquipmentId, plantId },
            select: { id: true },
          });
          if (!routes.length) throw new HttpError(400, "El equipo no tiene rutas de lubricación");

          await tx.preventiveOrderItem.deleteMany({ where: { preventiveOrderId: order.id } });
          await tx.preventiveOrderItem.createMany({
            data: routes.map((r) => ({ preventiveOrderId: order.id, routeId: r.id, status: "PENDING" })),
          });
          data.equipmentId = newEquipmentId;
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
        return res.status(400).json({ error: "Solo se pueden eliminar borradores" });
      }
      await prisma.$transaction([
        prisma.preventiveOrderItem.deleteMany({ where: { preventiveOrderId: order.id } }),
        prisma.preventiveOrder.delete({ where: { id: order.id } }),
      ]);
      return res.json({ ok: true });
    } catch (err) {
      return sendError(res, err, "DELETE");
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
        include: { items: true },
      });
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
      if (!req.body?.assignedTo) return res.status(400).json({ error: "assignedTo es requerido" });

      const assignedTo = await assertTechnicianInPlant(prisma, req.body.assignedTo, plantId);

      const role = String(req.user?.role || "").toUpperCase();
      if (role === "TECHNICIAN" && assignedTo !== Number(req.user?.technicianId)) {
        return res.status(403).json({ error: "Solo puedes iniciar órdenes a tu nombre" });
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

  // ── PUT /api/preventive-orders/:id/items/:itemId ── (completar / omitir un punto)
  router.put("/:id/items/:itemId", async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const order = await findOrder(req.params.id, plantId);
      const itemId = toId(req.params.itemId);
      if (!itemId) return res.status(400).json({ error: "itemId inválido" });

      if (order.status === "COMPLETED" || order.status === "CANCELLED") {
        return res.status(400).json({ error: "La orden ya está cerrada" });
      }

      const role = String(req.user?.role || "").toUpperCase();
      const myTechnicianId = req.user?.technicianId != null ? Number(req.user.technicianId) : null;
      if (role === "TECHNICIAN" && order.assignedTo != null && order.assignedTo !== myTechnicianId) {
        return res.status(403).json({ error: "Esta orden está asignada a otro técnico" });
      }

      const status = String(req.body?.status || "COMPLETED").toUpperCase();
      if (!ITEM_STATUSES.includes(status)) return res.status(400).json({ error: "status inválido" });
      const observations = req.body?.observations ? String(req.body.observations) : null;
      const photoUrl = req.body?.photoUrl || null;

      // Quien ejecuta: el técnico logueado; si es supervisor, el técnico asignado a la orden.
      const executorTechnicianId = myTechnicianId ?? order.assignedTo ?? null;

      const result = await prisma.$transaction(async (tx) => {
        const item = await tx.preventiveOrderItem.findFirst({
          where: { id: itemId, preventiveOrderId: order.id },
        });
        if (!item) throw new HttpError(404, "Item no encontrado");

        let inventoryWarning = null;
        let deductedLubricantId = null;

        if (item.status === "COMPLETED") {
          // Ya se ejecutó: no se crea otra ejecución ni se descuenta otra vez.
          if (status !== "COMPLETED") {
            throw new HttpError(400, "Este punto ya fue ejecutado y no se puede revertir");
          }
          const same = await tx.preventiveOrderItem.update({
            where: { id: item.id },
            data: { observations: observations ?? item.observations, photoUrl: photoUrl ?? item.photoUrl },
            include: { completedByUser: { select: { name: true } }, route: { select: { name: true } } },
          });
          return { updatedItem: same, inventoryWarning, alreadyCompleted: true };
        }

        if (status === "COMPLETED") {
          const route = await tx.route.findFirst({ where: { id: item.routeId, plantId } });
          if (!route) throw new HttpError(404, "La ruta de este punto ya no existe");

          const executedAt = new Date();

          // Inventario
          let consumption = null;
          let lubricant = null;
          if (route.lubricantId) {
            lubricant = await tx.lubricant.findFirst({
              where: { id: route.lubricantId, plantId },
              select: { id: true, name: true, unit: true, stock: true },
            });
          }
          if (lubricant) {
            consumption = computeRouteConsumption(route, lubricant.unit);
            if (!consumption.ok) {
              inventoryWarning = `No se descontó inventario: ${consumption.reason}`;
              consumption = null;
            } else {
              const settings = await tx.appSettings.findUnique({
                where: { id: 1 },
                select: { preventNegativeStock: true },
              });
              const preventNegativeStock = settings?.preventNegativeStock ?? true;
              const stockAfterPreview = Number(lubricant.stock || 0) - consumption.inventoryQuantity;
              if (preventNegativeStock && stockAfterPreview < 0) {
                throw new HttpError(
                  400,
                  `Stock insuficiente de ${lubricant.name}: hay ${round2(lubricant.stock)} ${consumption.inventoryUnit}, se requieren ${consumption.inventoryQuantity}`
                );
              }
            }
          } else if (Number(route.quantity) > 0) {
            inventoryWarning = "No se descontó inventario: la ruta no tiene lubricante de inventario asignado";
          }

          const execution = await tx.execution.create({
            data: {
              plantId,
              routeId: route.id,
              equipmentId: route.equipmentId,
              technicianId: executorTechnicianId,
              origin: "MANUAL",
              sourceType: "OLP",
              status: "COMPLETED",
              scheduledAt: order.scheduledDate || executedAt,
              executedAt,
              observations,
              evidenceImage: photoUrl,
              evidenceNote: `Ejecutado desde Orden Preventiva #${order.id}`,
              condition: "NORMAL",
              usedQuantity: consumption ? consumption.inputQuantity : null,
              usedInputQuantity: consumption ? consumption.inputQuantity : null,
              usedInputUnit: consumption ? consumption.inputUnit : null,
              usedConvertedQuantity: consumption ? consumption.convertedQuantity : null,
              usedConvertedUnit: consumption ? consumption.convertedUnit : null,
              inventoryDeductedAt: consumption ? executedAt : null,
            },
          });

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
                note: [
                  `OLP #${order.id}`,
                  `Ejecucion #${execution.id}`,
                  `Ruta: ${route.name}`,
                  `Final: ${consumption.convertedQuantity} ${consumption.convertedUnit}`,
                ].join(" | "),
                stockBefore,
                stockAfter,
              },
            });
            deductedLubricantId = lubricant.id;
          }

          await rescheduleRoute(tx, { route, plantId, executedAt, technicianId: executorTechnicianId });
        }

        const updatedItem = await tx.preventiveOrderItem.update({
          where: { id: item.id },
          data: {
            status,
            observations,
            photoUrl,
            completedAt: status === "COMPLETED" ? new Date() : null,
            completedBy: status === "COMPLETED" ? executorTechnicianId : null,
          },
          include: { completedByUser: { select: { name: true } }, route: { select: { name: true } } },
        });

        // Estado de la orden: en proceso al primer avance; completada cuando no quedan pendientes.
        const pendingItems = await tx.preventiveOrderItem.count({
          where: { preventiveOrderId: order.id, status: "PENDING" },
        });
        if (pendingItems === 0) {
          await tx.preventiveOrder.update({
            where: { id: order.id },
            data: { status: "COMPLETED", completedAt: new Date() },
          });
        } else if (order.status === "OPEN" || order.status === "DRAFT") {
          await tx.preventiveOrder.update({
            where: { id: order.id },
            data: { status: "IN_PROGRESS" },
          });
        }

        return { updatedItem, inventoryWarning, alreadyCompleted: false, deductedLubricantId };
      });

      if (result.deductedLubricantId) {
        notifyIfLowStock(prisma, { plantId, lubricantId: result.deductedLubricantId });
      }

      if (result.inventoryWarning) {
        logger.warn(`[OLP] Orden #${order.id} item #${itemId}: ${result.inventoryWarning}`);
      }

      return res.json({
        ...result.updatedItem,
        ...(result.inventoryWarning ? { inventoryWarning: result.inventoryWarning } : {}),
        ...(result.alreadyCompleted ? { alreadyCompleted: true } : {}),
      });
    } catch (err) {
      return sendError(res, err, "ITEM");
    }
  });

  // ── PUT /api/preventive-orders/:id/complete ── (cerrar con firma)
  router.put("/:id/complete", async (req, res) => {
    try {
      const order = await findOrder(req.params.id, req.currentPlantId);
      if (order.status === "CANCELLED") {
        return res.status(400).json({ error: "La orden está cancelada" });
      }

      const role = String(req.user?.role || "").toUpperCase();
      const myTechnicianId = req.user?.technicianId != null ? Number(req.user.technicianId) : null;
      if (role === "TECHNICIAN" && order.assignedTo != null && order.assignedTo !== myTechnicianId) {
        return res.status(403).json({ error: "Esta orden está asignada a otro técnico" });
      }

      const pendingItems = await prisma.preventiveOrderItem.count({
        where: { preventiveOrderId: order.id, status: "PENDING" },
      });
      if (pendingItems > 0) {
        return res.status(400).json({
          error: `Faltan ${pendingItems} punto(s) por completar u omitir antes de cerrar la orden`,
        });
      }

      // La reprogramación de rutas ya se hizo al completar cada punto.
      const signatureImage = req.body?.signatureImage || null;
      const completedOrder = await prisma.preventiveOrder.update({
        where: { id: order.id },
        data: {
          status: "COMPLETED",
          completedAt: order.completedAt ?? new Date(),
          ...(signatureImage ? { signatureImage } : {}),
        },
        include: {
          items: {
            include: {
              route: {
                select: {
                  id: true,
                  name: true,
                  frequencyType: true,
                  frequencyDays: true,
                  weeklyDays: true,
                  monthlyAnchorDay: true,
                },
              },
            },
          },
        },
      });

      return res.json(completedOrder);
    } catch (err) {
      return sendError(res, err, "COMPLETE");
    }
  });

  return router;
}
