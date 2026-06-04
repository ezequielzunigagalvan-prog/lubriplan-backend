# 🚀 PLAN DE ACCIÓN - CORRECCIONES OLP

**Generado:** 2026-06-03  
**Urgencia:** 🔴 CRÍTICA  
**Tiempo estimado:** 15-30 minutos

---

## 📋 RESUMEN EJECUTIVO

La implementación del backend está **85% correcta**, pero 3 bugs críticos evitan que funcione en producción:

| Bug | Línea | Severidad | Fix | Tiempo |
|-----|-------|-----------|-----|--------|
| 1. `completedBy` tipo incorrecto | 284 | 🔴 Crítica | 1 línea | 2 min |
| 2. Sin validación `nextDate` | 306-313 | 🟡 Alta | 4 líneas | 3 min |
| 3. `sourceType` sin enum | schema | 🟡 Media | Crear enum | 5 min |
| 4. Frontend **completamente falta** | global | 🔴 Crítica | 5 archivos | 120 min |

---

## 🔧 FIX 1: completedBy (2 minutos)

**Archivo:** `src/routes/preventiveOrders.routes.js`  
**Línea:** 284

**Problema:**
```javascript
completedBy: userId  // ❌ userId es User.id, completedBy espera Technician.id
```

**Estado actual:**
- `req.user` tiene `technicianId` disponible (requireAuth lo trae en línea 77)
- Pero si `technicianId` es null, causará error FK

**Solución:**

```javascript
// OPCIÓN A: Segura (para técnicos)
if (!req.user.technicianId) {
  return res.status(400).json({ error: "Usuario no es técnico" });
}
completedBy: req.user.technicianId

// OPCIÓN B: Flexible (permite ADMIN/SUPERVISOR)
completedBy: req.user.technicianId || null  // null si no es técnico
```

**Recomendación:** Usar OPCIÓN B para permitir que SUPERVISORs completen items en campo.

---

## 🔧 FIX 2: Validar nextDate (3 minutos)

**Archivo:** `src/routes/preventiveOrders.routes.js`  
**Línea:** 306-313

**Problema:**
```javascript
const nextDate = resolveNextRouteDate({...});
// Si nextDate es null, la línea 337 usa route.nextDate (valor viejo)
// Ruta NUNCA se actualiza
```

**Solución:**

Agregar validación después de línea 313:

```javascript
const nextDate = resolveNextRouteDate({
  lastDate: new Date(),
  nextDate: null,
  frequencyDays: route.frequencyDays,
  frequencyType: route.frequencyType,
  weeklyDays: route.weeklyDays,
  monthlyAnchorDay: route.monthlyAnchorDay,
});

// AGREGAR ESTAS LÍNEAS:
if (!nextDate) {
  console.error(
    `[OLP] No se pudo calcular nextDate para route ${route.id}`,
    `frequencyType: ${route.frequencyType}, frequencyDays: ${route.frequencyDays}`
  );
  return res.status(400).json({
    error: `No se pudo calcular próxima fecha para ruta "${route.name}". Verifica su configuración de frecuencia.`,
  });
}
```

---

## 🔧 FIX 3: Agregar enum ExecutionSourceType (5 minutos)

**Archivo:** `prisma/schema.prisma`

**Problema:**
```prisma
sourceType String? @default("ROUTE")  // String libre = sin validación
```

**Solución:**

**Paso 1:** Localizar enums (buscar "enum" en schema.prisma)

**Paso 2:** Agregar nuevo enum después de `enum UserRole`:

```prisma
enum UserRole {
  ADMIN
  SUPERVISOR
  TECHNICIAN
}

// AGREGAR ESTE ENUM:
enum ExecutionSourceType {
  ROUTE
  OLP
}

// ... resto de enums ...
```

**Paso 3:** En modelo `Execution`, cambiar:

```prisma
// ANTES:
sourceType String? @default("ROUTE")

// DESPUÉS:
sourceType ExecutionSourceType @default(ROUTE)
```

**Paso 4:** Crear migración:

```bash
cd C:\Users\ferga\Documents\lubriplan-backend
npx prisma migrate dev --name "add_ExecutionSourceTypeEnum"
```

---

## 📝 ORDEN DE EJECUCIÓN

```
1. FIX 1: Editar línea 284 preventiveOrders.routes.js
2. FIX 2: Editar línea 306-313 preventiveOrders.routes.js
3. FIX 3: Editar schema.prisma + migración
4. Correr: npm run dev
5. Correr: npm run build
6. Correr: npx prisma migrate deploy (en prod)
7. Test: Postman /api/preventive-orders
8. Deploy: A producción
```

---

## 💻 COMANDOS EXACTOS

### Paso 1-2: Editar preventiveOrders.routes.js

```bash
# Editar archivo en tu editor (VS Code, etc)
# Cambios:
# - Línea 284: userId → req.user.technicianId || null
# - Línea 313+: Agregar if (!nextDate) return res.status(400)...
```

### Paso 3: Editar schema.prisma

```bash
# Editar archivo en tu editor
# Cambios:
# - Agregar enum ExecutionSourceType
# - Cambiar sourceType String? → sourceType ExecutionSourceType @default(ROUTE)
```

### Paso 4: Migración

```bash
cd C:\Users\ferga\Documents\lubriplan-backend

# Crear migración
npx prisma migrate dev --name "add_ExecutionSourceTypeEnum"

# Esto hará 2 cosas:
# 1. Generará SQL para convertir String → Enum
# 2. Actualizará prisma/schema.prisma
```

### Paso 5-6: Verificar

```bash
npm run dev
# Debe correr sin errores

npm run build
# Debe completar sin warnings críticos
```

### Paso 7: Test en local

```bash
# Abrir Postman:

POST http://localhost:3000/api/preventive-orders
Headers: 
  Authorization: Bearer <TOKEN>
  x-plant-id: 1
Body:
{
  "equipmentId": 1,
  "scheduledDate": "2026-06-15",
  "title": "Test OLP"
}

# Esperado: 201 Created con orden completa
```

### Paso 8: Deploy a producción

```bash
# En servidor de producción:
cd /home/lubriplan/lubriplan-backend  # (ajusta a tu path)

git pull origin main
npm install
npm run build
npx prisma migrate deploy  # Ejecuta migración en DB prod

# Reiniciar servicio:
docker-compose restart lubriplan-api
# O si es PM2:
pm2 restart lubriplan-backend
```

---

## ⚠️ PROBLEMAS POTENCIALES Y SOLUCIONES

### Problema: "Timeout en GET /api/preventive-orders"

**Síntomas:** Petición de GET tarda >30s o timeout

**Causa más probable:** 
1. Base de datos tiene muchas órdenes (>1000)
2. El `include` está cargando todos los items de cada orden
3. Falta índice compuesto en Prisma

**Solución temporal:**
```javascript
// En GET /:id (línea 78-81), agregar:
items: { 
  select: { 
    id: true, 
    status: true, 
    route: { select: { name: true } }
  },
  take: 10  // Solo primeros 10 items
}
```

**Solución permanente:**
```prisma
// En PreventiveOrder, agregar índice:
@@index([plantId, status, createdAt])
```

---

### Problema: "completedBy no puede ser null"

**Si recibiste error FK después de fix:**

```
Error: Foreign key constraint failed on the field: `completedBy`
```

**Causa:** El usuario no tiene technicianId (es ADMIN/SUPERVISOR)

**Soluciones:**

**A) Permitir null** (recomendado):
```javascript
completedBy: req.user.technicianId || null
```

**B) Requerir ser técnico:**
```javascript
if (!req.user.technicianId) {
  return res.status(403).json({ error: "Solo técnicos pueden completar items" });
}
completedBy: req.user.technicianId
```

---

### Problema: "ExecutionSourceType no existe"

**Si el enum falta en schema:**

```
Error: Unknown type "ExecutionSourceType"
```

**Solución:**
```bash
# 1. Agregar enum en schema.prisma (ver FIX 3)
# 2. Crear migración:
npx prisma migrate dev --name "add_ExecutionSourceTypeEnum"
```

---

## ✅ CHECKLIST FINAL

```
PASO 1: Editar preventiveOrders.routes.js
[ ] Línea 284: completedBy = req.user.technicianId || null
[ ] Línea 313+: if (!nextDate) return res.status(400)...
[ ] Guardar archivo

PASO 2: Editar schema.prisma
[ ] Agregar enum ExecutionSourceType
[ ] Cambiar sourceType en Execution model
[ ] Guardar archivo

PASO 3: Migración
[ ] npx prisma migrate dev --name "add_ExecutionSourceTypeEnum"
[ ] Migración generada sin errores

PASO 4: Verificación
[ ] npm run dev sin errores
[ ] npm run build sin errores

PASO 5: Test local
[ ] Postman POST /api/preventive-orders: 201 OK
[ ] Postman GET /api/preventive-orders: 200 OK (< 5 segundos)
[ ] Postman PUT /:id/items/:itemId: 200 OK + Execution creada

PASO 6: Commit y Push
[ ] git add -A
[ ] git commit -m "fix(olp): completedBy type, nextDate validation, ExecutionSourceTypeEnum"
[ ] git push origin main

PASO 7: Deploy
[ ] Deploy a api.lubriplan.com
[ ] npx prisma migrate deploy en prod
[ ] Reiniciar servicio
[ ] Verificar: curl https://api.lubriplan.com/health

PASO 8: Validación en prod
[ ] Postman desde prod: GET /api/preventive-orders
[ ] Frontend desde www.lubriplan.com puede conectar
[ ] Sin errores de CORS
```

---

## 🎯 PRÓXIMOS PASOS (Después de fixes)

1. **Crear componentes frontend** (5 archivos)
2. **Integrar en App.jsx** (4 rutas nuevas)
3. **Agregar menú en MainLayout.jsx**
4. **Test E2E:** Crear → Listar → Ejecutar → Completar
5. **Deploy**: Todo a producción

---

## 📞 SOPORTE

**Si algo falla después del fix:**

1. Revisar logs: `npm run dev` muestra errores en tiempo real
2. Validar DB: `npx prisma studio` abre GUI para ver datos
3. Verificar Prisma: `npx prisma generate` regenera cliente
4. Limpiar caché: `rm -rf node_modules/.prisma && npm install`

---

## 🏁 RESUMEN

**3 cambios simples, 15 minutos de trabajo, y OLP funciona correctamente:**

1. ✏️ 1 línea en preventiveOrders.routes.js (completedBy)
2. ✏️ 4 líneas en preventiveOrders.routes.js (validación nextDate)
3. ✏️ Agregar enum en schema.prisma y migración

**Después:** El backend estará 100% funcional y listo para integración frontend.

---

**¿Necesitas ayuda implementando estos cambios? Puedo hacer los edits directamente si lo solicitas.**
