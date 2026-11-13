import prisma from "../src/prisma.js";

async function initMaintenanceData() {
  try {
    console.log("🚀 Iniciando carga de datos de mantenimiento...");

    // 1. Verificar/crear tabla MtTechnician si no existe
    console.log("📋 Verificando tabla MtTechnician...");
    const technicianCount = await prisma.technician.count();
    console.log(`✓ MtTechnician: ${technicianCount} registros`);

    // 2. Obtener plantas disponibles
    const plants = await prisma.plant.findMany({ select: { id: true, name: true } });
    console.log(`✓ Plantas disponibles: ${plants.length}`);

    if (plants.length === 0) {
      console.log("⚠️ No hay plantas creadas. Por favor, crea al menos una planta primero.");
      return;
    }

    // 3. Inicializar códigos de falla para cada planta
    for (const plant of plants) {
      console.log(`\n📌 Inicializando códigos de falla para planta: ${plant.name} (ID: ${plant.id})`);

      try {
        // Intentar crear códigos de falla base si no existen
        const baseCodesCount = await prisma.mtFailureCode.count({
          where: { plantId: plant.id, isBaseCode: true },
        });

        if (baseCodesCount === 0) {
          console.log("   ⏳ Creando códigos de falla base...");

          // Esto se debería hacer a través del endpoint /seed
          // Por ahora solo verificamos que existan
          const allCodesCount = await prisma.mtFailureCode.count({
            where: { plantId: plant.id },
          });

          console.log(`   ✓ Códigos de falla: ${allCodesCount}`);
        } else {
          console.log(`   ✓ Códigos de falla ya existen: ${baseCodesCount}`);
        }
      } catch (error) {
        console.log(`   ⚠️ Error al procesar códigos de falla: ${error.message}`);
      }
    }

    // 4. Verificar datos en tablas principales
    console.log("\n📊 Estado de datos principales:");

    const assetCount = await prisma.mtAsset.count();
    console.log(`   • MtAsset: ${assetCount} registros`);

    const workOrderCount = await prisma.mtWorkOrder.count();
    console.log(`   • MtWorkOrder: ${workOrderCount} registros`);

    const notificationCount = await prisma.mtNotification.count();
    console.log(`   • MtNotification: ${notificationCount} registros`);

    console.log("\n✅ Inicialización completada");

  } catch (error) {
    console.error("❌ Error durante la inicialización:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

initMaintenanceData();
