import prisma from "../src/prisma.js";
import bcrypt from "bcryptjs";
import { logger } from "../src/config/logger.js";

async function setupTestUser() {
  try {
    console.log("🚀 Configurando usuario de prueba...\n");

    // 1. Verificar que existe una planta
    const plants = await prisma.plant.findMany({ take: 1 });
    if (plants.length === 0) {
      console.log("❌ No hay plantas en la base de datos");
      console.log("   Crea una planta primero:");
      console.log("   INSERT INTO Plant (name, timezone, active, createdAt, updatedAt)");
      console.log("   VALUES ('Planta de Prueba', 'America/Mexico_City', true, NOW(), NOW());");
      return;
    }

    const plantId = plants[0].id;
    console.log(`✅ Planta encontrada: ${plants[0].name} (ID: ${plantId})\n`);

    // 2. Verificar que existe usuario de prueba
    const testEmail = "test@lubriplan.local";
    let user = await prisma.user.findUnique({
      where: { email: testEmail },
      include: { userPlants: true },
    });

    if (user) {
      console.log(`✅ Usuario de prueba existe: ${testEmail}`);
      console.log(`   ID: ${user.id}`);
      console.log(`   Activo: ${user.active}`);
      console.log(`   Plantas: ${user.userPlants.length}\n`);

      // Verificar que tiene acceso a la planta
      const hasPlantAccess = user.userPlants.some(up => up.plantId === plantId && up.active);
      if (!hasPlantAccess) {
        console.log("⚠️  Usuario no tiene acceso a la planta, agregando...");
        await prisma.userPlant.create({
          data: {
            userId: user.id,
            plantId,
            isDefault: true,
            active: true,
          },
        });
        console.log("✅ Acceso a planta agregado\n");
      }
    } else {
      // 3. Crear usuario de prueba
      console.log("📝 Creando usuario de prueba...");
      const passwordHash = await bcrypt.hash("password", 10);

      user = await prisma.user.create({
        data: {
          email: testEmail,
          name: "Usuario de Prueba",
          passwordHash,
          role: "ADMIN",
          active: true,
        },
      });

      console.log(`✅ Usuario creado: ${user.email}`);
      console.log(`   ID: ${user.id}`);
      console.log(`   Rol: ${user.role}\n`);

      // 4. Asignar a la planta
      console.log("📝 Asignando usuario a la planta...");
      await prisma.userPlant.create({
        data: {
          userId: user.id,
          plantId,
          isDefault: true,
          active: true,
        },
      });

      console.log("✅ Usuario asignado a la planta\n");
    }

    // 5. Mostrar credenciales
    console.log("=" .repeat(50));
    console.log("🎉 CONFIGURACIÓN COMPLETADA");
    console.log("=" .repeat(50));
    console.log("\n📋 CREDENCIALES DE PRUEBA:");
    console.log(`   Email:    ${testEmail}`);
    console.log(`   Password: password`);
    console.log(`\n🔗 VERIFICAR EN FRONTEND:`);
    console.log(`   1. Abre http://localhost:5173`);
    console.log(`   2. Login con las credenciales arriba`);
    console.log(`   3. Debería redirigir al dashboard`);
    console.log(`\n✅ TODO LISTO PARA PROBAR`);
    console.log("=" .repeat(50));

  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error("\n🆘 Soluciones:");
    console.error("   1. Verifica que la BD está corriendo");
    console.error("   2. Verifica que DATABASE_URL está configurado en .env");
    console.error("   3. Verifica que existen tablas (npx prisma db push)");
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

setupTestUser();
