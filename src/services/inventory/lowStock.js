// src/services/inventory/lowStock.js
// Aviso de stock bajo después de cualquier descuento de inventario
// (ejecución, OLP, emergencia, salida o ajuste manual).
//
// Antes solo existía dentro de un endpoint duplicado que nunca se ejecutaba,
// así que en la práctica nadie recibía el aviso.

import { getPlantSettings } from "../plantSettings.js";
import { notifyLowStockIfNew } from "../../notifications/notify.js";
import { sseHub } from "../../realtime/sseHub.js";
import { logger } from "../../config/logger.js";

/**
 * Si el lubricante quedó en o por debajo de su mínimo, avisa a ADMIN/SUPERVISOR
 * (una vez cada 24 h por lubricante) y emite el evento en tiempo real.
 * Nunca lanza error: se llama sin await después de guardar.
 */
export async function notifyIfLowStock(prisma, { plantId, lubricantId }) {
  try {
    if (!plantId || !lubricantId) return { notified: false };

    const [lub, settings] = await Promise.all([
      prisma.lubricant.findFirst({
        where: { id: Number(lubricantId), plantId: Number(plantId) },
        select: { id: true, name: true, unit: true, stock: true, minStock: true },
      }),
      getPlantSettings(prisma, plantId),
    ]);

    if (!lub || lub.minStock == null) return { notified: false };
    if (settings && settings.lowStockWarningEnabled === false) return { notified: false };
    if (Number(lub.stock) > Number(lub.minStock)) return { notified: false };

    const stock = Math.round(Number(lub.stock) * 100) / 100;
    const result = await notifyLowStockIfNew(prisma, {
      plantId: Number(plantId),
      lubricantName: lub.name,
      type: "LOW_STOCK",
      title: stock <= 0 ? "Lubricante agotado" : "Stock bajo",
      message: `${lub.name} quedó en ${stock} ${lub.unit || ""} (mínimo ${lub.minStock})`.trim(),
      link: "/inventory",
    });

    sseHub.broadcast?.("inventory.low-stock", {
      plantId: Number(plantId),
      lubricantId: lub.id,
      lubricantName: lub.name,
      stockAfter: stock,
      unit: lub.unit || null,
    });

    return { notified: !!result?.notified };
  } catch (e) {
    logger.error("[inventory] Error avisando stock bajo", { lubricantId, msg: e?.message });
    return { notified: false };
  }
}
