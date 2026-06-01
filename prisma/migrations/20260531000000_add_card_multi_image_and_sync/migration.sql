-- AddMultipleImages: tabla de imágenes adicionales para equipos grandes
CREATE TABLE "LubricationCardImage" (
    "id"            SERIAL NOT NULL,
    "cardId"        INTEGER NOT NULL,
    "imageUrl"      TEXT NOT NULL,
    "imagePublicId" TEXT,
    "label"         TEXT NOT NULL DEFAULT 'Sección',
    "order"         INTEGER NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LubricationCardImage_pkey" PRIMARY KEY ("id")
);

-- Índice por carta
CREATE INDEX "LubricationCardImage_cardId_idx" ON "LubricationCardImage"("cardId");

-- FK hacia LubricationCard
ALTER TABLE "LubricationCardImage"
    ADD CONSTRAINT "LubricationCardImage_cardId_fkey"
    FOREIGN KEY ("cardId") REFERENCES "LubricationCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddColumns: imageId (qué sección visual) y routeId (trazabilidad de sync) en LubricationPoint
ALTER TABLE "LubricationPoint"
    ADD COLUMN "imageId"  INTEGER,
    ADD COLUMN "routeId"  INTEGER;

-- Índice por imageId
CREATE INDEX "LubricationPoint_imageId_idx" ON "LubricationPoint"("imageId");

-- FK imageId → LubricationCardImage (SetNull al borrar la imagen)
ALTER TABLE "LubricationPoint"
    ADD CONSTRAINT "LubricationPoint_imageId_fkey"
    FOREIGN KEY ("imageId") REFERENCES "LubricationCardImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
