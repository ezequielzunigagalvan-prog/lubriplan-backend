import prisma from '../src/prisma.js';
import bcrypt from 'bcryptjs';

async function createUser() {
  const email = 'admin@lubriplan.com';
  const password = 'Admin123!';
  const name = 'Admin Usuario';

  try {
    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Check if user exists
    const existing = await prisma.user.findUnique({
      where: { email }
    });

    if (existing) {
      console.log(`❌ User ${email} already exists`);
      process.exit(1);
    }

    // Create user
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        role: 'ADMIN',
        active: true,
      }
    });

    console.log('✅ User created successfully!');
    console.log(`📧 Email: ${email}`);
    console.log(`🔐 Password: ${password}`);
    console.log(`👤 Role: ${user.role}`);

  } catch (error) {
    console.error('❌ Error creating user:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

createUser();
