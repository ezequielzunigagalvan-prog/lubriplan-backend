import express from "express";
import multer from "multer";
import path from "path";
import { getUploadsSubdir } from "../utils/uploads.js";

export default function uploadsRoutes({ auth }) {
  if (typeof auth !== "function") {
    throw new Error("uploadsRoutes: auth middleware is required");
  }

  const router = express.Router();
  const uploadDir = getUploadsSubdir("routes");

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".jpg").toLowerCase();
      cb(null, `route_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`);
    },
  });

  const upload = multer({ storage });

  router.post("/routes-image", auth, upload.single("image"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No se recibio imagen" });
      }

      return res.json({
        ok: true,
        imageUrl: `/uploads/routes/${req.file.filename}`,
        filename: req.file.filename,
      });
    } catch (e) {
      console.error("upload routes-image error:", e);
      return res.status(500).json({ error: "Error subiendo imagen de ruta" });
    }
  });

  return router;
}
