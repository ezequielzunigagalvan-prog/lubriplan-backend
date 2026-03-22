/*
  Warnings:

  - A unique constraint covering the columns `[routeId,scheduledAt,status]` on the table `Execution` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Execution" ADD COLUMN     "evidenceImage" TEXT,
ADD COLUMN     "evidenceNote" TEXT;

-- CreateIndex
CREATE INDEX "Execution_routeId_idx" ON "Execution"("routeId");

-- CreateIndex
CREATE INDEX "Execution_technicianId_idx" ON "Execution"("technicianId");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_routeId_scheduledAt_status_key" ON "Execution"("routeId", "scheduledAt", "status");
