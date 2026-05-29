// src/routes/purchaseOrders.routes.js
import express from "express";
import { createAuditLog } from "../services/auditLog.service.js";
import { fireWebhookEvent } from "../services/webhooks.service.js";
import { logger } from "../config/logger.js";

export default function purchaseOrdersRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // GET /api/purchase-orders
  router.get("/purchase-orders", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const status = req.query.status ? String(req.query.status).toUpperCase() : null;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
      const offset = Math.max(0, Number(req.query.offset || 0));

      const where = { plantId, ...(status ? { status } : {}) };

      const [items, total] = await Promise.all([
        prisma.purchaseOrder.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
          include: {
            requestedBy: { select: { id: true, name: true, email: true } },
            approvedBy: { select: { id: true, name: true, email: true } },
            items: {
              include: { lubricant: { select: { id: true, name: true, unit: true, stock: true } } },
            },
          },
        }),
        prisma.purchaseOrder.count({ where }),
      ]);

      return res.json({ ok: true, items, total });
    } catch (e) {
      logger.error("GET /purchase-orders error:", e);
      return res.status(500).json({ error: "Error cargando órdenes de compra" });
    }
  });

  // GET /api/purchase-orders/:id
  router.get("/purchase-orders/:id", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const order = await prisma.purchaseOrder.findFirst({
        where: { id, plantId },
        include: {
          requestedBy: { select: { id: true, name: true, email: true } },
          approvedBy: { select: { id: true, name: true, email: true } },
          items: {
            include: { lubricant: { select: { id: true, name: true, unit: true, stock: true, minStock: true } } },
          },
        },
      });

      if (!order) return res.status(404).json({ error: "Orden no encontrada" });
      return res.json({ ok: true, order });
    } catch (e) {
      logger.error("GET /purchase-orders/:id error:", e);
      return res.status(500).json({ error: "Error cargando orden" });
    }
  });

  // POST /api/purchase-orders
  router.post("/purchase-orders", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const { notes, expectedDate, items } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Se requiere al menos un ítem" });
      }

      for (const item of items) {
        if (!item.lubricantId || !item.requestedQty || !item.unit) {
          return res.status(400).json({ error: "Cada ítem requiere lubricantId, requestedQty y unit" });
        }
      }

      const order = await prisma.purchaseOrder.create({
        data: {
          plantId,
          requestedById: req.user.id,
          notes: notes || null,
          expectedDate: expectedDate ? new Date(expectedDate) : null,
          status: "DRAFT",
          items: {
            create: items.map((item) => ({
              lubricantId: Number(item.lubricantId),
              requestedQty: Number(item.requestedQty),
              unit: String(item.unit),
              unitCost: item.unitCost != null ? Number(item.unitCost) : null,
              notes: item.notes || null,
            })),
          },
        },
        include: {
          items: { include: { lubricant: { select: { id: true, name: true, unit: true } } } },
        },
      });

      await createAuditLog(prisma, {
        plantId, userId: req.user.id, userEmail: req.user.email,
        action: "CREATE", model: "PurchaseOrder", recordId: order.id,
        changes: { after: { status: order.status, itemCount: order.items.length } },
      });

      return res.status(201).json({ ok: true, order });
    } catch (e) {
      logger.error("POST /purchase-orders error:", e);
      return res.status(500).json({ error: "Error creando orden de compra" });
    }
  });

  // PATCH /api/purchase-orders/:id/request  — DRAFT → REQUESTED
  router.patch("/purchase-orders/:id/request", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.purchaseOrder.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Orden no encontrada" });
      if (existing.status !== "DRAFT") return res.status(400).json({ error: "Solo se puede solicitar una orden en DRAFT" });

      const order = await prisma.purchaseOrder.update({
        where: { id },
        data: { status: "REQUESTED" },
      });

      await createAuditLog(prisma, {
        plantId, userId: req.user.id, userEmail: req.user.email,
        action: "UPDATE", model: "PurchaseOrder", recordId: id,
        changes: { before: { status: "DRAFT" }, after: { status: "REQUESTED" } },
      });

      return res.json({ ok: true, order });
    } catch (e) {
      logger.error("PATCH /purchase-orders/:id/request error:", e);
      return res.status(500).json({ error: "Error solicitando orden" });
    }
  });

  // PATCH /api/purchase-orders/:id/approve  — REQUESTED → APPROVED (solo ADMIN)
  router.patch("/purchase-orders/:id/approve", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.purchaseOrder.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Orden no encontrada" });
      if (existing.status !== "REQUESTED") return res.status(400).json({ error: "Solo se puede aprobar una orden en REQUESTED" });

      const order = await prisma.purchaseOrder.update({
        where: { id },
        data: { status: "APPROVED", approvedById: req.user.id, approvedAt: new Date() },
        include: { items: { include: { lubricant: { select: { id: true, name: true } } } } },
      });

      await createAuditLog(prisma, {
        plantId, userId: req.user.id, userEmail: req.user.email,
        action: "UPDATE", model: "PurchaseOrder", recordId: id,
        changes: { before: { status: "REQUESTED" }, after: { status: "APPROVED" } },
      });

      fireWebhookEvent(prisma, plantId, "PURCHASE_ORDER_APPROVED", {
        purchaseOrderId: id,
        itemCount: order.items.length,
        approvedBy: req.user.id,
      });

      return res.json({ ok: true, order });
    } catch (e) {
      logger.error("PATCH /purchase-orders/:id/approve error:", e);
      return res.status(500).json({ error: "Error aprobando orden" });
    }
  });

  // PATCH /api/purchase-orders/:id/receive  — APPROVED → RECEIVED + descuenta stock
  router.patch("/purchase-orders/:id/receive", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.purchaseOrder.findFirst({
        where: { id, plantId },
        include: { items: { include: { lubricant: true } } },
      });
      if (!existing) return res.status(404).json({ error: "Orden no encontrada" });
      if (existing.status !== "APPROVED") return res.status(400).json({ error: "Solo se puede recibir una orden APPROVED" });

      // itemsReceived puede venir en el body para cantidades parciales
      const receivedItems = req.body.items; // [{ purchaseOrderItemId, receivedQty }]

      await prisma.$transaction(async (tx) => {
        for (const orderItem of existing.items) {
          const override = Array.isArray(receivedItems)
            ? receivedItems.find((r) => r.purchaseOrderItemId === orderItem.id)
            : null;
          const qty = override ? Number(override.receivedQty) : Number(orderItem.requestedQty);
          if (qty <= 0) continue;

          const lubricant = orderItem.lubricant;
          const stockBefore = Number(lubricant.stock || 0);
          const stockAfter = stockBefore + qty;

          await tx.lubricant.update({
            where: { id: lubricant.id },
            data: { stock: stockAfter },
          });

          await tx.lubricantMovement.create({
            data: {
              lubricantId: lubricant.id,
              type: "IN",
              quantity: qty,
              reason: `Recepción orden de compra #${id}`,
              stockBefore,
              stockAfter,
            },
          });

          await tx.purchaseOrderItem.update({
            where: { id: orderItem.id },
            data: { receivedQty: qty },
          });
        }

        await tx.purchaseOrder.update({
          where: { id },
          data: { status: "RECEIVED", receivedAt: new Date() },
        });
      });

      await createAuditLog(prisma, {
        plantId, userId: req.user.id, userEmail: req.user.email,
        action: "UPDATE", model: "PurchaseOrder", recordId: id,
        changes: { before: { status: "APPROVED" }, after: { status: "RECEIVED" } },
      });

      fireWebhookEvent(prisma, plantId, "PURCHASE_ORDER_RECEIVED", { purchaseOrderId: id });

      return res.json({ ok: true });
    } catch (e) {
      logger.error("PATCH /purchase-orders/:id/receive error:", e);
      return res.status(500).json({ error: "Error recibiendo orden" });
    }
  });

  // PATCH /api/purchase-orders/:id/cancel
  router.patch("/purchase-orders/:id/cancel", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.purchaseOrder.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Orden no encontrada" });
      if (["RECEIVED", "CANCELLED"].includes(existing.status)) {
        return res.status(400).json({ error: "No se puede cancelar una orden ya recibida o cancelada" });
      }

      await prisma.purchaseOrder.update({ where: { id }, data: { status: "CANCELLED" } });

      await createAuditLog(prisma, {
        plantId, userId: req.user.id, userEmail: req.user.email,
        action: "UPDATE", model: "PurchaseOrder", recordId: id,
        changes: { before: { status: existing.status }, after: { status: "CANCELLED" } },
      });

      return res.json({ ok: true });
    } catch (e) {
      logger.error("PATCH /purchase-orders/:id/cancel error:", e);
      return res.status(500).json({ error: "Error cancelando orden" });
    }
  });

  // DELETE /api/purchase-orders/:id  — solo DRAFT
  router.delete("/purchase-orders/:id", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.purchaseOrder.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Orden no encontrada" });
      if (existing.status !== "DRAFT") return res.status(400).json({ error: "Solo se pueden eliminar órdenes en DRAFT" });

      await prisma.purchaseOrder.delete({ where: { id } });
      return res.json({ ok: true });
    } catch (e) {
      logger.error("DELETE /purchase-orders/:id error:", e);
      return res.status(500).json({ error: "Error eliminando orden" });
    }
  });

  return router;
}
