import prisma from '../src/prisma.js';

async function diagnose() {
  try {
    // Get user
    const user = await prisma.user.findUnique({
      where: { email: 'admin@lubriplan.com' },
      include: {
        userPlants: {
          include: { plant: true }
        }
      }
    });

    console.log('\n👤 User:', user.email);
    console.log('   Active:', user.active);
    console.log('   Has password:', !!user.passwordHash);

    console.log('\n🏢 Plants:');
    user.userPlants.forEach(up => {
      console.log(`   - ${up.plant.name} (ID: ${up.plant.id})`);
      console.log(`     Active: ${up.active}, Default: ${up.isDefault}`);
    });

    console.log('\n🔧 Maintenance Access:');
    const plants = user.userPlants.map(up => up.plant.id);

    for (const plantId of plants) {
      const access = await prisma.mtPlantAccess.findUnique({
        where: { plantId }
      });

      const plant = user.userPlants.find(up => up.plant.id === plantId).plant;
      if (access) {
        console.log(`   ${plant.name}: Enabled=${access.enabled}, Plan=${access.plan}`);
      } else {
        console.log(`   ${plant.name}: NOT CONFIGURED`);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

diagnose();
