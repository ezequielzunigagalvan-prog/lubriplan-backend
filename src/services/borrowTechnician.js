// src/services/borrowTechnician.js
// Técnicos de otras plantas: un supervisor/admin puede asignar a una actividad de su planta
// a un técnico que trabaja en otra planta.
//
// Las actividades se asignan a perfiles de técnico de la planta (Technician.plantId). Para usar
// a un técnico de otra planta se le crea (o reutiliza) un perfil en la planta actual:
//  - Si el técnico tiene cuenta, el perfil queda ligado a la misma cuenta (Technician.userId) y se
//    le da acceso a la planta, así puede entrar, ver la actividad y completarla.
//  - Si no tiene cuenta, se crea un perfil con sus mismos datos (o se reutiliza uno con el mismo nombre).

import { ensureTechnicianProfile, ProfileError } from "./technicianProfile.js";
import { isPlatformOwner } from "./accessScope.js";

const isActive = (s) => ["ACTIVO", "ACTIVE"].includes(String(s || "").trim().toUpperCase());

/** Plantas (distintas a la actual) de las que el usuario puede tomar técnicos. */
export async function sourcePlantIds(prisma, { user, currentPlantId }) {
  const role = String(user?.role || "").toUpperCase();
  if (role === "ADMIN" && isPlatformOwner(user)) {
    const plants = await prisma.plant.findMany({ where: { active: true, id: { not: currentPlantId } }, select: { id: true } });
    return plants.map((p) => p.id);
  }
  const mine = await prisma.userPlant.findMany({
    where: { userId: user.id, active: true, plantId: { not: currentPlantId } },
    select: { plantId: true },
  });
  return mine.map((m) => m.plantId);
}

/** Técnicos activos de otras plantas que aún no tienen perfil en la planta actual. */
export async function listOtherPlantTechnicians(prisma, { user, currentPlantId }) {
  const plantIds = await sourcePlantIds(prisma, { user, currentPlantId });
  if (!plantIds.length) return [];

  const [techs, plants, localLinked] = await Promise.all([
    prisma.technician.findMany({
      where: { plantId: { in: plantIds }, deletedAt: null },
      select: { id: true, name: true, code: true, specialty: true, status: true, plantId: true, userId: true, user: { select: { id: true } } },
      orderBy: [{ name: "asc" }],
    }),
    prisma.plant.findMany({ where: { id: { in: plantIds } }, select: { id: true, name: true } }),
    prisma.technician.findMany({ where: { plantId: currentPlantId, deletedAt: null }, select: { userId: true, name: true } }),
  ]);
  const plantName = new Map(plants.map((p) => [p.id, p.name]));
  const linkedUsers = new Set(localLinked.filter((t) => t.userId).map((t) => t.userId));
  const localNames = new Set(localLinked.map((t) => String(t.name || "").trim().toLowerCase()));
  const seenUsers = new Set();

  return techs
    .filter((t) => isActive(t.status))
    .map((t) => ({ ...t, accountId: t.userId ?? t.user?.id ?? null }))
    // Si su cuenta ya tiene perfil aquí, ya aparece en la lista normal de técnicos de la planta.
    .filter((t) => !(t.accountId && linkedUsers.has(t.accountId)))
    // Sin cuenta: si ya se trajo antes (mismo nombre en esta planta), ya está en la lista normal.
    .filter((t) => t.accountId || !localNames.has(String(t.name || "").trim().toLowerCase()))
    // Una persona con perfiles en varias plantas aparece una sola vez.
    .filter((t) => {
      if (!t.accountId) return true;
      if (seenUsers.has(t.accountId)) return false;
      seenUsers.add(t.accountId);
      return true;
    })
    .map((t) => ({
      id: t.id,
      name: t.name,
      code: t.code,
      specialty: t.specialty,
      plantId: t.plantId,
      plantName: plantName.get(t.plantId) || `Planta ${t.plantId}`,
      hasAccount: Boolean(t.accountId),
    }));
}

async function freeCode(tx, plantId, base) {
  const root = String(base || "TEC").trim().toUpperCase() || "TEC";
  for (let i = 0; i < 50; i++) {
    const code = i === 0 ? root : `${root}-${i + 1}`;
    const taken = await tx.technician.findFirst({ where: { plantId, code }, select: { id: true } });
    if (!taken) return code;
  }
  throw new ProfileError("No se pudo asignar un código para el técnico en esta planta", 409);
}

/**
 * Devuelve el perfil de la planta actual para el técnico `technicianId` de otra planta
 * (lo crea si no existe). { technician, created, accessGranted }
 */
export async function borrowTechnician(prisma, { user, currentPlantId, technicianId }) {
  const allowed = await sourcePlantIds(prisma, { user, currentPlantId });
  const source = await prisma.technician.findFirst({
    where: { id: Number(technicianId), deletedAt: null, plantId: { in: allowed.length ? allowed : [-1] } },
    select: {
      id: true, name: true, code: true, specialty: true, email: true, phone: true, status: true, plantId: true,
      userId: true, user: { select: { id: true, name: true, email: true, role: true, technicianId: true, active: true } },
    },
  });
  if (!source) throw new ProfileError("El técnico no existe o no tienes acceso a su planta", 404);
  if (!isActive(source.status)) throw new ProfileError(`${source.name} está inactivo en su planta`);

  return prisma.$transaction(async (tx) => {
    const accountId = source.userId ?? source.user?.id ?? null;
    let localId;
    let created = false;
    let accessGranted = false;

    if (accountId) {
      const account = await tx.user.findFirst({ where: { id: accountId }, select: { id: true, name: true, email: true, technicianId: true } });
      const existing = await tx.technician.findFirst({ where: { plantId: currentPlantId, deletedAt: null, userId: accountId }, select: { id: true } });
      if (existing) {
        localId = existing.id;
      } else {
        const code = await freeCode(tx, currentPlantId, source.code);
        const r = await ensureTechnicianProfile(tx, { user: account, plantId: currentPlantId, code });
        localId = r.id;
        created = r.created;
      }
      // Acceso a la planta para que pueda entrar y completar la actividad.
      const access = await tx.userPlant.findFirst({ where: { userId: accountId, plantId: currentPlantId }, select: { id: true, active: true } });
      if (!access) {
        await tx.userPlant.create({ data: { userId: accountId, plantId: currentPlantId, active: true, isDefault: false } });
        accessGranted = true;
      } else if (!access.active) {
        await tx.userPlant.update({ where: { id: access.id }, data: { active: true } });
        accessGranted = true;
      }
    } else {
      const same = await tx.technician.findFirst({
        where: { plantId: currentPlantId, deletedAt: null, name: { equals: source.name, mode: "insensitive" } },
        select: { id: true },
      });
      if (same) {
        localId = same.id;
      } else {
        const code = await freeCode(tx, currentPlantId, source.code);
        const t = await tx.technician.create({
          data: {
            plantId: currentPlantId,
            code,
            name: source.name,
            specialty: source.specialty || "Lubricación",
            email: source.email || null,
            phone: source.phone || null,
            status: "Activo",
          },
          select: { id: true },
        });
        localId = t.id;
        created = true;
      }
    }

    const technician = await tx.technician.findFirst({
      where: { id: localId },
      select: { id: true, name: true, code: true, status: true, specialty: true, plantId: true, userId: true },
    });
    // Si el perfil local estaba inactivo, se reactiva para poder asignarlo.
    if (!isActive(technician.status)) {
      await tx.technician.update({ where: { id: localId }, data: { status: "Activo" } });
      technician.status = "Activo";
    }
    return { technician, created, accessGranted, fromPlantId: source.plantId };
  });
}
