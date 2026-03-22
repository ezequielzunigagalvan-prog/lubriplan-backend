import cors from "cors";

export const allowedOrigins = [
  "http://localhost:5173",
  "http://192.168.1.69:5173",
  "https://lubriplan-frontend.vercel.app",
];

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
};

export const corsMiddleware = cors(corsOptions);
