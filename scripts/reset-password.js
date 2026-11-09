import prisma from '../src/prisma.js';
import bcrypt from 'bcryptjs';

async function resetPassword() {
  const email = 'admin@lubriplan.com';
  const newPassword = 'Admin123!';

  try {
    const passwordHash = await bcrypt.hash(newPassword, 10);

    const user = await prisma.user.update({
      where: { email },
      data: { passwordHash }
    });

    console.log('✅ Password reset successfully!');
    console.log(`📧 Email: ${user.email}`);
    console.log(`🔐 Password: ${newPassword}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

resetPassword();
