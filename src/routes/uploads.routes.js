import express from "express";
import multer from "multer";
import { uploadBufferToCloudinary } from "../lib/cloudinary.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowed.includes(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Formato de imagen no permitido."));
    }
    return cb(null, true);
  },
});

export default function uploadsRoutes({ auth }) {
  if (typeof auth !== "function") {
    throw new Error("uploadsRoutes: auth middleware is required");
  }

  const router = express.Router();

  router.post("/routes-image", auth, upload.single("image"), async (req, res) => {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({ error: "No se recibio imagen" });
      }

      const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
        folder: "lubriplan/routes",
        publicId: `route_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      });

      return res.json({
        ok: true,
        imageUrl: uploaded.secure_url,
        imagePublicId: uploaded.public_id,
        filename: uploaded.public_id,
      });
    } catch (error) {
      console.error("upload routes-image error:", error);
      const message = String(error?.message || "").trim();
      const status = /Cloudinary no esta configurado/i.test(message) ? 503 : 500;
      return res.status(status).json({
        error: message || "Error subiendo imagen de ruta",
      });
    }
  });

  return router;
}
