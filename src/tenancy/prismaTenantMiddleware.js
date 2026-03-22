// src/tenancy/prismaTenantMiddleware.js
import { getCurrentPlantId } from "./tenantContext.js";

/**
 * Modelos a los que SÍ queremos aplicar scope por planta.
 * Solo modelos que tengan plantId DIRECTO en su tabla/modelo Prisma.
 */
const TENANTED_MODELS = new Set([
  "Equipment",
  "EquipmentArea",
  "Lubricant",
  "ConditionReport",
  "Notification",
]);

/**
 * Modelos que nunca deben scoping por planta
 */
const EXCLUDED_MODELS = new Set([
  "Plant",
  "User",
  "UserPlant",
  "Technician",
  "Route",
  "Execution",
  "LubricantMovement",
  "AppSettings",
]);

function isTenantedModel(model) {
  if (!model) return false;
  if (EXCLUDED_MODELS.has(model)) return false;
  return TENANTED_MODELS.has(model);
}

function ensureWhereHasPlantId(where, plantId) {
  if (where && Object.prototype.hasOwnProperty.call(where, "plantId")) return where;
  return { ...(where || {}), plantId };
}

function ensureDataHasPlantId(data, plantId) {
  if (!data) return data;

  if (!Array.isArray(data)) {
    if (Object.prototype.hasOwnProperty.call(data, "plantId")) return data;
    return { ...data, plantId };
  }

  return data.map((row) => {
    if (row && Object.prototype.hasOwnProperty.call(row, "plantId")) return row;
    return { ...(row || {}), plantId };
  });
}

/**
 * Middleware que aplica "plant scope" automáticamente
 */
export function applyPrismaTenantMiddleware(prisma) {
  prisma.$use(async (params, next) => {
    const plantId = getCurrentPlantId();

    if (!plantId) return next(params);

    const { model, action } = params;

    if (!isTenantedModel(model)) return next(params);

    if (
      action === "findMany" ||
      action === "findFirst" ||
      action === "findFirstOrThrow" ||
      action === "count" ||
      action === "aggregate" ||
      action === "groupBy"
    ) {
      params.args = params.args || {};
      params.args.where = ensureWhereHasPlantId(params.args.where, plantId);
      return next(params);
    }

    if (action === "findUnique" || action === "findUniqueOrThrow") {
      return next(params);
    }

    if (action === "create") {
      params.args = params.args || {};
      params.args.data = ensureDataHasPlantId(params.args.data, plantId);
      return next(params);
    }

    if (action === "createMany") {
      params.args = params.args || {};
      params.args.data = ensureDataHasPlantId(params.args.data, plantId);
      return next(params);
    }

    if (action === "updateMany" || action === "deleteMany") {
      params.args = params.args || {};
      params.args.where = ensureWhereHasPlantId(params.args.where, plantId);
      return next(params);
    }

    if (action === "update") {
      return next(params);
    }

    if (action === "upsert") {
      params.args = params.args || {};
      if (params.args.create) params.args.create = ensureDataHasPlantId(params.args.create, plantId);
      if (params.args.update) params.args.update = ensureDataHasPlantId(params.args.update, plantId);
      return next(params);
    }

    return next(params);
  });
}