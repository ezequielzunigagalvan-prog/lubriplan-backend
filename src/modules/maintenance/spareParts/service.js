import prisma from "../../../prisma.js";
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

  return await prisma.mtSparePart.update({
    where: { id: sparePartId },
    data: {
      ...(data.name && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.category && { category: data.category }),
      ...(data.brand && { brand: data.brand }),
      ...(data.partNumber && { partNumber: data.partNumber }),
      ...(data.unit && { unit: data.unit }),
      ...(data.minStock !== undefined && { minStock: data.minStock }),
      ...(data.maxStock !== undefined && { maxStock: data.maxStock }),
      ...(data.location !== undefined && { location: data.location }),
      ...(data.costPerUnit !== undefined && { costPerUnit: data.costPerUnit }),
      ...(data.status && { status: data.status }),
      version: { increment: 1 },
    },
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
