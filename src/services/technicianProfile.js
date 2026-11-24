// src/services/technicianProfile.js
// Perfiles de técnico por planta.
//
// Un usuario con rol TECHNICIAN tiene un perfil de técnico en cada planta donde trabaja
// (las actividades y rutas se asignan a perfiles de la planta). User.technicianId es su perfil
// principal; Technician.userId liga los perfiles de las demás plantas a la misma cuenta.

/** Perfil de técnico del usuario en la planta indicada (o null). */
export async function resolveTechnicianId(prisma, { userId, homeTechnicianId = null, plantId }) {
  if (!plantId) return homeTechnicianId ?? null;
  const or = [{ userId }];
  if (homeTechnicianId) or.push({ id: homeTechnicianId });
  const tech = await prisma.technician.findFirst({
    where: { plantId: Number(plantId), deletedAt: null, OR: or },
    // Si hubiera más de uno, gana el ligado explícitamente a la cuenta.
    orderBy: [{ userId: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return tech?.id ?? null;
}

/** Todos los perfiles de técnico de un usuario (uno por planta). */
export async function listTechnicianProfiles(prisma, user) {
  const or = [{ userId: user.id }];
  if (user.technicianId) or.push({ id: user.technicianId });
  return prisma.technician.findMany({
    where: { deletedAt: null, plantId: { gt: 0 }, OR: or },
    select: { id: true, plantId: true, code: true, name: true, status: true, userId: true },
    orderBy: { plantId: "asc" },
  });
}

export class ProfileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Asegura que el usuario técnico tenga perfil en la planta.
 *  - technicianId: liga un perfil existente de esa planta (debe estar libre).
 *  - si no se indica, reutiliza el que ya tenga; si no tiene, crea uno copiando los datos
 *    de su perfil principal (nombre, especialidad, contacto) con el mismo código si está libre.
 */
export async function ensureTechnicianProfile(tx, { user, plantId, technicianId = null, code = null }) {
  plantId = Number(plantId);

  if (technicianId) {
    const tech = await tx.technician.findFirst({
      where: { id: Number(technicianId), plantId, deletedAt: null },
      select: { id: true, userId: true, user: { select: { id: true } } },
    });
    if (!tech) throw new ProfileError("El técnico elegido no existe en esa planta");
    const ownerId = tech.userId ?? tech.user?.id ?? null;
    if (ownerId && ownerId !== user.id) throw new ProfileError("Ese técnico ya está ligado a otro usuario", 409);
    // Quita el vínculo de otro perfil del usuario en la misma planta, si lo hubiera.
    await tx.technician.updateMany({ where: { plantId, userId: user.id, id: { not: tech.id } }, data: { userId: null } });
    await tx.technician.update({ where: { id: tech.id }, data: { userId: user.id } });
    return { id: tech.id, created: false };
  }

  const existing = await tx.technician.findFirst({
    where: { plantId, deletedAt: null, OR: [{ userId: user.id }, ...(user.technicianId ? [{ id: user.technicianId }] : [])] },
    select: { id: true, userId: true },
  });
  if (existing) {
    if (!existing.userId) await tx.technician.update({ where: { id: existing.id }, data: { userId: user.id } });
    return { id: existing.id, created: false };
  }

  const home = user.technicianId
    ? await tx.technician.findFirst({ where: { id: user.technicianId, plantId: { gt: 0 } }, select: { name: true, code: true, specialty: true, email: true, phone: true } })
    : null;
  const wanted = String(code || home?.code || "").trim().toUpperCase();
  if (!wanted) throw new ProfileError("Indica el código del técnico para esa planta");
  const taken = await tx.technician.findFirst({ where: { plantId, code: wanted }, select: { id: true } });
  if (taken) throw new ProfileError(`El código ${wanted} ya existe en esa planta: elige el técnico existente o usa otro código`, 409);

  const created = await tx.technician.create({
    data: {
      plantId,
      code: wanted,
      name: home?.name || user.name,
      specialty: home?.specialty || "Lubricación",
      email: home?.email || user.email || null,
      phone: home?.phone || null,
      status: "Activo",
      userId: user.id,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}
