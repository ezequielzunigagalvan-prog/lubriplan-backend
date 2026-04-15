-- AlterTable
ALTER TABLE "Route" ADD COLUMN "imagePublicId" TEXT;

-- AlterTable
ALTER TABLE "Execution" ADD COLUMN "evidenceImagePublicId" TEXT;

-- AlterTable
ALTER TABLE "condition_reports" ADD COLUMN "evidenceImagePublicId" TEXT;
