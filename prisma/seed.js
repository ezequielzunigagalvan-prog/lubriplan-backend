import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash('Admin1234', 10);

  const user = await prisma.user.create({
    data: {
      email: 'admin@lubriplan.com',
      password,
      name: 'Administrador',
      role: 'ADMIN'
    }
  });

  console.log('✅ Usuario creado:', user.email);
}

main()
  .catch(e => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });