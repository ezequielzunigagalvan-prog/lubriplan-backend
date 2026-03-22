import bcrypt from "bcryptjs";
import prisma from "../prisma.js";

const run = async () => {
  const plain = "12345";
  const hash = await bcrypt.hash(plain, 10);

  const r = await prisma.user.updateMany({
    where: { passwordHash: "12345" },
    data: { passwordHash: hash },
  });

  console.log("Updated:", r.count);
  await prisma.$disconnect();
};

run().catch((e) => {
  console.error(e);
  prisma.$disconnect();
});