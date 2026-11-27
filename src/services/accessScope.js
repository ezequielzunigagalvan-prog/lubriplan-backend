// src/services/accessScope.js
// Alcance de un usuario entre clientes.
//
// No hay un modelo de "empresa": un cliente son sus plantas y sus usuarios. Un ADMIN de un cliente
// solo ve y administra las plantas donde tiene acceso (UserPlant) y a los usuarios que viven solo
// en esas plantas. El dueño de la plataforma (User.isPlatformOwner) es el único que ve todo y el
// único que da de alta clientes, desde su consola aparte.

export class ScopeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const isPlatformOwner = (user) => user?.isPlatformOwner === true;

/** Plantas activas del usuario. null = todas (dueño de la plataforma). */
export async function scopePlantIds(prisma, user) {
  if (isPlatformOwner(user)) return null;
  const links = await prisma.userPlant.findMany({
    where: { userId: user.id, active: true, plant: { active: true } },
    select: { plantId: true },
  });
  return links.map((l) => l.plantId);
}

/** ¿La planta está dentro del alcance del usuario? */
export async function canAccessPlant(prisma, user, plantId) {
  const ids = await scopePlantIds(prisma, user);
  return ids === null || ids.includes(Number(plantId));
}

/**
 * ¿Puede administrar a este usuario? Solo si todas las plantas del usuario están dentro de su
 * alcance y no es el dueño de la plataforma. Así un admin de un cliente no puede cambiar la
 * contraseña, el rol o el acceso de alguien de otro cliente.
 */
export async function assertCanManageUser(prisma, actor, targetUserId) {
  const target = await prisma.user.findUnique({
    where: { id: Number(targetUserId) },
    select: { id: true, isPlatformOwner: true, userPlants: { select: { plantId: true } } },
  });
  if (!target) throw new ScopeError(404, "El usuario no existe");
  if (isPlatformOwner(actor)) return target;
  if (target.isPlatformOwner) throw new ScopeError(404, "El usuario no existe");
  const mine = new Set(await scopePlantIds(prisma, actor));
  const theirs = target.userPlants.map((p) => p.plantId);
  if (!theirs.length || theirs.some((id) => !mine.has(id))) throw new ScopeError(404, "El usuario no existe");
  return target;
}

/** Valida que todas las plantas estén dentro del alcance. */
export async function assertPlantsInScope(prisma, actor, plantIds) {
  const ids = await scopePlantIds(prisma, actor);
  if (ids === null) return;
  const mine = new Set(ids);
  if (plantIds.some((id) => !mine.has(Number(id)))) throw new ScopeError(403, "Solo puedes asignar plantas a las que tienes acceso");
}
