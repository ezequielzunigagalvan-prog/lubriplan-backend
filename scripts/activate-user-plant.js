import prisma from '../src/prisma.js';

async function activateUserPlant() {
  try {
    const user = await prisma.user.findUnique({
      where: { email: 'admin@lubriplan.com' }
    });

    if (!user) {
      console.log('❌ User not found');
      process.exit(1);
    }

    // Update all UserPlant records for this user
    const result = await prisma.userPlant.updateMany({
      where: { userId: user.id },
      data: { active: true }
    });

    console.log(`✅ Activated ${result.count} plant accesses!`);

    // Show details
    const userPlants = await prisma.userPlant.findMany({
      where: { userId: user.id },
      include: { plant: { select: { name: true } } }
    });

    userPlants.forEach(up => {
      console.log(`  ✓ ${up.plant.name} (Active: ${up.active})`);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

activateUserPlant();
