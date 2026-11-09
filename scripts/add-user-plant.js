import prisma from '../src/prisma.js';

async function addUserToPlant() {
  try {
    // Get user
    const user = await prisma.user.findUnique({
      where: { email: 'admin@lubriplan.com' }
    });

    if (!user) {
      console.log('❌ User not found');
      process.exit(1);
    }

    // Get first plant
    const plant = await prisma.plant.findFirst();

    if (!plant) {
      console.log('❌ No plants found in database');
      process.exit(1);
    }

    // Check if user already has access
    const existing = await prisma.userPlant.findFirst({
      where: { userId: user.id, plantId: plant.id }
    });

    if (existing) {
      console.log('⚠️ User already has access to this plant');
      if (!existing.active) {
        // Activate if inactive
        await prisma.userPlant.update({
          where: { id: existing.id },
          data: { active: true }
        });
        console.log('✅ User plant access activated!');
      }
    } else {
      // Add user to plant
      await prisma.userPlant.create({
        data: {
          userId: user.id,
          plantId: plant.id,
          isDefault: true,
          active: true
        }
      });
      console.log('✅ User added to plant!');
    }

    console.log(`👤 User: ${user.name} (${user.email})`);
    console.log(`🏢 Plant: ${plant.name} (ID: ${plant.id})`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

addUserToPlant();
