import cors from "cors";

export const allowedOrigins = [
  "http://localhost:5173",
  "http://192.168.1.69:5173",
  "https://lubriplan-frontend.vercel.app",
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    // Permitir cualquier subdominio de Vercel
    if (origin.includes("vercel.app")) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};

export const corsMiddleware = cors(corsOptions);
