#!/bin/bash

# Script de diagnóstico rápido para producción
# Uso: bash diagnose-prod.sh

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║          DIAGNÓSTICO DE PRODUCCIÓN - OLP ERRORS                ║"
echo "║              Ejecutando en: $(hostname)                        ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# 1. Verificar que el backend está online
echo "✓ TEST 1: ¿Backend está online?"
echo "────────────────────────────────────────────────────────────────"
HEALTH=$(curl -s https://api.lubriplan.com/health)
if echo "$HEALTH" | grep -q "status.*ok"; then
    echo "✅ Backend está online"
    echo "   Response: $HEALTH"
else
    echo "❌ Backend está DOWN o no responde"
    echo "   Response: $HEALTH"
fi
echo ""

# 2. Verificar que el commit e1f6712 está deployado
echo "✓ TEST 2: ¿Commit e1f6712 está en producción?"
echo "────────────────────────────────────────────────────────────────"
CURRENT_COMMIT=$(git log --oneline | head -1 | cut -d' ' -f1)
echo "   Commit actual en servidor: $CURRENT_COMMIT"
if [ "$CURRENT_COMMIT" = "e1f6712" ]; then
    echo "✅ Commit e1f6712 está deployado"
else
    echo "❌ Commit e1f6712 NO está deployado"
    echo "   Se necesita: git pull origin main"
fi
echo ""

# 3. Verificar que CORS está en el código
echo "✓ TEST 3: ¿CORS está en el código?"
echo "────────────────────────────────────────────────────────────────"
if grep -q "allowedOrigins.*www.lubriplan.com" src/index.js 2>/dev/null; then
    echo "✅ CORS con www.lubriplan.com está en src/index.js"
else
    echo "❌ CORS NO está configurado correctamente"
fi
echo ""

# 4. Verificar migraciones de Prisma
echo "✓ TEST 4: ¿Prisma migrations están actualizadas?"
echo "────────────────────────────────────────────────────────────────"
MIGRATIONS=$(npx prisma migrate status 2>&1 | head -5)
if echo "$MIGRATIONS" | grep -q "All migrations have been applied"; then
    echo "✅ Todas las migraciones están aplicadas"
else
    echo "⚠️  Hay migraciones pendientes o errores"
    echo "   $MIGRATIONS"
fi
echo ""

# 5. Test endpoint /api/settings
echo "✓ TEST 5: ¿GET /api/settings funciona?"
echo "────────────────────────────────────────────────────────────────"
SETTINGS=$(curl -s -w "\n%{http_code}" https://api.lubriplan.com/api/settings 2>&1)
HTTP_CODE=$(echo "$SETTINGS" | tail -1)
BODY=$(echo "$SETTINGS" | head -1)
if [ "$HTTP_CODE" = "401" ]; then
    echo "⚠️  HTTP 401 (sin token, es normal)"
    echo "   Se necesita enviar Authorization header"
elif [ "$HTTP_CODE" = "200" ]; then
    echo "✅ GET /api/settings respondió 200"
    echo "   Response: $BODY"
else
    echo "❌ GET /api/settings devolvió HTTP $HTTP_CODE"
    echo "   Response: $BODY"
fi
echo ""

# 6. Test endpoint /api/preventive-orders
echo "✓ TEST 6: ¿GET /api/preventive-orders funciona?"
echo "────────────────────────────────────────────────────────────────"
ORDERS=$(curl -s -w "\n%{http_code}" https://api.lubriplan.com/api/preventive-orders?page=1 2>&1)
HTTP_CODE=$(echo "$ORDERS" | tail -1)
BODY=$(echo "$ORDERS" | head -1)
if [ "$HTTP_CODE" = "401" ]; then
    echo "⚠️  HTTP 401 (sin token, es normal)"
elif [ "$HTTP_CODE" = "200" ]; then
    echo "✅ GET /api/preventive-orders respondió 200"
    echo "   Response: $BODY"
else
    echo "❌ GET /api/preventive-orders devolvió HTTP $HTTP_CODE"
    echo "   Response: $BODY"
fi
echo ""

# 7. Revisar logs de error
echo "✓ TEST 7: ¿Hay errores en los logs?"
echo "────────────────────────────────────────────────────────────────"
if command -v docker &> /dev/null; then
    ERRORS=$(docker-compose logs lubriplan-api 2>&1 | grep -i "error\|500" | tail -3)
    if [ -z "$ERRORS" ]; then
        echo "✅ No hay errores en logs de Docker"
    else
        echo "⚠️  Se encontraron errores en logs:"
        echo "$ERRORS"
    fi
else
    ERRORS=$(pm2 logs lubriplan-backend 2>&1 | grep -i "error\|500" | tail -3)
    if [ -z "$ERRORS" ]; then
        echo "✅ No hay errores en logs de PM2"
    else
        echo "⚠️  Se encontraron errores en logs:"
        echo "$ERRORS"
    fi
fi
echo ""

# RESUMEN
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                      RESUMEN DE DIAGNÓSTICO                    ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "PRÓXIMOS PASOS:"
echo ""
if [ "$CURRENT_COMMIT" != "e1f6712" ]; then
    echo "1️⃣  Hacer pull del commit e1f6712:"
    echo "   git pull origin main"
    echo ""
fi
echo "2️⃣  Re-ejecutar migraciones de Prisma:"
echo "   npx prisma migrate deploy"
echo ""
echo "3️⃣  Regenerar Prisma Client:"
echo "   npx prisma generate"
echo ""
echo "4️⃣  Reiniciar backend:"
echo "   docker-compose restart lubriplan-api"
echo "   (O: pm2 restart lubriplan-backend)"
echo ""
echo "5️⃣  Esperar 10 segundos y verificar:"
echo "   curl https://api.lubriplan.com/health"
echo ""
