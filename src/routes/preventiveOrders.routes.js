import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requirePlantAccess } from "../middleware/requirePlantAccess.js";
import { resolveNextRouteDate } from "../utils/routeScheduling.js";

export default function preventiveOrdersRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // Middleware: verificar autenticación y acceso a planta
  router.use(auth);
  router.use(requirePlantAccess);

  // ==========================================
  // POST /api/preventive-orders
  // Crear nueva orden de lubricación preventiva
  // ==========================================
  router.post("/", async (req, res) => {
    const { equipmentId, scheduledDate, title, notes } = req.body;
    const plantId = req.currentPlantId;
    const userId = req.user.id;

    if (!equipmentId || !scheduledDate) {
      return res.status(400).json({ error: "equipmentId y scheduledDate son requeridos" });
    }

    try {
      const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } });
      if (!equipment || equipment.plantId !== plantId) {
        return res.status(404).json({ error: "Equipo no encontrado" });
      }

      // Obtener todas las rutas del equipo
      const routes = await prisma.route.findMany({
        where: { equipmentId, isEmergency: false },
        select: { id: true },
      });

      // Crear la orden con sus items
      const order = await prisma.preventiveOrder.create({
        data: {
          plantId,
          equipmentId,
          title: title || `Orden de ${equipment.name}`,
          scheduledDate: new Date(scheduledDate),
          createdBy: userId,
          notes,
          requiresPhoto: (await prisma.appSettings.findUnique({ where: { id: 1 } }))?.requiresPhotoOLP || false,
          items: {
            create: routes.map((r) => ({ routeId: r.id })),
          },
        },
        include: { items: { include: { route: { select: { name: true } } } } },
      });

      res.json(order);
    } catch (err) {
      console.error("Error creating preventive order:", err);
      res.status(500).json({ error: "No se pudo crear la orden" });
    }
  });

  // ==========================================
  // GET /api/preventive-orders
  // Listar órdenes de la planta actual
  // ==========================================
  router.get('/', auth, requireRole(['ADMIN', 'SUPERVISOR', 'TECHNICIAN']), async (req, res) => {
    try {
      const plantId = req.currentPlantId ||
        (req.headers['x-plant-id'] ? parseInt(req.headers['x-plant-id']) : null);

      if (!plantId) {
        return res.json({ data: [], total: 0, page: 1, totalPages: 0 });
      }

      if (!prisma.preventiveOrder) {
        return res.json({ data: [], total: 0, page: 1, totalPages: 0 });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const skip = (page - 1) * limit;
      const status = req.query.status || null;

      const where = {
        plantId,
        ...(status && { status }),
        ...(req.query.assignedTo && { assignedTo: parseInt(req.query.assignedTo) }),
      };

      // Agregar filtro de fecha si se proporciona from y/o to
      if (req.query.from || req.query.to) {
        where.completedAt = {};
        if (req.query.from) {
          where.completedAt.gte = new Date(req.query.from);
        }
        if (req.query.to) {
          where.completedAt.lte = new Date(req.query.to);
        }
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
            equipment: { select: { id: true, name: true } },
            assignedToUser: { select: { id: true, name: true } },
            _count: { select: { items: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.preventiveOrder.count({ where }),
      ]);

      const ordersWithProgress = await Promise.all(
        orders.map(async (order) => {
          const completedItems = await prisma.preventiveOrderItem.count({
            where: { preventiveOrderId: order.id, status: 'COMPLETED' }
          });
          return {
            ...order,
            progress: { completed: completedItems, total: order._count.items }
          };
        })
      );

      return res.json({
        data: ordersWithProgress,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error('[OLP] Error GET /preventive-orders:', err.message);
      return res.json({ data: [], total: 0, page: 1, totalPages: 0 });
    }
  });

  // ==========================================
  // GET /api/preventive-orders/:id
  // Obtener detalle de una orden
  // ==========================================
  router.get("/:id", async (req, res) => {
    const { id } = req.params;
    const plantId = req.currentPlantId;

    try {
      const order = await prisma.preventiveOrder.findUnique({
        where: { id: Number(id) },
        include: {
          plant: { select: { name: true } },
          equipment: { select: { id: true, name: true, code: true } },
          createdByUser: { select: { name: true } },
          assignedToUser: { select: { id: true, name: true } },
          items: {
            include: {
              route: {
                select: {
                  id: true,
                  name: true,
                  frequencyType: true,
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

      if (!order || order.plantId !== plantId) {
        return res.status(404).json({ error: "Orden no encontrada" });
      }

      res.json(order);
    } catch (err) {
      console.error("Error fetching preventive order:", err);
      res.status(500).json({ error: "No se pudo obtener la orden" });
    }
  });

  // ==========================================
  // PUT /api/preventive-orders/:id
  // Actualizar orden (DRAFT → editable)
  // ==========================================
  router.put("/:id", async (req, res) => {
    const { id } = req.params;
    const { title, notes, assignedTo } = req.body;
    const plantId = req.currentPlantId;

    try {
      const order = await prisma.preventiveOrder.findUnique({
        where: { id: Number(id) },
        select: { plantId, status: true },
      });

      if (!order || order.plantId !== plantId) {
        return res.status(404).json({ error: "Orden no encontrada" });
      }

      if (order.status !== "DRAFT") {
        return res.status(400).json({ error: "Solo se pueden editar órdenes en DRAFT" });
      }

      const updated = await prisma.preventiveOrder.update({
        where: { id: Number(id) },
        data: {
          ...(title && { title }),
          ...(notes !== undefined && { notes }),
          ...(assignedTo && { assignedTo: Number(assignedTo) }),
        },
        include: { items: { include: { route: { select: { name: true } } } } },
      });

      res.json(updated);
    } catch (err) {
      console.error("Error updating preventive order:", err);
      res.status(500).json({ error: "No se pudo actualizar la orden" });
    }
  });

  // ==========================================
  // PUT /api/preventive-orders/:id/open
  // Cambiar estado a OPEN (disponible para asignación)
  // ==========================================
  router.put("/:id/open", async (req, res) => {
    const { id } = req.params;
    const plantId = req.currentPlantId;

    try {
      const order = await prisma.preventiveOrder.findUnique({
        where: { id: Number(id) },
        select: { plantId, status: true },
      });

      if (!order || order.plantId !== plantId) {
        return res.status(404).json({ error: "Orden no encontrada" });
      }

      if (order.status !== "DRAFT") {
        return res.status(400).json({ error: "Solo se pueden abrir órdenes en DRAFT" });
      }

      const updated = await prisma.preventiveOrder.update({
        where: { id: Number(id) },
        data: { status: "OPEN" },
        include: { items: true },
      });

      res.json(updated);
    } catch (err) {
      console.error("Error opening preventive order:", err);
      res.status(500).json({ error: "No se pudo abrir la orden" });
    }
  });

  // ==========================================
  // PUT /api/preventive-orders/:id/start
  // Cambiar estado a IN_PROGRESS (asignada a técnico)
  // ==========================================
  router.put("/:id/start", async (req, res) => {
    const { id } = req.params;
    const { assignedTo } = req.body;
    const plantId = req.currentPlantId;

    if (!assignedTo) {
      return res.status(400).json({ error: "assignedTo es requerido" });
    }

    try {
      const order = await prisma.preventiveOrder.findUnique({
        where: { id: Number(id) },
        select: { plantId, status: true },
      });

      if (!order || order.plantId !== plantId) {
        return res.status(404).json({ error: "Orden no encontrada" });
      }

      if (!["DRAFT", "OPEN"].includes(order.status)) {
        return res.status(400).json({ error: "Solo se pueden iniciar órdenes en DRAFT u OPEN" });
      }

      const updated = await prisma.preventiveOrder.update({
        where: { id: Number(id) },
        data: { status: "IN_PROGRESS", assignedTo: Number(assignedTo) },
        include: { assignedToUser: { select: { name: true } } },
      });

      res.json(updated);
    } catch (err) {
      console.error("Error starting preventive order:", err);
      res.status(500).json({ error: "No se pudo iniciar la orden" });
    }
  });

  // ==========================================
  // PUT /api/preventive-orders/:id/items/:itemId
  // Marcar item como COMPLETED y crear Execution
  // ==========================================
  router.put("/:id/items/:itemId", async (req, res) => {
    const { id, itemId } = req.params;
    const { status, observations, photoUrl } = req.body;
    const plantId = req.currentPlantId;
    const userId = req.user.id;

    try {
      // Verificar que la orden existe y pertenece a esta planta
      const order = await prisma.preventiveOrder.findUnique({
        where: { id: Number(id) },
        select: { plantId, equipmentId },
      });

      if (!order || order.plantId !== plantId) {
        return res.status(404).json({ error: "Orden no encontrada" });
      }

      // Actualizar el item
      const item = await prisma.preventiveOrderItem.update({
        where: { id: Number(itemId) },
        data: {
          status: status || "COMPLETED",
          observations,
          photoUrl,
          ...(status === "COMPLETED" && { completedAt: new Date(), completedBy: req.user.technicianId || null }),
        },
        include: {
          route: {
            select: {
              id: true,
              lastDate: true,
              nextDate: true,
              frequencyDays: true,
              frequencyType: true,
              weeklyDays: true,
              monthlyAnchorDay: true,
            },
          },
        },
      });

      // Si está COMPLETED, crear Execution y recalcular nextDate de ruta
      if (status === "COMPLETED") {
        const route = item.route;

        // Calcular nextDate
        const nextDate = resolveNextRouteDate({
          lastDate: new Date(),
          nextDate: null,
          frequencyDays: route.frequencyDays,
          frequencyType: route.frequencyType,
          weeklyDays: route.weeklyDays,
          monthlyAnchorDay: route.monthlyAnchorDay,
        });

        // Validar que se calculó correctamente
        if (!nextDate) {
          console.error(`[OLP] No se pudo calcular nextDate para route ${route.id}`, {
            frequencyType: route.frequencyType,
            frequencyDays: route.frequencyDays,
          });
          return res.status(400).json({
            error: `No se pudo calcular próxima fecha para la ruta. Verifica su configuración de frecuencia.`,
          });
        }

        // Crear Execution con sourceType='OLP'
        await prisma.execution.create({
          data: {
            plantId,
            origin: "ONE_OFF",
            sourceType: "OLP",  // Enum ExecutionSourceType.OLP
            routeId: route.id,
            equipmentId: order.equipmentId,
            technicianId: userId,
            status: "COMPLETED",
            scheduledAt: new Date(),
            executedAt: new Date(),
            observations,
            condition: "OK",
          },
        });

        // Actualizar ruta con nuevos lastDate y nextDate
        await prisma.route.update({
          where: { id: route.id },
          data: {
            lastDate: new Date(),
            nextDate: nextDate || route.nextDate,
          },
        });
      }

      res.json(item);
    } catch (err) {
      console.error("Error updating preventive order item:", err);
      res.status(500).json({ error: "No se pudo actualizar el item" });
    }
  });

  // ==========================================
  // PUT /api/preventive-orders/:id/complete
  // Completar orden (firmar y cambiar estado a COMPLETED)
  // ==========================================
  router.put("/:id/complete", async (req, res) => {
    const { id } = req.params;
    const { signatureImage } = req.body;
    const plantId = req.currentPlantId;

    try {
      const order = await prisma.preventiveOrder.findUnique({
        where: { id: Number(id) },
        select: { plantId, status: true },
      });

      if (!order || order.plantId !== plantId) {
        return res.status(404).json({ error: "Orden no encontrada" });
      }

      if (order.status !== "IN_PROGRESS") {
        return res.status(400).json({ error: "Solo se pueden completar órdenes en IN_PROGRESS" });
      }

      const updated = await prisma.preventiveOrder.update({
        where: { id: Number(id) },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          ...(signatureImage && { signatureImage }),
        },
        include: {
          equipment: { select: { name: true } },
          items: { select: { id: true, status: true, route: { select: { name: true } } } },
        },
      });

      res.json(updated);
    } catch (err) {
      console.error("Error completing preventive order:", err);
      res.status(500).json({ error: "No se pudo completar la orden" });
    }
  });

  // ==========================================
  // DELETE /api/preventive-orders/:id
  // Cancelar orden (solo en ciertos estados)
  // ==========================================
  router.delete("/:id", async (req, res) => {
    const { id } = req.params;
    const plantId = req.currentPlantId;

    try {
      const order = await prisma.preventiveOrder.findUnique({
        where: { id: Number(id) },
        select: { plantId, status: true },
      });

      if (!order || order.plantId !== plantId) {
        return res.status(404).json({ error: "Orden no encontrada" });
      }

      if (!["DRAFT", "OPEN"].includes(order.status)) {
        return res.status(400).json({ error: "Solo se pueden eliminar órdenes en DRAFT u OPEN" });
      }

      // Cambiar a CANCELLED en lugar de eliminar (auditoría)
      const updated = await prisma.preventiveOrder.update({
        where: { id: Number(id) },
        data: { status: "CANCELLED" },
      });

      res.json(updated);
    } catch (err) {
      console.error("Error cancelling preventive order:", err);
      res.status(500).json({ error: "No se pudo cancelar la orden" });
    }
  });

  return router;
}
