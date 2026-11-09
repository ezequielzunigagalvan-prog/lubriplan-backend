// src/middleware/validateRequest.js
import { logger } from "../config/logger.js";

/**
 * Middleware para validar plantId en request
 */
export const validatePlantId = (req, res, next) => {
  if (!req.currentPlantId) {
    return res.status(400).json({ error: "PLANT_REQUIRED" });
  }
  next();
};

/**
 * Middleware para validar ID numérico
 */
export const validateNumericId = (paramName = "id") => {
  return (req, res, next) => {
    const idValue = req.params[paramName];
    const id = parseInt(idValue);

    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    req.params[paramName] = id;
    next();
  };
};

/**
 * Middleware para validar que el recurso existe
 */
export const validateResourceExists = (resourceName) => {
  return (req, res, next) => {
    if (!req[resourceName]) {
      return res.status(404).json({ error: `${resourceName} not found` });
    }
    next();
  };
};

/**
 * Middleware para validar body parameters
 */
export const validateBodyParams = (requiredParams = []) => {
  return (req, res, next) => {
    const missing = requiredParams.filter((param) => !req.body[param]);

    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(", ")}`,
      });
    }

    next();
  };
};
