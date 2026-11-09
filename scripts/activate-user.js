import prisma from '../src/prisma.js';

async function activateUser() {
  const email = 'admin@lubriplan.com';

  try {
    const user = await prisma.user.update({
      where: { email },
      data: { active: true }
    });

    console.log('✅ User activated!');
    console.log(`📧 Email: ${user.email}`);
    console.log(`👤 Name: ${user.name}`);
    console.log(`🔓 Active: ${user.active}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

activateUser();
