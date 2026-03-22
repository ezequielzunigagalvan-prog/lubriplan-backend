import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

console.log("Keys prisma:", Object.keys(prisma).filter(k => !k.startsWith("_")));
console.log("Has prisma.user?", !!prisma.user);

await prisma.$disconnect();