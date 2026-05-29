// src/services/webhooks.service.js
import crypto from "crypto";
import { logger } from "../config/logger.js";

/**
 * Firma el payload con HMAC-SHA256 usando el secret del endpoint.
 */
function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Entrega un webhook a un endpoint.
 * Retorna { ok, status, body }.
 */
async function deliverOne(endpoint, delivery) {
  const payloadStr = JSON.stringify(delivery.payload);
  const sig = sign(payloadStr, endpoint.secret);

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LubriPlan-Event": delivery.event,
        "X-LubriPlan-Signature": `sha256=${sig}`,
        "X-LubriPlan-Delivery": String(delivery.id),
      },
      body: payloadStr,
      signal: AbortSignal.timeout(8000),
    });

    const body = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
  } catch (err) {
    return { ok: false, status: null, body: String(err?.message || "network error").slice(0, 500) };
  }
}

/**
 * Dispara un evento webhook para todos los endpoints activos de la planta
 * que estén suscritos al evento. Fire-and-forget — no bloquea al caller.
 */
export function fireWebhookEvent(prisma, plantId, event, data = {}) {
  if (!plantId || !event) return;

  setImmediate(async () => {
    try {
      const endpoints = await prisma.webhookEndpoint.findMany({
        where: { plantId, active: true, events: { has: event } },
      });

      if (!endpoints.length) return;

      const now = new Date();
      const payload = { event, plantId, timestamp: now.toISOString(), data };

      for (const ep of endpoints) {
        let delivery;
        try {
          delivery = await prisma.webhookDelivery.create({
            data: {
              endpointId: ep.id,
              event,
              payload,
              status: "PENDING",
              attempts: 0,
            },
          });

          const result = await deliverOne(ep, delivery);

          await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status: result.ok ? "SUCCESS" : "FAILED",
              attempts: 1,
              lastAttemptAt: new Date(),
              responseStatus: result.status,
              responseBody: result.body,
            },
          });
        } catch (innerErr) {
          logger.error("webhooks.service delivery error:", innerErr?.message);
          if (delivery?.id) {
            await prisma.webhookDelivery.update({
              where: { id: delivery.id },
              data: { status: "FAILED", attempts: 1, lastAttemptAt: new Date(), responseBody: String(innerErr?.message || "").slice(0, 500) },
            }).catch(() => {});
          }
        }
      }
    } catch (e) {
      logger.error("webhooks.service fireWebhookEvent error:", e?.message);
    }
  });
}

/**
 * Reintenta una entrega fallida.
 */
export async function retryDelivery(prisma, deliveryId) {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });

  if (!delivery) throw new Error("Delivery no encontrado");
  if (delivery.status === "SUCCESS") throw new Error("La entrega ya fue exitosa");
  if (delivery.attempts >= 5) throw new Error("Máximo de reintentos alcanzado (5)");

  const result = await deliverOne(delivery.endpoint, delivery);

  return prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: result.ok ? "SUCCESS" : "FAILED",
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      responseStatus: result.status,
      responseBody: result.body,
    },
  });
}
