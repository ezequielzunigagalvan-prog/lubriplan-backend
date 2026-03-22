// prisma.js
import { PrismaClient } from "@prisma/client";
import { applyPrismaTenantMiddleware } from "./tenancy/prismaTenantMiddleware.js";

const prisma = new PrismaClient();

// ✅ AQUÍ EXACTO (justo después de crear PrismaClient)
applyPrismaTenantMiddleware(prisma);

export default prisma;