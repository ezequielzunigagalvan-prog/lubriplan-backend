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
    if (!origin) return callback(null, true);

    if (origin.includes("vercel.app")) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

export const corsMiddleware = cors(corsOptions);
