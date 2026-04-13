// src/notifications/notify.js
import { sseHub } from "../realtime/sseHub.js";

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

  await prisma.notification.createMany({
    data: ids.map((id) => ({
      userId: id,
      plantId: Number.isFinite(scopedPlantId) ? scopedPlantId : null,
      type: payload.type,
      title: payload.title,
      message: payload.message || null,
      link: payload.link || null,
    })),
  });

  for (const id of ids) {
    sseHub.send(id, "notification.created", {
      refresh: true,
      plantId: Number.isFinite(scopedPlantId) ? scopedPlantId : null,
      type: payload.type,
      title: payload.title,
      message: payload.message || null,
      link: payload.link || null,
      createdAt: new Date().toISOString(),
    });
  }

  return { notified: ids.length };
}
