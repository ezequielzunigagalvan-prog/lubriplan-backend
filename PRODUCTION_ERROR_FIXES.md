# 🚨 PRODUCTION ERROR FIXES - OLP CORS & 500 ERRORS

**Fecha:** 2026-06-04  
**Severidad:** 🔴 CRÍTICA  
**Status:** DIAGNOSING

---

## 📊 ERRORES REPORTADOS

### Error 1: CORS Bloqueado
```
Access to fetch at 'https://api.lubriplan.com/api/preventive-orders?page=1&limit=20' 
from origin 'https://www.lubriplan.com' has been blocked by CORS policy: 
No 'Access-Control-Allow-Origin' header is present
```

### Error 2: 500 en settings y dashboard
```
GET /api/dashboard/onboarding-progress → 500
GET /api/settings → 500
```

### Error 3: Timeout en preventive-orders
```
Error loading orders: Error: Tiempo de espera agotado (timeout)
```

---

## 🔍 DIAGNÓSTICO

### ✅ Backend está online
```bash
$ curl https://api.lubriplan.com/health
{"status":"ok","db":"connected"}
```

### ❌ El problema es que:

1. **CORS headers NO están siendo enviados**
   - El código en `src/index.js` líneas 146-184 está correcto
   - Pero **NO está siendo ejecutado en producción**
   - Causa: El deploy del commit e1f6712 **NO se ejecutó correctamente**

2. **500 errors en settings/dashboard**
   - Probablemente porque la migración de Prisma falló
   - O el schema.prisma tiene un problema en producción

3. **Timeout en preventive-orders**
   - Causado por los problemas anteriores
   - El endpoint existe pero no está respondiendo

---

## 🔧 SOLUCIÓN

### PASO 1: Verificar que el deploy pasó (En servidor de prod)

```bash
ssh user@api.lubriplan.com
cd /home/lubriplan/lubriplan-backend

# Ver último commit
git log --oneline | head -3

# Debe mostrar:
# e1f6712 fix(olp): completedBy type correction...
# Si NO está, hacer pull:
git pull origin main
```

### PASO 2: Verificar y re-ejecutar migraciones

```bash
# Listar migraciones
npx prisma migrate status

# Si hay migraciones pendientes:
npx prisma migrate deploy

# Regenerar cliente Prisma
npx prisma generate
```

### PASO 3: Verificar que CORS está en el código

```bash
grep -n "allowedOrigins\|app.use(cors" src/index.js

# Debe mostrar líneas 146-184 con la configuración de CORS
# Si NO está, significa que el pull NO fue exitoso
```

### PASO 4: Reiniciar el backend

```bash
docker-compose restart lubriplan-api
# O si es PM2:
pm2 restart lubriplan-backend

# Esperar 10 segundos y verificar
sleep 10
curl https://api.lubriplan.com/health
```

### PASO 5: Test de CORS desde navegador

```javascript
// Abrir DevTools → Console en https://www.lubriplan.com
// Y ejecutar:
fetch('https://api.lubriplan.com/api/preventive-orders?page=1&limit=20', {
  headers: {
    'Authorization': 'Bearer YOUR_TOKEN',
    'x-plant-id': '1'
  }
})
.then(r => r.json())
.then(d => console.log('SUCCESS', d))
.catch(e => console.error('ERROR', e))

// Si devuelve datos: ✅ CORS está trabajando
// Si devuelve CORS error: ❌ Aún hay problema
```

---

## 🚨 SI SIGUE DANDO CORS ERROR

Si después de los pasos anteriores aún tienes CORS error, hay un **proxy/nginx bloqueando**.

### Solución: Agregar CORS en nginx.conf (si existe)

```nginx
# En /etc/nginx/nginx.conf o wherever your nginx config is

server {
    listen 443 ssl;
    server_name api.lubriplan.com;

    # AGREGAR ESTAS LÍNEAS:
    add_header 'Access-Control-Allow-Origin' 'https://www.lubriplan.com' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, PATCH, DELETE, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization, x-plant-id' always;
    add_header 'Access-Control-Allow-Credentials' 'true' always;

    # Handle OPTIONS preflight
    if ($request_method = 'OPTIONS') {
        return 204;
    }

    # ... resto de tu nginx config
}
```

Luego:
```bash
sudo nginx -t  # Verificar sintaxis
sudo systemctl restart nginx
```

---

## 🚨 SI SIGUE DANDO 500 EN SETTINGS

El error 500 en `/api/settings` significa que hay un error en la lógica del backend.

### Solución: Revisar logs

```bash
# Ver logs de error
docker-compose logs lubriplan-api | grep -i "error\|500" | tail -50

# O si es PM2:
pm2 logs lubriplan-backend | grep -i "error\|500" | tail -50

# Buscar específicamente:
docker-compose logs lubriplan-api | grep "GET /settings error" -A 5
```

### Posibles causas de 500 en settings:

1. **Migración de schema.prisma falló**
   ```bash
   npx prisma migrate status
   # Si hay errores, revisar archivo de migración
   ```

2. **Campo requiresPhotoOLP no existe en DB**
   ```bash
   # Re-ejecutar migración:
   npx prisma migrate deploy
   # Luego regenerar cliente:
   npx prisma generate
   ```

3. **Problema con Prisma Client**
   ```bash
   rm -rf node_modules/.prisma
   npm install
   npx prisma generate
   ```

---

## 📋 CHECKLIST DE RECUPERACIÓN

```
EN SERVIDOR DE PRODUCCIÓN:

[ ] 1. Verificar que commit e1f6712 está en main:
       git log --oneline | head -3

[ ] 2. Si no está, hacer pull:
       git pull origin main

[ ] 3. Ejecutar migraciones:
       npx prisma migrate deploy

[ ] 4. Regenerar Prisma Client:
       npx prisma generate

[ ] 5. Reiniciar backend:
       docker-compose restart lubriplan-api
       sleep 10

[ ] 6. Verificar health:
       curl https://api.lubriplan.com/health
       # Debe devolver: {"status":"ok","db":"connected"}

[ ] 7. Test /api/settings:
       curl -H "Authorization: Bearer TOKEN" \
            -H "x-plant-id: 1" \
            https://api.lubriplan.com/api/settings
       # Debe devolver: {"ok":true,"settings":{...}}

[ ] 8. Test /api/preventive-orders:
       curl -H "Authorization: Bearer TOKEN" \
            -H "x-plant-id: 1" \
            https://api.lubriplan.com/api/preventive-orders?page=1
       # Debe devolver: {"data":[...],"total":0,...}

[ ] 9. Test CORS desde navegador:
       Abrir DevTools en https://www.lubriplan.com
       Ir a Órdenes OLP
       Verificar que se carga sin timeout
```

---

## 🔄 ALTERNATIVA: Si el deploy está completamente roto

Si el servidor está en estado muy malo, puede hacer un rollback:

```bash
# Ver historial de commits
git log --oneline | head -10

# Revertir al commit anterior (si es necesario)
git revert HEAD
git push origin main

# O si necesitas ir a un commit específico:
git checkout f73b884  # anterior commit
git push origin main --force  # ⚠️ CUIDADO: force push

# Luego en prod:
git pull origin main
docker-compose restart lubriplan-api
```

---

## 📞 RESUMEN RÁPIDO

**El problema es simple:**
1. El código CORS está correcto en el repo
2. Pero **NO fue deployado** a producción (o el deploy falló)
3. Solución: `git pull origin main` + `npx prisma migrate deploy` + restart

**Los 500 errors son secundarios:**
- Causados probablemente por migración incompleta
- Se resuelven con `npx prisma migrate deploy`

**El timeout es consecuencia de lo anterior:**
- Una vez que CORS y settings trabajen, preventive-orders funcionará

**Tiempo estimado:** 5-10 minutos para resolver todo.

---

## ❓ PREGUNTAS FRECUENTES

**¿Dónde está el error de CORS?**
- En producción, en el servidor de api.lubriplan.com
- El código está bien, pero NO está siendo ejecutado

**¿Por qué no se deployó?**
- Posibles causas:
  1. El git pull no fue automático
  2. El CI/CD no ejecutó (si tienes GitHub Actions)
  3. El manual push NO se hizo
  4. El docker-compose restart NO se ejecutó

**¿Qué es CORS?**
- Cross-Origin Resource Sharing
- Permite que www.lubriplan.com acceda a api.lubriplan.com
- Sin CORS, el navegador bloquea la solicitud

**¿Por qué aparece en consola y no en red?**
- Porque el navegador bloquea ANTES de enviar
- Es una protección de seguridad del navegador

---

**Ejecuta los pasos anterior y reporta qué pasa.** 🚀
