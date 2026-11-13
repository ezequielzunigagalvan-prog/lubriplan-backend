import prisma from "../src/prisma.js";
import bcrypt from "bcryptjs";

async function initDemo() {
  try {
    console.log("🚀 Inicializando demo...\n");

    // 1. Crear planta
    let plant = await prisma.plant.findFirst();
    if (!plant) {
      console.log("📝 Creando planta de demo...");
      plant = await prisma.plant.create({
        data: {
          name: "Planta Demo Lubriplan",
          timezone: "America/Mexico_City",
          active: true,
        },
      });
      console.log(`✅ Planta creada: ${plant.name} (ID: ${plant.id})\n`);
    } else {
      console.log(`✅ Planta existente: ${plant.name} (ID: ${plant.id})\n`);
    }

    // 2. Crear usuario
    const testEmail = "test@lubriplan.local";
    let user = await prisma.user.findUnique({ where: { email: testEmail } });

    if (!user) {
      console.log("📝 Creando usuario de prueba...");
      const passwordHash = await bcrypt.hash("password", 10);
      user = await prisma.user.create({
        data: {
          email: testEmail,
          name: "Admin Demo",
          passwordHash,
          role: "ADMIN",
          active: true,
        },
      });
      console.log(`✅ Usuario creado: ${user.email}\n`);
    } else {
      console.log(`✅ Usuario existente: ${user.email}\n`);
    }

    // 3. Asignar usuario a planta
    const userPlant = await prisma.userPlant.findUnique({
      where: { userId_plantId: { userId: user.id, plantId: plant.id } },
    });

    if (!userPlant) {
      console.log("📝 Asignando usuario a planta...");
      await prisma.userPlant.create({
        data: {
          userId: user.id,
          plantId: plant.id,
          isDefault: true,
          active: true,
        },
      });
      console.log("✅ Usuario asignado a planta\n");
    }

    console.log("✅ Sistema inicializado\n");

    // 5. Mostrar resumen
    console.log("=".repeat(50));
    console.log("🎉 DEMO INICIALIZADO");
    console.log("=".repeat(50));
    console.log("\n📋 CREDENCIALES:");
    console.log(`   Email:    test@lubriplan.local`);
    console.log(`   Password: password`);
    console.log(`   Rol:      ADMIN`);
    console.log("\n🔗 ACCEDER:");
    console.log(`   Frontend: http://localhost:5173/maintenance`);
    console.log(`   Backend:  http://localhost:3001/api-docs`);
    console.log("\n📊 DATOS DISPONIBLES:");
    console.log(`   Planta:      1 (${plant.name})`);
    console.log(`   Usuario:     1 (ADMIN)`);
    console.log(`   Puedes crear: equipos, técnicos, refacciones, planes`);
    console.log("\n✅ YA PUEDES CREAR PLANES");
    console.log("=".repeat(50));

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

initDemo();
