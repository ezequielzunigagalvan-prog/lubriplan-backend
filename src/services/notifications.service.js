import sseHub from "../realtime/sseHub.js";

const up = (v) => String(v || "").trim().toUpperCase();

export async function notifyManagers(prisma, payload) {
  const managers = await prisma.user.findMany({
    where: { role: { in: ["ADMIN", "SUPERVISOR"] }, active: true },
    select: { id: true },
  });

  if (!managers.length) return;

  // Guarda en DB
  await prisma.notification.createMany({
    data: managers.map((u) => ({
      userId: u.id,
      ...payload,
    })),
  });

  // 🔔 SSE: avisa a cada manager que hay nueva notificación
  for (const u of managers) {
    sseHub.send(u.id, "notification.created", {
      type: payload.type,
      title: payload.title,
      message: payload.message || "",
      link: payload.link || "",
      ts: Date.now(),
    });
  }
}

export async function notifyUser(prisma, userId, payload) {
  if (!userId) return;

  await prisma.notification.create({
    data: { userId, ...payload },
  });

  // 🔔 SSE: avisa al usuario
  sseHub.send(userId, "notification.created", {
    type: payload.type,
    title: payload.title,
    message: payload.message || "",
    link: payload.link || "",
    ts: Date.now(),
  });
}

export function isCriticalCondition(raw) {
  const c = up(raw);
  return c === "CRITICO" || c === "CRÍTICO" || c === "CRITICAL";
}