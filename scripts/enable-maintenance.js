import prisma from "../src/prisma.js";

async function enableMaintenance() {
  try {
    console.log("🚀 Habilitando módulo de mantenimiento...\n");

    // 1. Obtener la planta
    const plant = await prisma.plant.findFirst();
    if (!plant) {
      console.error("❌ No hay planta en la BD");
      process.exit(1);
    }

    console.log(`📍 Planta: ${plant.name} (ID: ${plant.id})`);

    // 2. Habilitar acceso a mantenimiento
    const mtAccess = await prisma.mtPlantAccess.upsert({
      where: { plantId: plant.id },
      update: { enabled: true, enabledAt: new Date() },
      create: {
        plantId: plant.id,
        enabled: true,
        enabledAt: new Date(),
      },
    });

    console.log(`✅ Acceso a mantenimiento habilitado\n`);

    // 3. Obtener usuario
    const user = await prisma.user.findFirst({
      where: { email: "test@lubriplan.local" },
    });

    if (user) {
      console.log(`👤 Usuario: ${user.name} (${user.email})`);
      console.log(`📋 Rol: ${user.role}`);
      console.log(`✅ El usuario tiene acceso completo\n`);
    }

    console.log("=" .repeat(50));
    console.log("🎉 MANTENIMIENTO HABILITADO");
    console.log("=" .repeat(50));
    console.log("\n🔗 ACCEDER A MANTENIMIENTO:");
    console.log(`   http://localhost:5174/maintenance/app`);
    console.log(`\n📋 CREDENCIALES:`);
    console.log(`   Email:    test@lubriplan.local`);
    console.log(`   Password: password`);
    console.log(`\n✅ YA PUEDES USAR EL MÓDULO`);
    console.log("=" .repeat(50));

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

enableMaintenance();
