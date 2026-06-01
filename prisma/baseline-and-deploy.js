/**
 * Baseline + migrate deploy — versión correcta
 *
 * PROBLEMA ORIGINAL:
 *   La DB fue creada con `prisma db push` y no tiene _prisma_migrations.
 *   `prisma migrate deploy` falla con P3005 hasta que las migrations existentes
 *   estén marcadas como ya aplicadas (baseline).
 *
 * BUG ANTERIOR:
 *   El script hacía baseline de TODAS las migrations, incluidas las nuevas.
 *   Esto las marcaba como "ya aplicadas" sin correr el SQL → tablas nunca creadas.
 *
 * SOLUCIÓN:
 *   Solo se hace baseline de migrations anteriores a BASELINE_CUTOFF.
 *   Las migrations posteriores (nuevas) se dejan para que `migrate deploy`
 *   las aplique normalmente corriendo el SQL.
 *
 * Para extender el baseline en el futuro, actualiza BASELINE_CUTOFF al
 * timestamp de la última migration que ya estaba en producción antes de
 * empezar a usar este sistema.
 */

import { execSync } from "child_process";
import { readdirSync, statSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");

// Solo se hace baseline de migrations con timestamp < este valor.
// Esto corresponde al estado de la DB cuando se migró de db push a migrate.
// Migrations IGUALES O POSTERIORES a esta fecha se aplican con migrate deploy.
const BASELINE_CUTOFF = "20260521";

if (existsSync(migrationsDir)) {
  const migrations = readdirSync(migrationsDir)
    .filter((name) => {
      const full = path.join(migrationsDir, name);
      return statSync(full).isDirectory() && /^\d{14}/.test(name);
    })
    .sort();

  const toBaseline = migrations.filter((m) => m.substring(0, 8) < BASELINE_CUTOFF);
  const toApply    = migrations.filter((m) => m.substring(0, 8) >= BASELINE_CUTOFF);

  if (toBaseline.length > 0) {
    console.log(`Baselining ${toBaseline.length} migrations anteriores al corte (${BASELINE_CUTOFF})...`);
    for (const migration of toBaseline) {
      try {
        execSync(`npx prisma migrate resolve --applied "${migration}"`, {
          stdio: "pipe",
          env: process.env,
        });
        console.log(`  ✓ baselined: ${migration}`);
      } catch {
        console.log(`  → already tracked: ${migration}`);
      }
    }
  }

  if (toApply.length > 0) {
    console.log(`${toApply.length} migrations recientes serán aplicadas por migrate deploy:`);
    toApply.forEach((m) => console.log(`  · ${m}`));
  }
}

console.log("Running prisma migrate deploy...");
execSync("npx prisma migrate deploy", { stdio: "inherit", env: process.env });
