// src/notifications/notify.js
import { sseHub } from "../realtime/sseHub.js";
import { fireWebhookEvent } from "../services/webhooks.service.js";

export async function notifyUser(prisma, userId, payload) {
  const created = await prisma.notification.create({
    data: {
      userId: Number(userId),
      plantId: payload.plantId != null ? Number(payload.plantId) : null,
      type: payload.type,
      title: payload.title,
      message: payload.message || null,
      link: payload.link || null,
    },
  });

  sseHub.send(userId, "notification.created", {
    id: created.id,
    type: created.type,
    title: created.title,
    message: created.message,
    link: created.link,
    plantId: created.plantId ?? null,
    createdAt: created.createdAt,
  });

  return created;
}

export async function notifyTechnicianAssignee(prisma, payload) {
  const scopedPlantId =
    payload?.plantId != null && Number.isFinite(Number(payload.plantId))
      ? Number(payload.plantId)
      : null;
  const technicianId =
    payload?.technicianId != null && Number.isFinite(Number(payload.technicianId))
      ? Number(payload.technicianId)
      : null;

  if (!technicianId) return { notified: 0 };

  const user = await prisma.user.findFirst({
    where: {
      active: true,
      technicianId,
      ...(scopedPlantId != null
        ? {
            OR: [
              {
                technician: {
                  plantId: scopedPlantId,
                },
              },
              {
                userPlants: {
                  some: {
                    plantId: scopedPlantId,
                    active: true,
                  },
                },
              },
            ],
          }
        : {}),
    },
    select: { id: true },
  });

  if (!user?.id) return { notified: 0 };

  await notifyUser(prisma, user.id, {
    plantId: scopedPlantId,
    type: payload.type,
    title: payload.title,
    message: payload.message || null,
    link: payload.link || null,
  });

  return { notified: 1, userId: user.id };
}

export async function notifyManagers(prisma, payload) {
  const scopedPlantId = payload.plantId != null ? Number(payload.plantId) : null;

  const managers = await prisma.user.findMany({
    where: {
      active: true,
      role: { in: ["ADMIN", "SUPERVISOR"] },
      ...(Number.isFinite(scopedPlantId)
        ? {
            userPlants: {
              some: {
                plantId: scopedPlantId,
                active: true,
              },
            },
          }
        : {}),
    },
    select: { id: true },
  });

  const ids = managers.map((u) => u.id);
  if (!ids.length) return { notified: 0 };

  // Individual creates to obtain IDs for proper SSE payloads
  const created = await Promise.all(
    ids.map((userId) =>
      prisma.notification.create({
        data: {
          userId,
          plantId: Number.isFinite(scopedPlantId) ? scopedPlantId : null,
          type: payload.type,
          title: payload.title,
          message: payload.message || null,
          link: payload.link || null,
        },
      })
    )
  );

  for (const notif of created) {
    sseHub.send(notif.userId, "notification.created", {
      id: notif.id,
      type: notif.type,
      title: notif.title,
      message: notif.message,
      link: notif.link,
      plantId: notif.plantId ?? null,
      createdAt: notif.createdAt,
    });
  }

  return { notified: ids.length };
}

/**
 * Creates a LOW_STOCK notification only if no unread one exists for the same
 * lubricant (matched by name prefix in message) in the last 24 hours.
 * Prevents notification spam when stock drops repeatedly.
 */
export async function notifyLowStockIfNew(prisma, payload) {
  const scopedPlantId = payload.plantId != null ? Number(payload.plantId) : null;
  const lubricantName = String(payload.lubricantName || "").trim();

  if (Number.isFinite(scopedPlantId) && lubricantName) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await prisma.notification.findFirst({
      where: {
        plantId: scopedPlantId,
        type: "LOW_STOCK",
        message: { startsWith: lubricantName },
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (recent) return { notified: 0, deduped: true };
  }

  const result = await notifyManagers(prisma, payload);

  // Fire webhook for external integrations
  if (result.notified > 0 && Number.isFinite(scopedPlantId)) {
    fireWebhookEvent(prisma, scopedPlantId, "LUBRICANT_LOW_STOCK", {
      lubricantName,
      plantId: scopedPlantId,
    });
  }

  return result;
}
