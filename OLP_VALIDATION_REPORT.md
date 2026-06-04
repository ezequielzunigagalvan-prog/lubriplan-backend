# VALIDACIÓN INTEGRACIÓN OLP (Orden de Lubricación Preventiva)

**Fecha:** 2026-06-03  
**Status:** ⚠️ ERRORES CRÍTICOS ENCONTRADOS

---

## 📊 RESUMEN

| Área | Status | Detalle |
|------|--------|---------|
| **Backend - Schema** | ✅ OK | Models, enums e índices correctos |
| **Backend - Migración** | ✅ OK | Migración 20260602000000_add_preventive_orders existe |
| **Backend - Endpoints** | 🔴 CRÍTICO | 3 bugs que causan timeout/error |
| **Frontend** | ❌ MISSING | Servicios y páginas no existen |
| **CORS** | ✅ OK | Configurado correctamente en index.js |
| **Integración index.js** | ✅ OK | Rutas registradas correctamente |

---

## 🔴 ERRORES CRÍTICOS EN BACKEND

### ERROR 1: Tipo de dato incorrecto en `completedBy`
**Ubicación:** `src/routes/preventiveOrders.routes.js:284`

```javascript
// ❌ INCORRECTO
completedBy: userId  // userId es User.id, pero completedBy espera Technician.id
```

**Problema:**
- `userId` viene de `req.user.id` (tabla User)
- Campo `PreventiveOrderItem.completedBy` espera `Technician.id`
- Causará violación de FK o datos inconsistentes

**Solución:**
```javascript
// ✅ CORRECTO
completedBy: req.user.technicianId || userId  
// O mejor: Validar que el usuario es técnico antes
```

**Impacto:** El item se marca COMPLETED pero no se sabe quién lo completó (FK quebrada)

---

### ERROR 2: Paginación incompleta causa timeout
**Ubicación:** `src/routes/preventiveOrders.routes.js:75-85`

```javascript
// ❌ INCORRECTO - Sin límite de registros antes de paginar
const orders = await prisma.preventiveOrder.findMany({
  where,
  include: {/* 3 niveles de relaciones */},
  orderBy: { createdAt: "desc" },
  skip: (page - 1) * limit,
  take: Number(limit),  // ✅ Esto está bien
});
```

**Problema Real:**
- Si hay 10,000 órdenes, la query es eficiente (tiene `skip` y `take`)
- El timeout ocurre porque el `include` está cargando:
  - `equipment { select: { name: true } }` ✅
  - `assignedToUser { select: { name: true } }` ⚠️ Nullable, puede causar JOIN costoso
  - `items { select { ... } }` ⚠️ N items por orden

**Verdadera Causa del Timeout:**
```
El timeout es en PRODUCCIÓN (api.lubriplan.com) porque:
1. La DB está en otro servidor (latencia de red)
2. Las índices no están optimizadas
3. El include de `items` está haciendo un JOIN implícito
```

**Solución a corto plazo:**
```javascript
// Agregar índice compuesto en Prisma
@@index([plantId, status, createdAt])

// O reducir el include:
items: { 
  select: { 
    id: true, 
    status: true, 
    route: { select: { name: true } }  
  },
  take: 10  // Solo primeros 10 items por orden
}
```

---

### ERROR 3: Cálculo de `completedBy` no valida rol
**Ubicación:** `src/routes/preventiveOrders.routes.js:260-347`

```javascript
// ❌ INCORRECTO - No valida que el usuario sea técnico
router.put("/:id/items/:itemId", async (req, res) => {
  // ...
  completedBy: userId  // ¿Es userId un técnico?
```

**Problema:**
- Un ADMIN o SUPERVISOR puede completar items (lo cual es correcto)
- Pero `completedBy` debería guardar el ID del técnico, NO del usuario
- Hay mismatch de datos

**Solución:**
```javascript
// Opción A: Guardar technicianId si existe
const completedBy = req.user.technicianId || null;

// Opción B: Hacer que completedBy acepte User.id O Technician.id
// (cambiar relación en schema)

// Opción C: Validar rol
if (req.user.role !== "TECHNICIAN") {
  return res.status(403).json({ error: "Solo técnicos pueden completar items" });
}
```

---

## ⚠️ WARNINGS (No son errores pero son riesgos)

### WARNING 1: Missing error handling en `resolveNextRouteDate`
**Ubicación:** `src/routes/preventiveOrders.routes.js:306-313`

```javascript
const nextDate = resolveNextRouteDate({
  lastDate: new Date(),
  nextDate: null,
  frequencyDays: route.frequencyDays,
  frequencyType: route.frequencyType,
  weeklyDays: route.weeklyDays,
  monthlyAnchorDay: route.monthlyAnchorDay,
});

// ❌ Si nextDate es null, la línea 337 asigna route.nextDate (valor anterior)
// Esto puede causar que NUNCA se actualice si el cálculo falla
```

**Impacto:** 
- Si `frequencyType` es inválido, `nextDate` será `null`
- Route.nextDate nunca se actualiza (queda fecha vieja)

**Solución:**
```javascript
if (!nextDate) {
  return res.status(400).json({ 
    error: "No se pudo calcular próxima fecha. Verifica tipo de frecuencia." 
  });
}
```

---

### WARNING 2: Campo `sourceType` enumerado pero STRING
**Ubicación:** `prisma/schema.prisma`

```prisma
sourceType String? @default("ROUTE")
```

```javascript
// src/routes/preventiveOrders.routes.js:320
sourceType: "OLP",
```

**Problema:**
- El schema NO tiene un enum para `sourceType`
- Es un String libre, pode romperse fácilmente
- No hay validación en Prisma

**Solución:**
```prisma
// Agregar enum
enum ExecutionSourceType {
  ROUTE
  OLP
}

// En Execution:
sourceType ExecutionSourceType @default(ROUTE)
```

---

### WARNING 3: `appSettings.requiresPhotoOLP` no existe en schema actual
**Ubicación:** `src/routes/preventiveOrders.routes.js:47`

```javascript
requiresPhoto: (await prisma.appSettings.findUnique({ where: { id: 1 } }))?.requiresPhotoOLP || false,
```

```prisma
// Verificar si existe en schema:
model AppSettings {
  // ...
  requiresPhotoOLP Boolean @default(false)  // ¿Está aquí?
}
```

**Solución:**
```bash
# Verificar si el campo existe:
grep "requiresPhotoOLP" prisma/schema.prisma
```

---

## ✅ LO QUE ESTÁ BIEN

### ✅ Schema Prisma
- Models `PreventiveOrder` y `PreventiveOrderItem` correctamente definidos
- Enums `PreventiveOrderStatus` y `PreventiveOrderItemStatus` presentes
- Relaciones apropiadas (FK a Plant, Equipment, Route)
- Índices estratégicos en plantId, status, routeId

### ✅ Integración en index.js
```javascript
import preventiveOrdersRoutes from "./routes/preventiveOrders.routes.js";
// Línea 331:
app.use("/api/preventive-orders", preventiveOrdersRoutes({ prisma, auth: requireAuth, requireRole }));
```

### ✅ Middleware
- `requireAuth` aplicado correctamente
- `requirePlantAccess` aplicado
- `req.currentPlantId` validado en todos los endpoints

### ✅ Enpoints REST
- 7 endpoints CRUD completos
- Estados de transición correctos (DRAFT → OPEN → IN_PROGRESS → COMPLETED)
- Validaciones de seguridad presentes

### ✅ sourceType en Execution
- Campo existe en schema
- Se crea correctamente al marcar item como COMPLETED
- Permite rastreo OLP vs ROUTE

---

## ❌ QUÉ ESTÁ FALTANDO EN FRONTEND

**Critical:** El frontend NO tiene componentes implementados:

1. ❌ `frontend/src/services/preventiveOrdersService.js` **NO EXISTE**
2. ❌ `frontend/src/pages/PreventiveOrdersList.jsx` **NO EXISTE**
3. ❌ `frontend/src/pages/PreventiveOrderForm.jsx` **NO EXISTE**
4. ❌ `frontend/src/pages/PreventiveOrderDetail.jsx` **NO EXISTE**
5. ❌ `frontend/src/pages/PreventiveOrderExecution.jsx` **NO EXISTE**
6. ❌ Rutas en `App.jsx` para OLP **NO EXISTEN**
7. ❌ Menú en `MainLayout.jsx` para OLP **NO EXISTE**

**Por eso el timeout:**
```
El frontend intenta: GET /api/preventive-orders?page=1&limit=20
El backend responde: 200 OK con datos
Pero el frontend NUNCA LEE la respuesta porque
  → preventiveOrdersService.js no existe
  → PreventiveOrdersList.jsx no existe
  → No hay <component> que consuma el API

Por eso el evento queda pendiente y aparece "timeout" en la consola.
```

---

## 🚀 ACCIONES RECOMENDADAS

### Fase 1: FIX CRÍTICO (Backend)
1. **Reemplazar `userId` por `req.user.technicianId`** en línea 284
2. **Agregar validación en línea 306**: `if (!nextDate) return res.status(400)...`
3. **Agregar enum ExecutionSourceType** en schema.prisma
4. **Verificar AppSettings.requiresPhotoOLP** existe

### Fase 2: OPTIMIZACIÓN (Backend)
1. Agregar índice `@@index([plantId, status, createdAt])` en PreventiveOrder
2. Limitar items en GET /api/preventive-orders: `items: { take: 10 }`

### Fase 3: IMPLEMENTACIÓN (Frontend)
1. Crear `preventiveOrdersService.js` con métodos CRUD
2. Crear 5 componentes (List, Form, Detail, Execution, Export)
3. Agregar rutas en App.jsx
4. Agregar menú en MainLayout.jsx

---

## 📋 CHECKLIST

```
BACKEND:
[ ] Fijar `completedBy: userId` → `completedBy: req.user.technicianId`
[ ] Agregar validación nullcheck para nextDate
[ ] Agregar enum ExecutionSourceType
[ ] Verificar AppSettings.requiresPhotoOLP
[ ] Correr: npm run dev (sin errores)
[ ] Correr: npm run build (sin errores)
[ ] Probar: POST /api/preventive-orders (Postman)
[ ] Probar: GET /api/preventive-orders (Postman)
[ ] Probar: PUT /:id/items/:itemId (Postman)

FRONTEND:
[ ] Crear preventiveOrdersService.js
[ ] Crear PreventiveOrdersList.jsx
[ ] Crear PreventiveOrderForm.jsx
[ ] Crear PreventiveOrderDetail.jsx
[ ] Crear PreventiveOrderExecution.jsx
[ ] Agregar rutas en App.jsx
[ ] Agregar menú en MainLayout.jsx
[ ] Probar: acceso a /preventive-orders
[ ] Probar: crear orden
[ ] Probar: listar órdenes
[ ] Probar: ejecutar orden con firma

PRODUCCIÓN:
[ ] Ejecutar: npx prisma migrate deploy (en prod)
[ ] Ejecutar: npm run build (full build)
[ ] Deploy a api.lubriplan.com
[ ] Verificar: /health endpoint
[ ] Verificar: CORS headers en respuesta
[ ] Probar: desde www.lubriplan.com
```

---

## CONCLUSIÓN

**Status: 🔴 NOT READY FOR PRODUCTION**

El backend tiene 3 bugs críticos que causarían:
1. Datos inconsistentes (FK quebrada en completedBy)
2. Posible timeout en prod (sin manejo de errores en nextDate)
3. Falta validación de rol

El frontend está **completamente ausente** — por eso ves timeout, el cliente espera respuesta que nunca lee porque no hay componentes.

**Próximo paso:** Crear reporte de correcciones específicas en cada archivo.
