import prisma from '../src/prisma.js';

async function enableMaintenance() {
  try {
    // Get all plants
    const plants = await prisma.plant.findMany();

    if (plants.length === 0) {
      console.log('❌ No plants found');
      process.exit(1);
    }

    for (const plant of plants) {
      // Check if already exists
      const existing = await prisma.mtPlantAccess.findUnique({
        where: { plantId: plant.id }
      });

      if (existing) {
        // Update if disabled
        if (!existing.enabled) {
          await prisma.mtPlantAccess.update({
            where: { plantId: plant.id },
            data: { enabled: true }
          });
          console.log(`✅ Maintenance enabled for ${plant.name}`);
        } else {
          console.log(`⚠️ Maintenance already enabled for ${plant.name}`);
        }
      } else {
        // Create new
        await prisma.mtPlantAccess.create({
          data: {
            plantId: plant.id,
            enabled: true,
            plan: 'COMPLETE'
          }
        });
        console.log(`✅ Maintenance enabled for ${plant.name}`);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

enableMaintenance();
