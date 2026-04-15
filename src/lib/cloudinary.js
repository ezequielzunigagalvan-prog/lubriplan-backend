import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";

const requiredVars = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];

export function isCloudinaryConfigured() {
  return requiredVars.every((key) => String(process.env[key] || "").trim() !== "");
}

export function getCloudinary() {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary no esta configurado en el backend.");
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });

  return cloudinary;
}

function extFromMime(mimeType) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  return map[String(mimeType || "").toLowerCase()] || "jpg";
}

function normalizePublicId(publicId) {
  return String(publicId || "")
    .trim()
    .replace(/[^a-zA-Z0-9/_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function uploadBufferToCloudinary(buffer, options = {}) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("No se recibio un archivo valido para subir.");
  }

  const uploader = getCloudinary().uploader;
  const folder = String(options.folder || "lubriplan").trim();
  const publicId = normalizePublicId(options.publicId);

  return new Promise((resolve, reject) => {
    const stream = uploader.upload_stream(
      {
        folder,
        public_id: publicId || undefined,
        overwrite: true,
        resource_type: "image",
        unique_filename: !publicId,
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result);
      }
    );

    streamifier.createReadStream(buffer).pipe(stream);
  });
}

export async function uploadDataUriToCloudinary(dataUri, options = {}) {
  const raw = String(dataUri || "").trim();
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(raw);
  if (!match) {
    throw new Error("La evidencia no tiene un formato de imagen valido.");
  }

  const [, mimeType, base64Body] = match;
  const buffer = Buffer.from(base64Body, "base64");

  return uploadBufferToCloudinary(buffer, {
    ...options,
    publicId:
      options.publicId ||
      `img_${Date.now()}_${Math.random().toString(16).slice(2)}.${extFromMime(mimeType)}`,
  });
}

export async function normalizeImageInput(input, options = {}) {
  if (input == null) return { imageUrl: null, imagePublicId: null };

  const raw = String(input).trim();
  if (!raw) return { imageUrl: null, imagePublicId: null };

  if (/^https?:\/\//i.test(raw)) {
    return { imageUrl: raw, imagePublicId: null };
  }

  if (/^data:image\//i.test(raw)) {
    const result = await uploadDataUriToCloudinary(raw, options);
    return {
      imageUrl: result.secure_url,
      imagePublicId: result.public_id,
    };
  }

  return { imageUrl: raw, imagePublicId: null };
}

export async function destroyCloudinaryImage(publicId) {
  const id = String(publicId || "").trim();
  if (!id || !isCloudinaryConfigured()) return;

  try {
    await getCloudinary().uploader.destroy(id, { invalidate: true, resource_type: "image" });
  } catch (error) {
    console.error("No se pudo borrar la imagen previa en Cloudinary:", error);
  }
}
