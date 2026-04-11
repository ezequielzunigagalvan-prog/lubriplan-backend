import fs from "fs";
import path from "path";

function normalizeEnvPath(value) {
  const text = String(value || "").trim();
  return text || null;
}

export function getUploadsRoot() {
  const explicitUploadsDir = normalizeEnvPath(process.env.UPLOADS_DIR);
  if (explicitUploadsDir) return explicitUploadsDir;

  const railwayVolumePath = normalizeEnvPath(process.env.RAILWAY_VOLUME_MOUNT_PATH);
  if (railwayVolumePath) return path.join(railwayVolumePath, "uploads");

  const defaultRailwayDataPath = process.platform === "win32" ? null : "/data";
  if (defaultRailwayDataPath && fs.existsSync(defaultRailwayDataPath)) {
    return path.join(defaultRailwayDataPath, "uploads");
  }

  return path.join(process.cwd(), "uploads");
}

export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

export function getUploadsSubdir(...segments) {
  return ensureDir(path.join(getUploadsRoot(), ...segments));
}
