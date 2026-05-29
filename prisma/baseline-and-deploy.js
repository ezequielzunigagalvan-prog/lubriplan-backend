/**
 * Baseline + migrate deploy
 *
 * Problema: la DB fue creada con `prisma db push`, por lo que no tiene
 * tabla _prisma_migrations. `prisma migrate deploy` falla con P3005
 * ("database schema is not empty") hasta que cada migration esté marcada
 * como ya aplicada (baseline).
 *
 * Este script:
 * 1. Lee todos los directorios de prisma/migrations/
 * 2. Llama `prisma migrate resolve --applied <name>` en cada uno
 *    (si ya está registrada, Prisma devuelve error no-fatal → se ignora)
 * 3. Corre `prisma migrate deploy` para aplicar cualquier migration NUEVA
 */

import { execSync } from "child_process";
import { readdirSync, statSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");

if (!existsSync(migrationsDir)) {
  console.log("No migrations directory found — skipping baseline.");
} else {
  const migrations = readdirSync(migrationsDir)
    .filter((name) => {
      const full = path.join(migrationsDir, name);
      return statSync(full).isDirectory() && /^\d{14}/.test(name);
    })
    .sort();

  console.log(`Baselining ${migrations.length} migrations...`);

  for (const migration of migrations) {
    try {
      execSync(`npx prisma migrate resolve --applied "${migration}"`, {
        stdio: "pipe",
        env: process.env,
      });
      console.log(`  ✓ baselined: ${migration}`);
    } catch {
      // Ya estaba registrada — no es un error
      console.log(`  → already tracked: ${migration}`);
    }
  }
}

console.log("Running prisma migrate deploy...");
execSync("npx prisma migrate deploy", { stdio: "inherit", env: process.env });
