# 🚀 INSTRUCCIONES DE DEPLOY - OLP

**Última actualización:** 2026-06-04  
**Versión:** 1.0

---

## ✅ PASO 1: COMMIT EN LOCAL

```bash
cd C:\Users\ferga\Documents\lubriplan-backend

# Ver cambios
git status

# Stage all changes
git add -A

# Commit con mensaje descriptivo
git commit -m "fix(olp): completedBy type correction, nextDate validation, ExecutionSourceTypeEnum"

# Verificar commit
git log --oneline | head -5
```

**Resultado esperado:**
```
fix(olp): completedBy type correction, nextDate validation...
(HEAD -> main, origin/main) ...
```

---

## ✅ PASO 2: PUSH A GITHUB

```bash
git push origin main
```

**Si falla:**
```bash
# Ver conflictos
git pull origin main

# Resolver y reintentar
git push origin main
```

---

## ✅ PASO 3: VERIFICAR EN GITHUB

1. Abrir https://github.com/tu-repo/lubriplan-backend
2. Ver que el commit aparece en main
3. Verificar que todos los archivos fueron pusheados:
   - ✅ src/routes/preventiveOrders.routes.js (modificado)
   - ✅ prisma/schema.prisma (modificado)
   - ✅ FINAL_VALIDATION_REPORT.md (nuevo)
   - ✅ DEPLOY_INSTRUCTIONS.md (nuevo)

---

## ✅ PASO 4: DEPLOY A PRODUCCIÓN (BACKEND)

### Opción A: Manual en servidor

```bash
# SSH al servidor
ssh user@api.lubriplan.com

# Ir a carpeta del proyecto
cd /home/lubriplan/lubriplan-backend

# Traer cambios
git pull origin main

# Instalar dependencias (si aplica)
npm install

# Ejecutar migración de Prisma
npx prisma migrate deploy

# Verificar que la migración fue exitosa
# (Debería decir: All pending migrations have been applied)

# Reiniciar servicio
docker-compose restart lubriplan-api
# O si es PM2:
pm2 restart lubriplan-backend

# Verificar que está online
curl https://api.lubriplan.com/health
# Esperado: {"status":"ok","db":"connected"}
```

### Opción B: CI/CD (GitHub Actions / Railway)

```bash
# Si tienes GitHub Actions configurado:
# Simplemente hacer git push dispara el deploy automáticamente

# Verificar en:
# - https://github.com/tu-repo/actions
# - O tu dashboard de Railway/Vercel

# Ver logs en tiempo real:
# docker-compose logs -f lubriplan-api
# O: pm2 logs lubriplan-backend
```

---

## ✅ PASO 5: DEPLOY A PRODUCCIÓN (FRONTEND)

```bash
cd C:\Users\ferga\Documents\lubriplan-frontend

# Cambios necesarios: NINGUNO
# (El frontend ya tiene todo implementado)

# Aunque, verifica que el .env esté correcto:
cat .env

# Debe tener:
# VITE_API_URL=https://api.lubriplan.com/api
# (o tu URL de backend)

# Si necesitas cambiar:
# Editar .env y hacer git push

# Deploy (según tu setup):
# - Si es Vercel: git push automáticamente dispara deploy
# - Si es Railway: git push dispara deploy
# - Si es manual: npm run build && scp dist/* user@server:/var/www/...

# Verificar que los builds fueron exitosos:
# - Vercel: https://vercel.com/dashboard
# - Railway: https://railway.app/dashboard
```

---

## ✅ PASO 6: VALIDACIÓN POST-DEPLOY

### 6.1: Health check

```bash
# Backend
curl https://api.lubriplan.com/health
# Esperado: {"status":"ok","db":"connected"}

# Frontend
curl https://www.lubriplan.com
# Esperado: <html> (sin errores 5xx)
```

### 6.2: Test desde navegador

1. Abrir https://www.lubriplan.com
2. Login con credenciales admin
3. Ir a "Órdenes OLP"
4. Intentar crear una orden:
   - Seleccionar equipo
   - Seleccionar fecha
   - Hacer clic en Guardar
5. Verificar que aparece en la lista
6. Abrir la orden
7. Cambiar estado a OPEN
8. Asignar técnico
9. Cambiar a IN_PROGRESS
10. Ejecutar (debería mostrar warning)

### 6.3: Verificar en logs

```bash
# Ver logs del backend
docker-compose logs lubriplan-api | grep -i "preventive\|olp"

# O si es PM2:
pm2 logs lubriplan-backend | grep -i "preventive\|olp"

# Buscar errors:
docker-compose logs lubriplan-api | grep -i "error" | tail -20
```

### 6.4: Verificar CORS

```bash
# Desde navegador, abrir DevTools → Console
# Si ves: "No 'Access-Control-Allow-Origin' header"
# Significa que CORS no está bien configurado en producción

# Solución: Verificar en src/index.js líneas 146-179
# Que incluyao allowedOrigins = www.lubriplan.com

# Si está bien, reiniciar backend:
docker-compose restart lubriplan-api
```

---

## 🚨 TROUBLESHOOTING

### Error: "Tiempo de espera agotado (timeout)"

**Síntomas:**
```
Error loading orders: Error: Tiempo de espera agotado (timeout)
```

**Causas posibles:**
1. Backend no está corriendo
2. Base de datos no responde
3. CORS está bloqueando
4. Query es muy lenta

**Soluciones:**

```bash
# 1. Verificar que backend está corriendo
docker-compose ps
# Debe mostrar lubriplan-api como "Up"

# 2. Verificar que DB está online
docker-compose logs lubriplan-api | grep "database"
# Debe decir "database: connected"

# 3. Verificar logs de error
docker-compose logs lubriplan-api | tail -50

# 4. Revisar performance
# Si la query tarda > 5s, agregar índice:
# @@index([plantId, status, createdAt])

# 5. Reiniciar todo
docker-compose restart
```

---

### Error: "Foreign key constraint failed"

**Síntomas:**
```
P2014: The change you are trying to make would violate a required relation
```

**Causa:** El fix de `completedBy` no se aplicó correctamente

**Solución:**
```bash
# Verificar que el archivo tiene el fix:
grep "req.user.technicianId" src/routes/preventiveOrders.routes.js

# Debe mostrar:
# completedBy: req.user.technicianId || null

# Si no está, editarlo y hacer push nuevamente
```

---

### Error: "sourceType is not defined"

**Síntomas:**
```
Error: Unknown type "ExecutionSourceType"
```

**Causa:** La migración no se ejecutó correctamente

**Solución:**
```bash
# En producción:
cd /home/lubriplan/lubriplan-backend

# Ejecutar migración nuevamente:
npx prisma migrate deploy

# Si sigue sin funcionar, revertir a String:
# En schema.prisma, cambiar:
# sourceType ExecutionSourceType @default(ROUTE)
# Por:
# sourceType String? @default("ROUTE")
```

---

## 📋 ROLLBACK (Si algo sale mal)

```bash
# 1. Revertir último commit
git revert HEAD

# O si quieres descartar el commit completamente:
git reset --hard HEAD~1

# 2. Push revert
git push origin main

# 3. En producción, ejecutar pull nuevamente:
cd /home/lubriplan/lubriplan-backend
git pull origin main

# 4. Reiniciar
docker-compose restart lubriplan-api
```

---

## ✅ CHECKLIST PRE-DEPLOY

```
ANTES DE HACER PUSH:
[ ] Git status limpio (sin cambios uncommitted)
[ ] npm run dev sin errores (si backend lo tiene)
[ ] Todos los fixes aplicados
[ ] Cambios validados localmente

ANTES DE DEPLOY A PROD:
[ ] GitHub Actions pasaron (si tienes CI/CD)
[ ] Backed se compiló sin errores
[ ] Frontend se compiló sin errores
[ ] Base de datos está en línea

DESPUÉS DE DEPLOY:
[ ] curl /health devuelve 200 OK
[ ] Frontend carga sin errores 5xx
[ ] Puedo crear una orden sin timeout
[ ] CORS no está bloqueando
[ ] Logs no tienen errores críticos
```

---

## 📞 CONTACTO / SOPORTE

Si algo sale mal en producción:

1. **Revisar logs inmediatamente:**
   ```bash
   docker-compose logs lubriplan-api -n 100
   ```

2. **Rollback si es necesario:**
   ```bash
   git revert HEAD && git push origin main
   ```

3. **Contactar al equipo de devops**

---

## 🎯 RESUMEN DE CAMBIOS

```
Archivos modificados:
- src/routes/preventiveOrders.routes.js (+2 fixes)
- prisma/schema.prisma (+1 enum)

Total líneas cambiadas: ~15 líneas
Complejidad: BAJA
Riesgo: BAJO

Backward compatibility: ✅ SÍ
(sourceType sigue siendo String, solo agregamos enum)
```

---

**Listo para deploy. ¡Buena suerte!** 🚀
