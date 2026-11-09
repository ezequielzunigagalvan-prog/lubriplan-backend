// src/middleware/asyncHandler.js
import { logger } from "../config/logger.js";

/**
 * Wrapper para manejar errores en rutas async
 * Evita try-catch repetitivo y maneja errores centralizadamente
 */
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      logger.error("Route error:", error);

      // Mapear errores comunes a status codes
      if (error.message === "Not found") {
        return res.status(404).json({ error: "Resource not found" });
      }

      if (error.message?.includes("Invalid")) {
        return res.status(400).json({ error: error.message });
      }

      if (error.code === "P2002") {
        return res.status(409).json({ error: "Duplicate entry" });
      }

      // Default error response
      return res.status(500).json({
        error: error.message || "Internal server error",
      });
    });
  };
};
