import prisma from "../../../prisma.js";
import { Prisma } from "@prisma/client";
import { logger } from "../../../config/logger.js";

// Create spare part
export async function createSparePart(plantId, data) {
  const { code, name, description, category, brand, partNumber, unit, minStock, maxStock, location, costPerUnit } = data;

  // Check for unique code per plant
  const existing = await prisma.mtSparePart.findFirst({
    where: { plantId, code },
  });

  if (existing) {
    throw new Error(`Spare part code '${code}' already exists in this plant`);
  }

  return await prisma.mtSparePart.create({
    data: {
      plantId,
      code,
      name,
      description,
      category,
      brand,
      partNumber,
      unit: unit || "piece",
      minStock: minStock || 0,
      maxStock: maxStock || 0,
      location,
      costPerUnit: costPerUnit || 0,
      status: "ACTIVE",
    },
  });
}

// Get spare part
export async function getSparePart(sparePartId, plantId) {
  const sparePart = await prisma.mtSparePart.findUnique({
    where: { id: sparePartId },
    include: {
      assets: {
        include: { asset: { select: { id: true, code: true, name: true } } },
      },
      stocks: {
        include: { warehouse: { select: { id: true, name: true } } },
      },
    },
  });

  if (!sparePart || sparePart.plantId !== plantId) {
    return null;
  }

  return sparePart;
}

// List spare parts
export async function listSpareParts(plantId, filters = {}, pagination = {}) {
  const { status = "ACTIVE", category, search } = filters;
  const { skip = 0, take = 50 } = pagination;

  const where = {
    plantId,
    ...(status && { status }),
    ...(category && { category }),
    ...(search && {
      OR: [
        { code: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ],
    }),
  };

  const [spareParts, total] = await Promise.all([
    prisma.mtSparePart.findMany({
      where,
      include: {
        stocks: { include: { warehouse: { select: { id: true, name: true } } } },
      },
      orderBy: { code: "asc" },
      skip,
      take: Math.min(take, 100),
    }),
    prisma.mtSparePart.count({ where }),
  ]);

  return {
    data: spareParts,
    total,
    skip,
    take,
    hasMore: skip + take < total,
  };
}

// Update spare part
export async function updateSparePart(sparePartId, plantId, data) {
  const sparePart = await prisma.mtSparePart.findUnique({
    where: { id: sparePartId },
  });

  if (!sparePart || sparePart.plantId !== plantId) {
    return null;
  }

  const updateData = {
    // NO actualizar code - es identificador único y debe ser inmutable
    // name es obligatorio en el esquema: un valor vacío se ignora en lugar de mandar null
    ...(typeof data.name === 'string' && data.name.trim() && { name: data.name.trim() }),
    ...(data.description !== undefined && { description: data.description || null }),
    ...(data.category !== undefined && { category: data.category || null }),
    ...(data.brand !== undefined && { brand: data.brand || null }),
    ...(data.partNumber !== undefined && { partNumber: data.partNumber || null }),
    ...(data.unit !== undefined && { unit: data.unit || 'piece' }),
    ...(data.minStock !== undefined && { minStock: new Prisma.Decimal(Number(data.minStock) || 0) }),
    ...(data.maxStock !== undefined && { maxStock: new Prisma.Decimal(Number(data.maxStock) || 0) }),
    ...(data.location !== undefined && { location: data.location || null }),
    ...(data.costPerUnit !== undefined && { costPerUnit: new Prisma.Decimal(Number(data.costPerUnit) || 0) }),
    ...(data.status !== undefined && { status: data.status || 'ACTIVE' }),
    version: { increment: 1 },
  };

  const result = await prisma.mtSparePart.update({
    where: { id: sparePartId },
    data: updateData,
  });

  return result;
}

/**
 * Baja de una refacción (status INACTIVE). Se bloquea si todavía tiene existencia en algún almacén,
 * para no "perder" inventario valorizado: primero se ajusta a 0.
 * Devuelve null si no existe; lanza { status: 409 } si tiene existencia.
 */
export async function deactivateSparePart(sparePartId, plantId) {
  const sparePart = await prisma.mtSparePart.findFirst({
    where: { id: sparePartId, plantId },
    include: { stocks: { select: { quantity: true } } },
  });
  if (!sparePart) return null;

  const onHand = sparePart.stocks.reduce((s, x) => s + Number(x.quantity), 0);
  if (onHand > 0) {
    throw Object.assign(new Error(`No se puede dar de baja: tiene ${onHand} ${sparePart.unit} en existencia. Ajusta la existencia a 0 primero.`), { status: 409 });
  }

  return prisma.mtSparePart.update({
    where: { id: sparePartId },
    data: { status: "INACTIVE", version: { increment: 1 } },
  });
}

// Link spare part to asset
export async function linkSparePartToAsset(sparePartId, assetId, plantId) {
  // Verify both exist in the same plant
  const [sparePart, asset] = await Promise.all([
    prisma.mtSparePart.findUnique({ where: { id: sparePartId } }),
    prisma.mtAsset.findUnique({ where: { id: assetId } }),
  ]);

  if (!sparePart || sparePart.plantId !== plantId) {
    throw new Error("Spare part not found in this plant");
  }
  if (!asset || asset.plantId !== plantId) {
    throw new Error("Asset not found in this plant");
  }

  return await prisma.mtSparePartAsset.create({
    data: { sparePartId, assetId },
  });
}

// Get spare parts for an asset
export async function getSparePartsForAsset(assetId, plantId) {
  const asset = await prisma.mtAsset.findUnique({
    where: { id: assetId },
  });

  if (!asset || asset.plantId !== plantId) {
    return null;
  }

  return await prisma.mtSparePartAsset.findMany({
    where: { assetId },
    include: {
      sparePart: {
        select: {
          id: true,
          code: true,
          name: true,
          unit: true,
          costPerUnit: true,
          status: true,
        },
      },
    },
  });
}
