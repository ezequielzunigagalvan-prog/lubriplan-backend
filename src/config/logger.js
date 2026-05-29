// src/config/logger.js
import { requestStore } from "../lib/requestStore.js";

const isProd = process.env.NODE_ENV === "production";

const LEVEL_NUM = { error: 50, warn: 40, info: 30, debug: 20 };
const MIN_LEVEL = isProd ? LEVEL_NUM.info : LEVEL_NUM.debug;

function write(level, msg, meta) {
  if (LEVEL_NUM[level] < MIN_LEVEL) return;

  if (isProd) {
    const entry = { level, time: new Date().toISOString(), msg };
    const reqId = requestStore.getStore()?.requestId;
    if (reqId) entry.reqId = reqId;
    if (meta != null) {
      if (meta instanceof Error) {
        entry.err = { message: meta.message, stack: meta.stack };
      } else if (typeof meta === "object") {
        Object.assign(entry, meta);
      } else {
        entry.data = meta;
      }
    }
    process.stdout.write(JSON.stringify(entry) + "\n");
  } else {
    const icons = { error: "🔴", warn: "🟡", info: "🟦", debug: "⚪" };
    const reqId = requestStore.getStore()?.requestId;
    const prefix = reqId ? ` [${reqId.slice(0, 8)}]` : "";
    const args = [`${icons[level]} [${level.toUpperCase()}]${prefix}`, msg];
    if (meta != null) args.push(meta);
    if (level === "error") console.error(...args);
    else if (level === "warn") console.warn(...args);
    else console.log(...args);
  }
}

export const logger = {
  error: (msg, meta) => write("error", msg, meta),
  warn:  (msg, meta) => write("warn",  msg, meta),
  info:  (msg, meta) => write("info",  msg, meta),
  debug: (msg, meta) => write("debug", msg, meta),
};

export function devApiLogger(req, res, next) {
  if (isProd) return next();
  const t0 = Date.now();
  res.on("finish", () => {
    if (!req.originalUrl.startsWith("/api")) return;
    logger.debug(`${req.method} ${req.originalUrl}`, { status: res.statusCode, ms: Date.now() - t0 });
  });
  next();
}
