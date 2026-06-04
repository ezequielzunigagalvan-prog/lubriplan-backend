# 🚨 DIAGNÓSTICO URGENTE - ERRORES EN PRODUCCIÓN

**Fecha:** 2026-06-04  
**Severidad:** 🔴 CRÍTICA  
**Status:** INVESTIGACIÓN

---

## 📋 ERRORES REPORTADOS

### Error 1: MIME Type - JavaScript no carga
```
Failed to load module script: Expected a JavaScript-or-Wasm module 
but the server responded with a MIME type of "text/html"

Failed to fetch dynamically imported module: 
https://www.lubriplan.com/assets/PreventiveOrderForm-CTdXXoqF.js
```

**Causa:** El servidor está sirviendo HTML en lugar de JavaScript para archivos `.js`

**Impacto:** El frontend no puede cargar el componente PreventiveOrderForm → ErrorBoundary

---

### Error 2: CORS sigue bloqueado
```
Access to fetch at 'https://api.lubriplan.com/api/preventive-orders...' 
blocked by CORS policy: No 'Access-Control-Allow-Origin' header
```

**Causa:** El servidor de producción **NO está ejecutando el código con CORS configurado**

**Impacto:** El frontend no puede hacer fetch al backend

---

### Error 3: GET /api/preventive-orders timeout
```
Error loading orders: Error: Tiempo de espera agotado (timeout)
```

**Causa:** La tabla PreventiveOrder podría no existar o migración no se ejecutó

**Impacto:** La página de órdenes no carga

---

## 🔍 RAÍZ DE TODOS LOS PROBLEMAS

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  EL CÓDIGO ACTUALIZADO NUNCA LLEGÓ A PRODUCCIÓN                │
│                                                                 │
│  Los commits en GitHub están:                                  │
│  ✅ e1f6712 (fixes OLP)                                        │
│  ✅ 93d9840 (diagnósticos)                                     │
│  ✅ a10b903 (migración fix_missing_fields)                     │
│                                                                 │
│  Pero en el servidor api.lubriplan.com está corriendo:         │
│  ❌ CÓDIGO VIEJO (probablemente del 31 de mayo)                │
│                                                                 │
│  Evidencia:                                                     │
│  1. CORS no funciona (el código está en e1f6712, no en viejo)  │
│  2. Tabla PreventiveOrder no existe (migración no ejecutada)   │
│  3. Frontend broken (probably old build)                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ SOLUCIÓN (PASO A PASO)

### PASO 1: Verificar qué código está corriendo en PRODUCCIÓN

```bash
# SSH al servidor
ssh user@api.lubriplan.com

# Ver último commit en servidor
cd /home/lubriplan/lubriplan-backend
git log --oneline | head -5

# ¿QUÉ VES?
# Si ves: e1f6712, 93d9840, a10b903 → El código sí está
# Si NO los ves → El pull NUNCA se ejecutó
```

### PASO 2: Si el código NO está, hacer PULL

```bash
git pull origin main

# Esto debe traer:
# Commit e1f6712 (OLP fixes con CORS)
# Commit 93d9840 (diagnósticos)
# Commit a10b903 (migración fix_missing_fields)
```

### PASO 3: Si el código YA está, regenerar Prisma

```bash
npx prisma generate
npx prisma migrate deploy
```

### PASO 4: Reiniciar TODO

```bash
docker-compose down
docker-compose up -d

# Esperar 30 segundos
sleep 30

# Verificar
curl https://api.lubriplan.com/health
```

### PASO 5: Frontend - Verificar build y servicio

El error de MIME type en PreventiveOrderForm.js sugiere:

**Opción A:** El build de Vite/Webpack no se ejecutó
```bash
# En frontend repo:
npm run build
```

**Opción B:** Nginx no está sirviendo archivos correctamente
```bash
# Verificar nginx.conf
cat /etc/nginx/sites-enabled/www.lubriplan.com

# Debe tener:
location /assets/ {
  alias /var/www/lubriplan-frontend/dist/assets/;
  gzip on;
  expires 1y;
  add_header Cache-Control "public, immutable";
}

# Si NO está, agregarlo y hacer: sudo systemctl restart nginx
```

**Opción C:** El archivo no existe en disco
```bash
# Verificar que el archivo existe
ls -la /var/www/lubriplan-frontend/dist/assets/ | grep PreventiveOrderForm
```

---

## 📋 CHECKLIST DE RESOLUCIÓN

```
BACKEND:
[ ] 1. git log --oneline | head -5 → Ver si e1f6712, 93d9840, a10b903 están
[ ] 2. Si NO están: git pull origin main
[ ] 3. npx prisma migrate deploy
[ ] 4. docker-compose restart lubriplan-api
[ ] 5. curl https://api.lubriplan.com/health → {"status":"ok"}

FRONTEND:
[ ] 1. npm run build (en carpeta frontend)
[ ] 2. Verificar que dist/assets/ tiene PreventiveOrderForm*.js
[ ] 3. Verificar nginx está sirviendo /assets/ correctamente
[ ] 4. Limpiar caché: Ctrl+Shift+Delete
[ ] 5. Recargar: F5

TEST:
[ ] 1. curl https://api.lubriplan.com/api/preventive-orders
      → Debe devolver: {"data":[],"total":0,...} (no timeout, no error)
[ ] 2. Abrir https://www.lubriplan.com/preventive-orders
      → Debe cargar sin errores de MIME type
[ ] 3. Verificar CORS: curl -I -H "Origin: https://www.lubriplan.com" \
      https://api.lubriplan.com/health
      → Debe incluir: Access-Control-Allow-Origin: https://www.lubriplan.com
```

---

## ⚠️ RESUMEN

**El problema NO es el código.**

El código en GitHub está **100% correcto**. El problema es que:

1. **Backend:** El deployment a producción nunca se completó
   - Solución: `git pull origin main` + `npx prisma migrate deploy` + `docker restart`

2. **Frontend:** El build viejo o nginx mal configurado
   - Solución: `npm run build` (si es frontend builder issue) o verificar nginx

3. **CORS:** Funcionará una vez que el código e1f6712 esté ejecutándose

**Tiempo estimado para resolver:** 5-10 minutos

---

**¿Cuál es el OUTPUT de `git log --oneline | head -5` en el servidor?**

Eso me dirá exactamente dónde está el problema.
