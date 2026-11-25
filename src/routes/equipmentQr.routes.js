// src/routes/equipmentQr.routes.js
// QR único por equipo.
//  - Cada equipo tiene un token permanente (Equipment.qrToken). El QR impreso codifica
//    https://<app>/qr/<token>, así que sigue funcionando aunque cambien nombre, código o ubicación.
//  - Al escanearlo, la app resuelve el token y abre la carta de lubricación del equipo
//    (cambiando de planta si el usuario tiene acceso a la planta del equipo).
import express from "express";
import crypto from "node:crypto";
import { logger } from "../config/logger.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{8,40}$/;
export const newToken = () => crypto.randomBytes(9).toString("base64url"); // 12 caracteres

/** Devuelve el token del equipo; lo crea (y guarda) si aún no tiene. */
export async function ensureEquipmentQr(prisma, equipmentId) {
  const eq = await prisma.equipment.findFirst({
    where: { id: equipmentId, plantId: { gt: 0 } },
    select: { id: true, qrToken: true, qrCreatedAt: true },
  });
  if (!eq) return null;
  if (eq.qrToken) return { token: eq.qrToken, createdAt: eq.qrCreatedAt };
  for (let i = 0; i < 5; i++) {
    try {
      const updated = await prisma.equipment.update({
        where: { id: equipmentId },
        data: { qrToken: newToken(), qrCreatedAt: new Date() },
        select: { qrToken: true, qrCreatedAt: true },
      });
      return { token: updated.qrToken, createdAt: updated.qrCreatedAt };
    } catch (e) {
      if (e?.code !== "P2002") throw e; // choque de token (casi imposible): reintenta
    }
  }
  throw new Error("No se pudo generar el QR");
}

async function canAccessPlant(prisma, user, plantId) {
  if (String(user?.role || "").toUpperCase() === "ADMIN") return true;
  const access = await prisma.userPlant.findFirst({ where: { userId: user.id, plantId, active: true }, select: { id: true } });
  return Boolean(access);
}

export default function equipmentQrRoutes({ prisma, auth }) {
  const router = express.Router();

  // Etiquetas QR de todos los equipos de la planta (asegura que cada uno tenga su código)
  router.get("/equipment/qr-labels", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
      const missing = await prisma.equipment.findMany({ where: { plantId, qrToken: null }, select: { id: true } });
      for (const m of missing) await ensureEquipmentQr(prisma, m.id);
      const items = await prisma.equipment.findMany({
        where: { plantId },
        select: { id: true, name: true, code: true, location: true, status: true, qrToken: true },
        orderBy: [{ name: "asc" }],
      });
      return res.json({ ok: true, items });
    } catch (e) {
      logger.error("GET /equipment/qr-labels", e);
      return res.status(500).json({ error: "No se pudieron generar las etiquetas QR" });
    }
  });

  // QR del equipo (de la planta actual)
  router.get("/equipment/:id/qr", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!plantId || !Number.isInteger(id)) return res.status(400).json({ error: "Equipo inválido" });
      const eq = await prisma.equipment.findFirst({ where: { id, plantId }, select: { id: true } });
      if (!eq) return res.status(404).json({ error: "Equipo no encontrado" });
      const qr = await ensureEquipmentQr(prisma, id);
      return res.json({ ok: true, ...qr, path: `/qr/${qr.token}` });
    } catch (e) {
      logger.error("GET /equipment/:id/qr", e);
      return res.status(500).json({ error: "No se pudo obtener el QR" });
    }
  });

  // Resolver un QR escaneado → equipo y planta
  router.get("/qr/:token", auth, async (req, res) => {
    try {
      const token = String(req.params.token || "");
      if (!TOKEN_RE.test(token)) return res.status(400).json({ error: "Código QR no válido" });
      const eq = await prisma.equipment.findFirst({
        where: { qrToken: token, plantId: { gt: 0 } },
        select: { id: true, name: true, code: true, location: true, plantId: true, plant: { select: { name: true } } },
      });
      if (!eq) return res.status(404).json({ error: "Este código QR no corresponde a ningún equipo" });
      if (!(await canAccessPlant(prisma, req.user, eq.plantId))) {
        return res.status(403).json({ error: `El equipo es de ${eq.plant?.name || "otra planta"} y no tienes acceso a esa planta` });
      }
      return res.json({
        ok: true,
        equipmentId: eq.id,
        plantId: eq.plantId,
        plantName: eq.plant?.name || "",
        name: eq.name,
        code: eq.code,
        location: eq.location,
      });
    } catch (e) {
      logger.error("GET /qr/:token", e);
      return res.status(500).json({ error: "No se pudo leer el código QR" });
    }
  });

  return router;
}
