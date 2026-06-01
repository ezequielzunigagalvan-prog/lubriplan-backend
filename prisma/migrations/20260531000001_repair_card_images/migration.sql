-- Repair migration (idempotent con IF NOT EXISTS)
--
-- La migration 20260531000000 fue marcada como "aplicada" por el script de
-- baseline sin que el SQL se ejecutara. Esta migration crea las mismas
-- estructuras con IF NOT EXISTS para que sea segura de correr aunque las
-- tablas/columnas ya existan (no hace nada en ese caso).

-- Tabla de imágenes adicionales por carta de lubricación
CREATE TABLE IF NOT EXISTS "LubricationCardImage" (
    "id"            SERIAL        NOT NULL,
    "cardId"        INTEGER       NOT NULL,
    "imageUrl"      TEXT          NOT NULL,
    "imagePublicId" TEXT,
    "label"         TEXT          NOT NULL DEFAULT 'Sección',
    "order"         INTEGER       NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LubricationCardImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LubricationCardImage_cardId_idx"
    ON "LubricationCardImage"("cardId");

-- FK LubricationCardImage → LubricationCard
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'LubricationCardImage_cardId_fkey'
      AND table_name = 'LubricationCardImage'
  ) THEN
    ALTER TABLE "LubricationCardImage"
      ADD CONSTRAINT "LubricationCardImage_cardId_fkey"
      FOREIGN KEY ("cardId") REFERENCES "LubricationCard"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Columnas nuevas en LubricationPoint
ALTER TABLE "LubricationPoint"
    ADD COLUMN IF NOT EXISTS "imageId" INTEGER,
    ADD COLUMN IF NOT EXISTS "routeId" INTEGER;

CREATE INDEX IF NOT EXISTS "LubricationPoint_imageId_idx"
    ON "LubricationPoint"("imageId");

-- FK LubricationPoint.imageId → LubricationCardImage
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'LubricationPoint_imageId_fkey'
      AND table_name = 'LubricationPoint'
  ) THEN
    ALTER TABLE "LubricationPoint"
      ADD CONSTRAINT "LubricationPoint_imageId_fkey"
      FOREIGN KEY ("imageId") REFERENCES "LubricationCardImage"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
