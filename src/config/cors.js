import cors from "cors";

export const allowedOrigins = [
  "http://localhost:5173",
  "https://lubriplan.com",
  "https://www.lubriplan.com",
  "https://app.lubriplan.com",
  "https://lubriplan-frontend.vercel.app",
];

const corsOptions = {
  origin(origin, callback) {
    console.log("[CORS] Origin recibido:", origin);

    if (!origin) return callback(null, true);

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
