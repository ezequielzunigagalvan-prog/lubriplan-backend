// src/app.js
import express from "express";
import { corsMiddleware } from "./config/cors.js";
import { devApiLogger } from "./config/logger.js";
import { devAttachUser } from "./middleware/devAttachUser.js";
import prisma from "./prisma.js";
import { mountRoutes } from "./routes/index.js"; // ✅

export function createApp() {
  const app = express();

  // CORS
  app.use(corsMiddleware);
  app.options("*", corsMiddleware, (_req, res) => res.sendStatus(204));

  // parsers
  app.use(express.json({ limit: "20mb" }));
  app.use(express.urlencoded({ extended: true, limit: "20mb" }));

  // logger
  app.use(devApiLogger);

  // dev attach user (no OPTIONS)
  if (process.env.NODE_ENV !== "production") {
    app.use((req, res, next) => {
      if (req.method === "OPTIONS") return res.sendStatus(204);
      return devAttachUser(req, res, next);
    });
  }

  // routes
 mountRoutes(app, { prisma });

  return app;
}
