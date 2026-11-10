import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function seedAssets() {
  try {
    console.log("🌱 Seeding test assets...");

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as total FROM "MtAsset" WHERE plantid = 1`
    );

    const total = parseInt(countResult[0]?.total || 0);

    if (total === 0) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "MtAsset" (plantid, level, code, name, location, status, createdat, updatedat)
        VALUES
          (1, 'AREA', 'AREA-01', 'Producción General', 'Piso 1', 'OPERATING', NOW(), NOW()),
          (1, 'LINE', 'LINE-001', 'Línea de Ensamblaje A', 'Piso 1 - Zona A', 'OPERATING', NOW(), NOW()),
          (1, 'EQUIPMENT', 'PUMP-001', 'Bomba Hidráulica Principal', 'Piso 1 - Zona A', 'OPERATING', NOW(), NOW()),
          (1, 'EQUIPMENT', 'MOTOR-001', 'Motor Eléctrico 5HP', 'Piso 1 - Zona B', 'OPERATING', NOW(), NOW()),
          (1, 'COMPONENT', 'VALVE-001', 'Válvula de Control', 'Piso 1 - Zona A', 'OPERATING', NOW(), NOW())
      `);
      console.log("✅ Test assets inserted (5 assets)");
    } else {
      console.log(`ℹ️  Assets already exist (${total} found)`);
    }

  } catch (error) {
    console.error("❌ Error seeding assets:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

seedAssets();
