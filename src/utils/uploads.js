import fs from "fs";
import path from "path";

function normalizeEnvPath(value) {
  const text = String(value || "").trim();
  return text || null;
}

export function getUploadsRoots() {
  const roots = [];

  const explicitUploadsDir = normalizeEnvPath(process.env.UPLOADS_DIR);
  if (explicitUploadsDir) roots.push(explicitUploadsDir);

  const railwayVolumePath = normalizeEnvPath(process.env.RAILWAY_VOLUME_MOUNT_PATH);
  if (railwayVolumePath) roots.push(path.join(railwayVolumePath, "uploads"));

  const defaultRailwayDataPath = process.platform === "win32" ? null : "/data";
  if (defaultRailwayDataPath && fs.existsSync(defaultRailwayDataPath)) {
    roots.push(path.join(defaultRailwayDataPath, "uploads"));
  }

  roots.push(path.join(process.cwd(), "uploads"));

  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

export function getUploadsRoot() {
  return getUploadsRoots()[0];
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

export function getAlternateUploadsSubdirs(...segments) {
  const roots = getUploadsRoots();
  const primary = path.resolve(path.join(getUploadsRoot(), ...segments));
  return roots
    .map((root) => path.resolve(path.join(root, ...segments)))
    .filter((dirPath) => dirPath !== primary)
    .map((dirPath) => ensureDir(dirPath));
}
