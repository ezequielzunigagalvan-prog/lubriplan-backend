#!/bin/sh
set -e

echo "🔄 Esperando que PostgreSQL esté listo..."

# Espera activa usando el cliente psql incluido en la imagen de postgres
until node -e "
const { Client } = await import('@prisma/client/runtime/library');
" 2>/dev/null || pg_isready -h postgres -U lubriplan -d lubriplan 2>/dev/null; do
  sleep 1
done

# Fallback: espera con reintentos usando la URL de la BD directamente
MAX=30
COUNT=0
until node -e "
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
await p.\$queryRaw\`SELECT 1\`;
await p.\$disconnect();
" 2>/dev/null; do
  COUNT=$((COUNT + 1))
  if [ $COUNT -ge $MAX ]; then
    echo "❌ PostgreSQL no respondió en ${MAX} intentos. Abortando."
    exit 1
  fi
  echo "⏳ BD no lista todavía ($COUNT/$MAX)..."
  sleep 2
done

echo "✅ PostgreSQL listo."
echo "🚀 Ejecutando migraciones..."
node prisma/baseline-and-deploy.js

# Seed solo si la tabla User está vacía (primer arranque)
USER_COUNT=$(node -e "
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const n = await p.user.count();
await p.\$disconnect();
console.log(n);
" 2>/dev/null || echo "0")

if [ "$USER_COUNT" = "0" ]; then
  echo "🌱 Base de datos vacía — ejecutando seed inicial..."
  node prisma/seed.js
  echo "✅ Seed completado."
else
  echo "ℹ️  Base de datos ya tiene datos ($USER_COUNT usuarios). Seed omitido."
fi

echo "🟢 Iniciando servidor LubriPlan..."
exec node src/index.js
