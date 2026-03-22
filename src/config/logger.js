// src/config/logger.js
export function devApiLogger(req, res, next) {
  if (process.env.NODE_ENV === "production") return next();

  const t0 = Date.now();
  res.on("finish", () => {
    if (!req.originalUrl.startsWith("/api")) return;
    console.log("🟦 IN", req.method, req.originalUrl, {
      status: res.statusCode,
      ms: Date.now() - t0,
    });
  });

  next();
}