import cors from "cors";
import { logger } from "../config/logger.js";

export const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://api.lubriplan.com",
  "https://lubriplan.com",
  "https://www.lubriplan.com",
  "https://app.lubriplan.com",
  "https://lubriplan-frontend.vercel.app",
];

const corsOptions = {
  origin(origin, callback) {
    logger.info("[CORS] Origin recibido:", origin);

    // En desarrollo sin origin (ej: requests del servidor) se permite
    // En producción (CORS_STRICT=true) se rechaza
    if (!origin) {
      const isStrict = process.env.CORS_STRICT === "true";
      const isDev = process.env.NODE_ENV !== "production";

      if (isStrict || !isDev) {
        return callback(new Error("Origin header requerido (CSRF protection)"));
      }
      return callback(null, true);
    }

    if (
      allowedOrigins.includes(origin) ||
      /^https:\/\/.*\.vercel\.app$/.test(origin)
    ) {
      return callback(null, true);
    }

    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-User-Id",
    "x-user-id",
    "X-Plant-Id",
    "x-plant-id",
  ],
};

export const corsMiddleware = cors(corsOptions);
