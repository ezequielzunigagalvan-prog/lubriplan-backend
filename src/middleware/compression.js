// src/middleware/compression.js
import compression from "compression";

/**
 * Configure response compression for faster API responses
 * Reduces payload size by 60-80%
 */
export const setupCompression = () => {
  return compression({
    level: 6, // Balance between speed and compression (0-9)
    threshold: 1024, // Only compress responses > 1KB
    filter: (req, res) => {
      // Don't compress streaming responses
      if (req.headers["x-no-compression"]) {
        return false;
      }
      return compression.filter(req, res);
    },
  });
};

/**
 * Cache-control headers middleware
 * Reduces unnecessary requests to backend
 */
export const setCacheHeaders = (req, res, next) => {
  // Public GET requests are cacheable
  if (req.method === "GET") {
    // Short cache for API responses (5 minutes)
    res.set("Cache-Control", "public, max-age=300");
  } else {
    // No cache for state-changing operations
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  }

  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  next();
};

/**
 * ETag support for client-side caching
 */
export const etagMiddleware = (req, res, next) => {
  const originalJson = res.json;

  res.json = function (data) {
    // Generate simple ETag from data hash
    const hash = JSON.stringify(data)
      .split("")
      .reduce((a, b) => {
        a = (a << 5) - a + b.charCodeAt(0);
        return a & a; // Convert to 32bit integer
      }, 0);

    const etag = `"${hash.toString(36)}"`;
    res.set("ETag", etag);

    // Return 304 Not Modified if client has same version
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    return originalJson.call(this, data);
  };

  next();
};
