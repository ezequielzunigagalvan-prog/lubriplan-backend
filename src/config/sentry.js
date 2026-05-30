// src/config/sentry.js
import * as Sentry from "@sentry/node";

const DSN = process.env.SENTRY_DSN;

export function initSentry() {
  if (!DSN) {
    // Sin DSN configurado — Sentry desactivado (ej. dev local)
    return;
  }

  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
    ],
    beforeSend(event) {
      // No enviar errores de validación esperados (400)
      if (event.extra?.statusCode === 400) return null;
      return event;
    },
  });
}

export { Sentry };
