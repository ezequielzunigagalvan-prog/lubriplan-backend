import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

// ============================================================
// NOTIFICATION CREATION & MANAGEMENT
// ============================================================

export async function createNotification(plantId, data) {
  const {
    userId,
    type,
    title,
    message,
    severity = "INFO",
    referenceId,
    referenceType,
    actionUrl,
    actionLabel,
  } = data;

  return await prisma.mtNotification.create({
    data: {
      plantId,
      userId,
      type,
      title,
      message,
      severity,
      referenceId,
      referenceType,
      actionUrl,
      actionLabel,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    },
  });
}

export async function getUserNotifications(plantId, userId, limit = 50) {
  return await prisma.mtNotification.findMany({
    where: {
      plantId,
      OR: [{ userId }, { userId: null }],
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function markNotificationAsRead(notificationId, plantId) {
  const notif = await prisma.mtNotification.findUnique({
    where: { id: notificationId },
  });

  if (!notif || notif.plantId !== plantId) {
    return null;
  }

  return await prisma.mtNotification.update({
    where: { id: notificationId },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });
}

export async function getUnreadCount(plantId, userId) {
  return await prisma.mtNotification.count({
    where: {
      plantId,
      OR: [{ userId }, { userId: null }],
      isRead: false,
      expiresAt: { gt: new Date() },
    },
  });
}

// ============================================================
// ALERT DETECTION & TRIGGER
// ============================================================

export async function checkLowStockAlerts(plantId) {
  const lowStockItems = await prisma.mtStock.findMany({
    where: {
      warehouse: { plantId },
      sparePart: { status: "ACTIVE" },
    },
    select: {
      id: true,
      quantity: true,
      sparePart: {
        select: { id: true, code: true, name: true, minStock: true },
      },
    },
  });

  const alerts = [];
  for (const item of lowStockItems) {
    if (item.quantity < item.sparePart.minStock) {
      // Check if alert already exists (not read in last 24h)
      const existingAlert = await prisma.mtNotification.findFirst({
        where: {
          plantId,
          type: "LOW_STOCK",
          referenceId: item.sparePart.id,
          isRead: false,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });

      if (!existingAlert) {
        const notif = await createNotification(plantId, {
          type: "LOW_STOCK",
          title: `📦 Stock bajo: ${item.sparePart.code}`,
          message: `${item.sparePart.name} está por debajo del mínimo (${item.quantity} < ${item.sparePart.minStock})`,
          severity: "WARNING",
          referenceId: item.sparePart.id,
          referenceType: "SPARE_PART",
          actionUrl: `/maintenance/app/inventory`,
          actionLabel: "Ir a Inventario",
        });
        alerts.push(notif);
      }
    }
  }

  return alerts;
}

export async function checkOverdueWorkOrders(plantId) {
  const overdueWOs = await prisma.mtWorkOrder.findMany({
    where: {
      plantId,
      dueAt: { lt: new Date() },
      status: { notIn: ["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"] },
    },
    select: {
      id: true,
      number: true,
      title: true,
      dueAt: true,
      status: true,
    },
  });

  const alerts = [];
  for (const wo of overdueWOs) {
    // Check if alert already exists
    const existingAlert = await prisma.mtNotification.findFirst({
      where: {
        plantId,
        type: "OVERDUE_WO",
        referenceId: wo.id,
        isRead: false,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    if (!existingAlert) {
      const daysOverdue = Math.floor((Date.now() - new Date(wo.dueAt)) / (1000 * 60 * 60 * 24));
      const notif = await createNotification(plantId, {
        type: "OVERDUE_WO",
        title: `⏰ OT Vencida: ${wo.number}`,
        message: `${wo.title} vence hace ${daysOverdue} días (Estado: ${wo.status})`,
        severity: "CRITICAL",
        referenceId: wo.id,
        referenceType: "WORK_ORDER",
        actionUrl: `/maintenance/app/work-orders/${wo.id}`,
        actionLabel: "Ver Orden",
      });
      alerts.push(notif);
    }
  }

  return alerts;
}

export async function checkTechnicianOverload(plantId) {
  const technicians = await prisma.technician.findMany({
    where: { plantId },
    select: {
      id: true,
      name: true,
      user: { select: { id: true } },
      assignedPreventiveOrders: {
        where: { status: { notIn: ["FINISHED", "CANCELLED"] } },
        select: { id: true },
      },
    },
  });

  const alerts = [];
  const CAPACITY_THRESHOLD = 5; // Max 5 open orders per tech

  for (const tech of technicians) {
    const openOrders = tech.assignedPreventiveOrders.length;

    if (openOrders > CAPACITY_THRESHOLD) {
      const existingAlert = await prisma.mtNotification.findFirst({
        where: {
          plantId,
          type: "TECHNICIAN_OVERLOAD",
          referenceId: tech.id,
          isRead: false,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });

      if (!existingAlert && tech.user?.id) {
        const notif = await createNotification(plantId, {
          userId: tech.user.id,
          type: "TECHNICIAN_OVERLOAD",
          title: `😰 Sobrecarga de trabajo: ${tech.name}`,
          message: `Tienes ${openOrders} órdenes abiertas (máximo recomendado: ${CAPACITY_THRESHOLD})`,
          severity: "WARNING",
          referenceId: tech.id,
          referenceType: "TECHNICIAN",
          actionUrl: `/maintenance/app/work-orders?assignedTo=${tech.id}`,
          actionLabel: "Ver mis órdenes",
        });
        alerts.push(notif);
      }
    }
  }

  return alerts;
}

export async function checkPreventivesSoon(plantId, daysAhead = 7) {
  const preventives = await prisma.mtPlan.findMany({
    where: {
      plantId,
      active: true,
      nextDueAt: {
        gte: new Date(),
        lte: new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000),
      },
    },
    select: {
      id: true,
      code: true,
      title: true,
      nextDueAt: true,
      asset: { select: { code: true, name: true } },
    },
  });

  const alerts = [];
  for (const plan of preventives) {
    const existingAlert = await prisma.mtNotification.findFirst({
      where: {
        plantId,
        type: "PREVENTIVE_SOON",
        referenceId: plan.id,
        isRead: false,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    if (!existingAlert) {
      const daysUntilDue = Math.ceil((new Date(plan.nextDueAt) - Date.now()) / (1000 * 60 * 60 * 24));
      const notif = await createNotification(plantId, {
        type: "PREVENTIVE_SOON",
        title: `🔧 Preventivo próximo: ${plan.asset.code}`,
        message: `${plan.title} vence en ${daysUntilDue} días (${new Date(plan.nextDueAt).toLocaleDateString()})`,
        severity: "INFO",
        referenceId: plan.id,
        referenceType: "PLAN",
        actionUrl: `/maintenance/app/assets/${plan.asset.code}`,
        actionLabel: "Ver Activo",
      });
      alerts.push(notif);
    }
  }

  return alerts;
}

export async function runAllAlertChecks(plantId) {
  const [lowStock, overdue, overload, preventives] = await Promise.all([
    checkLowStockAlerts(plantId),
    checkOverdueWorkOrders(plantId),
    checkTechnicianOverload(plantId),
    checkPreventivesSoon(plantId),
  ]);

  return {
    total: lowStock.length + overdue.length + overload.length + preventives.length,
    alerts: {
      lowStock: lowStock.length,
      overdue: overdue.length,
      technicianOverload: overload.length,
      preventivesSoon: preventives.length,
    },
  };
}

// ============================================================
// PREFERENCES
// ============================================================

export async function getOrCreatePreferences(userId, plantId) {
  let prefs = await prisma.mtNotificationPreference.findUnique({
    where: { userId },
  });

  if (!prefs) {
    prefs = await prisma.mtNotificationPreference.create({
      data: { userId, plantId },
    });
  }

  return prefs;
}

export async function updatePreferences(userId, plantId, data) {
  return await prisma.mtNotificationPreference.upsert({
    where: { userId },
    update: data,
    create: { userId, plantId, ...data },
  });
}
