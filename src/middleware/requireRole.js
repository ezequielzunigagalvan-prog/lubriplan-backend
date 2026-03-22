// src/middleware/requireRole.js
export function requireRole(allowed = []) {
  const allowedUpper = (allowed || []).map((r) => String(r).toUpperCase().trim());
  return (req, res, next) => {
    const role = String(req.user?.role || "").toUpperCase().trim();
    if (!allowedUpper.includes(role)) return res.status(403).json({ error: "No autorizado" });
    next();
  };
}