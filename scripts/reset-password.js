// scripts/reset-password.js
// Restablece la contraseña de un usuario directamente en la base de datos.
//
// Uso (PowerShell), contra producción con Railway:
//   $env:RESET_EMAIL="admin@lubriplan.com"; $env:RESET_PASSWORD="TuNuevaClave"; railway run node scripts/reset-password.js
//
// - La contraseña NO va escrita en el código (antes estaba fija y guardada en git).
// - Si existe DATABASE_PUBLIC_URL (Railway), se usa esa: la URL interna de Railway
//   no es accesible desde tu computadora.
// - Además activa al usuario si estaba inactivo y muestra sus plantas.

import bcrypt from "bcryptjs";

if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

const email = String(process.env.RESET_EMAIL || process.argv[2] || "").trim().toLowerCase();
const newPassword = String(process.env.RESET_PASSWORD || "");

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

try {
  if (!email) fail("Falta el correo: define RESET_EMAIL.");
  if (newPassword.length < 8) fail("La contraseña debe tener al menos 8 caracteres (define RESET_PASSWORD).");

  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL).host;
    } catch {
      return "(desconocido)";
    }
  })();
  console.log(`🔌 Base de datos: ${host}`);

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      role: true,
      active: true,
      userPlants: { select: { active: true, isDefault: true, plant: { select: { id: true, name: true } } } },
    },
  });
  if (!user) fail(`No existe un usuario con el correo ${email} en esta base de datos.`);

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash, active: true } });

  console.log("✅ Contraseña restablecida.");
  console.log(`📧 Usuario: ${email} (id ${user.id}, rol ${user.role})`);
  if (!user.active) console.log("ℹ️  El usuario estaba inactivo y se reactivó.");
  if (!user.userPlants.length) {
    console.log("⚠️  El usuario no tiene plantas asignadas: podrá entrar, pero no verá datos.");
  } else {
    for (const up of user.userPlants) {
      console.log(`🏭 Planta: ${up.plant.name} (id ${up.plant.id})${up.isDefault ? " · predeterminada" : ""}${up.active ? "" : " · INACTIVA"}`);
    }
  }
} catch (e) {
  fail(e?.message || String(e));
} finally {
  await prisma.$disconnect();
}
