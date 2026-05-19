// AES-256-CBC encryption for credential storage
import crypto from "crypto";

const ALGORITHM = "aes-256-cbc";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

function getKey() {
  const raw = process.env.INTEGRATION_SECRET || "";
  if (!raw) throw new Error("INTEGRATION_SECRET env var is not set");
  return crypto.createHash("sha256").update(raw).digest().slice(0, KEY_LENGTH);
}

export function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const [ivHex, encHex] = String(ciphertext).split(":");
  if (!ivHex || !encHex) return null;
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
