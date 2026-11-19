import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

// ISO 14224 Base Failure Codes (Spanish)
const BASE_FAILURE_CODES = [
  // FAILURE MODES
  {
    code: "FM-001",
    name: "Fuga de aceite",
    category: "FAILURE_MODE",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "FM-002",
    name: "Ruido anormal",
    category: "FAILURE_MODE",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "FM-003",
    name: "Vibración excesiva",
    category: "FAILURE_MODE",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "FM-004",
    name: "Sobrecalentamiento",
    category: "FAILURE_MODE",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "FM-005",
    name: "Pérdida de presión",
    category: "FAILURE_MODE",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "FM-006",
    name: "Corrosión",
    category: "FAILURE_MODE",
    assetClass: null,
    isBaseCode: true,
  },
  // MECHANISMS
  {
    code: "MEC-001",
    name: "Desgaste de rodamientos",
    category: "MECHANISM",
    assetClass: "rotating",
    isBaseCode: true,
  },
  {
    code: "MEC-002",
    name: "Desgaste de sellos",
    category: "MECHANISM",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "MEC-003",
    name: "Aflojamiento de pernos",
    category: "MECHANISM",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "MEC-004",
    name: "Cavitación",
    category: "MECHANISM",
    assetClass: "hydraulic",
    isBaseCode: true,
  },
  {
    code: "MEC-005",
    name: "Rotura de álabes",
    category: "MECHANISM",
    assetClass: "rotating",
    isBaseCode: true,
  },
  // ROOT CAUSES
  {
    code: "RC-001",
    name: "Lubricación insuficiente",
    category: "ROOT_CAUSE",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "RC-002",
    name: "Lubricante contaminado",
    category: "ROOT_CAUSE",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "RC-003",
    name: "Alineación incorrecta",
    category: "ROOT_CAUSE",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "RC-004",
    name: "Desequilibrio dinámico",
    category: "ROOT_CAUSE",
    assetClass: "rotating",
    isBaseCode: true,
  },
  {
    code: "RC-005",
    name: "Mantenimiento deficiente",
    category: "ROOT_CAUSE",
    assetClass: null,
    isBaseCode: true,
  },
  {
    code: "RC-006",
    name: "Sobrecarga operativa",
    category: "ROOT_CAUSE",
    assetClass: null,
    isBaseCode: true,
  },
];

// Seed base failure codes for a plant
export async function seedFailureCodesForPlant(plantId) {
  let created = 0;
  let skipped = 0;

  for (const baseCode of BASE_FAILURE_CODES) {
    const existing = await prisma.mtFailureCode.findFirst({
      where: { plantId, code: baseCode.code },
    });

    if (!existing) {
      await prisma.mtFailureCode.create({
        data: {
          plantId,
          code: baseCode.code,
          name: baseCode.name,
          category: baseCode.category,
          assetClass: baseCode.assetClass,
          status: "ACTIVE",
          isBaseCode: baseCode.isBaseCode,
        },
      });
      created++;
    } else {
      skipped++;
    }
  }

  return { created, skipped };
}

const CATEGORIES = ["FAILURE_MODE", "MECHANISM", "ROOT_CAUSE"];

// Create failure code
export async function createFailureCode(plantId, data) {
  const code = String(data.code || "").trim().toUpperCase();
  const name = String(data.name || "").trim();
  const { category, parentId, assetClass } = data;

  if (!code || !name) throw Object.assign(new Error("Código y nombre son requeridos"), { status: 422 });
  if (!CATEGORIES.includes(category)) throw Object.assign(new Error(`Categoría inválida: ${category}`), { status: 422 });

  const existing = await prisma.mtFailureCode.findFirst({ where: { plantId, code } });
  if (existing) throw Object.assign(new Error(`El código '${code}' ya existe en esta planta`), { status: 409 });

  if (parentId) {
    const parent = await prisma.mtFailureCode.findFirst({ where: { id: Number(parentId), plantId }, select: { id: true } });
    if (!parent) throw Object.assign(new Error("El código padre no existe en esta planta"), { status: 422 });
  }

  return await prisma.mtFailureCode.create({
    data: {
      plantId,
      code,
      name,
      category,
      parentId: parentId ? Number(parentId) : null,
      assetClass: assetClass || null,
      status: "ACTIVE",
      isBaseCode: false,
    },
  });
}

// Get failure code with hierarchy
export async function getFailureCode(codeId, plantId) {
  const code = await prisma.mtFailureCode.findUnique({
    where: { id: codeId },
    include: {
      parent: { select: { id: true, code: true, name: true } },
      children: { select: { id: true, code: true, name: true, category: true } },
    },
  });

  if (!code || code.plantId !== plantId) {
    return null;
  }

  return code;
}

// List failure codes
export async function listFailureCodes(plantId, filters = {}) {
  const { category, status = "ACTIVE", search, assetClass } = filters;

  const where = {
    plantId,
    // status=ALL devuelve activos e inactivos (para administrar el catálogo)
    ...(status && status !== "ALL" && { status }),
    ...(category && { category }),
    ...(assetClass && { assetClass }),
    ...(search && {
      OR: [
        { code: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ],
    }),
  };

  const codes = await prisma.mtFailureCode.findMany({
    where,
    include: {
      parent: { select: { id: true, code: true, name: true } },
      children: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ category: "asc" }, { code: "asc" }],
  });

  // Build hierarchy
  const codesByCategory = {
    FAILURE_MODE: [],
    MECHANISM: [],
    ROOT_CAUSE: [],
  };

  codes.forEach((c) => {
    if (codesByCategory[c.category]) {
      codesByCategory[c.category].push(c);
    }
  });

  return codesByCategory;
}

// Update failure code
export async function updateFailureCode(codeId, plantId, data) {
  const code = await prisma.mtFailureCode.findUnique({
    where: { id: codeId },
  });

  if (!code || code.plantId !== plantId) {
    return null;
  }

  // Los códigos base (ISO 14224) no se renombran, pero sí se pueden activar/desactivar
  if (code.isBaseCode && (data.name !== undefined || data.assetClass !== undefined)) {
    throw new Error("Cannot modify base failure codes (only activate/deactivate)");
  }
  if (data.status !== undefined && !["ACTIVE", "INACTIVE"].includes(data.status)) {
    throw Object.assign(new Error("Estado inválido"), { status: 422 });
  }

  return await prisma.mtFailureCode.update({
    where: { id: codeId },
    data: {
      ...(typeof data.name === "string" && data.name.trim() && { name: data.name.trim() }),
      ...(data.status && { status: data.status }),
      ...(data.assetClass !== undefined && { assetClass: data.assetClass || null }),
    },
  });
}

// Assign failure to work order
export async function assignFailureToWorkOrder(workOrderId, failureModeId, mechanismId, rootCauseId, productionEffect, plantId) {
  const workOrder = await prisma.mtWorkOrder.findUnique({
    where: { id: workOrderId },
    select: { plantId: true, assetId: true },
  });

  if (!workOrder || workOrder.plantId !== plantId) {
    throw new Error("Work order not found");
  }

  // Validate failure codes belong to same plant
  if (failureModeId) {
    const fm = await prisma.mtFailureCode.findUnique({ where: { id: failureModeId } });
    if (!fm || fm.plantId !== plantId) throw new Error("Invalid failure mode");
  }
  if (mechanismId) {
    const mec = await prisma.mtFailureCode.findUnique({ where: { id: mechanismId } });
    if (!mec || mec.plantId !== plantId) throw new Error("Invalid mechanism");
  }
  if (rootCauseId) {
    const rc = await prisma.mtFailureCode.findUnique({ where: { id: rootCauseId } });
    if (!rc || rc.plantId !== plantId) throw new Error("Invalid root cause");
  }

  // Upsert failure record
  return await prisma.mtWorkOrderFailure.upsert({
    where: { workOrderId },
    update: {
      failureModeId: failureModeId || null,
      mechanismId: mechanismId || null,
      rootCauseId: rootCauseId || null,
      productionEffect: productionEffect || null,
    },
    create: {
      workOrderId,
      assetId: workOrder.assetId || 0, // Required, defaults if null
      failureModeId: failureModeId || null,
      mechanismId: mechanismId || null,
      rootCauseId: rootCauseId || null,
      productionEffect: productionEffect || null,
    },
  });
}

// Get failure for work order
export async function getWorkOrderFailure(workOrderId, plantId) {
  const failure = await prisma.mtWorkOrderFailure.findUnique({
    where: { workOrderId },
    include: {
      workOrder: { select: { plantId: true } },
      failureMode: { select: { id: true, code: true, name: true } },
      mechanism: { select: { id: true, code: true, name: true } },
      rootCause: { select: { id: true, code: true, name: true } },
    },
  });

  if (!failure || failure.workOrder.plantId !== plantId) {
    return null;
  }

  return failure;
}
