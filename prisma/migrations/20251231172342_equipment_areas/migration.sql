-- AlterTable
ALTER TABLE "LubricantMovement" ADD COLUMN     "executionId" INTEGER;

-- CreateIndex
CREATE INDEX "LubricantMovement_executionId_idx" ON "LubricantMovement"("executionId");
