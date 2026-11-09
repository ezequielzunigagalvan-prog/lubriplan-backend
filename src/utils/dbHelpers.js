// src/utils/dbHelpers.js

/**
 * Helper para encontrar un registro con validación de plantId
 */
export async function findOneWithPlantId(prismaModel, id, plantId, includeOpts = {}) {
  if (!Number.isFinite(id)) {
    throw new Error("Invalid ID");
  }

  const item = await prismaModel.findFirst({
    where: { id, plantId },
    ...includeOpts,
  });

  if (!item) {
    throw new Error("Not found");
  }

  return item;
}

/**
 * Helper para encontrar múltiples registros con plantId
 */
export async function findManyWithPlantId(
  prismaModel,
  plantId,
  filters = {},
  options = {}
) {
  const {
    orderBy = { createdAt: "desc" },
    take = 50,
    skip = 0,
    include = {},
  } = options;

  return prismaModel.findMany({
    where: { plantId, ...filters },
    orderBy,
    take,
    skip,
    include,
  });
}

/**
 * Helper para contar registros con plantId
 */
export async function countWithPlantId(prismaModel, plantId, filters = {}) {
  return prismaModel.count({
    where: { plantId, ...filters },
  });
}

/**
 * Helper para actualizar registro con validación
 */
export async function updateWithPlantId(
  prismaModel,
  id,
  plantId,
  updateData,
  includeOpts = {}
) {
  if (!Number.isFinite(id)) {
    throw new Error("Invalid ID");
  }

  // Verificar que existe
  const exists = await prismaModel.findFirst({
    where: { id, plantId },
    select: { id: true },
  });

  if (!exists) {
    throw new Error("Not found");
  }

  return prismaModel.update({
    where: { id },
    data: updateData,
    ...includeOpts,
  });
}

/**
 * Helper para eliminar (soft delete) con validación
 */
export async function softDeleteWithPlantId(prismaModel, id, plantId) {
  if (!Number.isFinite(id)) {
    throw new Error("Invalid ID");
  }

  return updateWithPlantId(
    prismaModel,
    id,
    plantId,
    { deletedAt: new Date() }
  );
}
