# CORRECCIONES REQUERIDAS - ORDEN DE LUBRICACIÓN PREVENTIVA (OLP)

## 1️⃣ FIX: src/routes/preventiveOrders.routes.js

### ERROR 1.1: Línea 284 - completedBy debe ser technicianId

**Antes (❌):**
```javascript
...(status === "COMPLETED" && { completedAt: new Date(), completedBy: userId }),
```

**Después (✅):**
```javascript
...(status === "COMPLETED" && { 
  completedAt: new Date(), 
  completedBy: req.user.technicianId  // Usar technicianId de User
}),
```

**Razón:** `userId` es de tabla User, pero `completedBy` en PreventiveOrderItem es FK a Technician.id

---

### ERROR 1.2: Línea 306-313 - Agregar validación para nextDate

**Antes (❌):**
```javascript
const nextDate = resolveNextRouteDate({
  lastDate: new Date(),
  nextDate: null,
  frequencyDays: route.frequencyDays,
  frequencyType: route.frequencyType,
  weeklyDays: route.weeklyDays,
  monthlyAnchorDay: route.monthlyAnchorDay,
});

// Luego usa nextDate sin validar si es null
```

**Después (✅):**
```javascript
const nextDate = resolveNextRouteDate({
  lastDate: new Date(),
  nextDate: null,
  frequencyDays: route.frequencyDays,
  frequencyType: route.frequencyType,
  weeklyDays: route.weeklyDays,
  monthlyAnchorDay: route.monthlyAnchorDay,
});

// Validar que se calculó correctamente
if (!nextDate) {
  console.error(`No se pudo calcular nextDate para route ${route.id}. frequencyType: ${route.frequencyType}`);
  return res.status(400).json({ 
    error: "Error al calcular próxima fecha de la ruta. Verifica su tipo de frecuencia." 
  });
}
```

**Razón:** Si frequencyType es inválido, nextDate será null y route.nextDate nunca se actualiza

---

## 2️⃣ FIX: prisma/schema.prisma

### ERROR 2.1: Agregar campo requiresPhotoOLP a AppSettings

**Verificar primero:**
```bash
grep "requiresPhotoOLP" prisma/schema.prisma
```

Si **NO existe**, agregar:

**Localización:** Después de otros campos booleanos en AppSettings (línea ~50)

```prisma
// Agregar esta línea:
requiresPhotoOLP Boolean @default(false)
```

**Ejemplo completo:**
```prisma
model AppSettings {
  id Int @id @default(1)

  // Ejecución / Evidencias
  executionEvidenceRequired Boolean @default(false)
  requiresPhotoOLP Boolean @default(false)  // ← AGREGAR

  // ... resto de campos
}
```

---

### ERROR 2.2: (RECOMENDADO) Cambiar sourceType a Enum en Execution

**Localización:** Campo `sourceType` en modelo `Execution`

**Antes (❌):**
```prisma
model Execution {
  // ...
  sourceType String? @default("ROUTE")  // String libre = riesgoso
}
```

**Después (✅):**
```prisma
// Agregar enum al inicio del archivo (después de UserRole)
enum ExecutionSourceType {
  ROUTE  // Ejecución desde ruta normal
  OLP    // Ejecución desde Orden de Lubricación Preventiva
}

// Y en Execution:
model Execution {
  // ...
  sourceType ExecutionSourceType @default(ROUTE)  // Enum tipado
}
```

---

## 3️⃣ CREAR: Nueva migración Prisma

**Si hiciste cambios en schema.prisma:**

```bash
cd C:\Users\ferga\Documents\lubriplan-backend

# Crear migración (si agregaste campos o enums)
npx prisma migrate dev --name "add_requiresPhotoOLP_and_ExecutionSourceTypeEnum"

# O si ya está en producción y solo necesitas SQL:
npx prisma migrate resolve --rolled-back "add_requiresPhotoOLP_and_ExecutionSourceTypeEnum"
```

---

## 4️⃣ VERIFICACIÓN: src/index.js

**Confirmar que requiresPhotoOLP está accesible:**

En la sección donde se configuran los settings, verificar:

```javascript
// Estos aliases deben existir:
import {
  parseDateOrNull as _parseDateOrNull,
  startOfDay as _startOfDay,
  endOfDay as _endOfDay,
  toSafeNoon as _toSafeNoon,
  addMonthsClamped as _addMonthsClamped,
  getNextWeeklySelectedDate as _getNextWeeklySelectedDate,
  resolveNextRouteDate as _resolveNextRouteDate,  // ✅ Debe estar
} from "./utils/routeScheduling.js";
```

---

## 5️⃣ TESTING: Postman Tests

Una vez hecho los fixes, probar estos endpoints:

### Test 1: Crear OLP
```bash
POST /api/preventive-orders
Content-Type: application/json
Authorization: Bearer <TOKEN>
x-plant-id: 1

{
  "equipmentId": 1,
  "scheduledDate": "2026-06-15",
  "title": "Preventivo Motor A - Junio",
  "notes": "Revisar correas de transmisión"
}

# Esperado: 200 OK con PreventiveOrder completa
```

### Test 2: Listar OLPs
```bash
GET /api/preventive-orders?page=1&limit=20&status=DRAFT
Authorization: Bearer <TOKEN>
x-plant-id: 1

# Esperado: 200 OK con array de órdenes paginated
# Tiempo esperado: < 2 segundos
```

### Test 3: Completar Item (CRÍTICO)
```bash
PUT /api/preventive-orders/:id/items/:itemId
Content-Type: application/json
Authorization: Bearer <TOKEN>
x-plant-id: 1

{
  "status": "COMPLETED",
  "observations": "Lubricado correctamente",
  "photoUrl": null
}

# Esperado: 200 OK
# Verificar: 
#   - PreventiveOrderItem.status = COMPLETED
#   - PreventiveOrderItem.completedBy = user.technicianId (NO userId)
#   - Execution creada con sourceType = OLP
#   - Route.nextDate recalculada
```

---

## 6️⃣ DEBUG: Si sigue dando timeout en Producción

### Paso 1: Verificar salud del API
```bash
curl https://api.lubriplan.com/health
# Esperado: {"status":"ok","db":"connected"}
```

### Paso 2: Probar endpoint directo
```bash
curl -H "Authorization: Bearer TOKEN" \
     -H "x-plant-id: 1" \
     https://api.lubriplan.com/api/preventive-orders?limit=1

# Si timeout: el problema está en la query
# Si error de CORS: verificar config en index.js línea 155-179
```

### Paso 3: Revisar logs del servidor
```bash
# En el servidor de producción:
docker logs lubriplan-api | grep preventive | tail -50
# O si es PM2:
pm2 logs lubriplan-backend | grep -i "preventive" | tail -50
```

---

## 7️⃣ RESUMEN QUICK FIX

Si solo quieres lo **mínimo para que funcione**:

1. **Línea 284:** `completedBy: userId` → `completedBy: req.user.technicianId`
2. **Línea 306-313:** Agregar `if (!nextDate) return res.status(400)...`
3. **schema.prisma:** Agregar `requiresPhotoOLP Boolean @default(false)` en AppSettings
4. **Correr:** `npx prisma migrate dev`
5. **Correr:** `npm run dev` (verificar sin errores)
6. **Test:** `POST /api/preventive-orders` con Postman

---

## 8️⃣ SI NECESITAS AYUDA

**Síntomas comunes después de fix:**

| Síntoma | Causa | Solución |
|---------|-------|----------|
| "Campo completedBy falla en INSERT" | Foreign key inválida | Verificar que user.technicianId existe |
| "Próxima fecha no se recalcula" | nextDate es null | Verificar frequencyType es válido (WEEKLY, MONTHLY, etc) |
| "CORS error en prod" | Dominio no en allowedOrigins | Agregar www.lubriplan.com a línea 151 en index.js |
| "Timeout 30s en GET /api/preventive-orders" | Query lenta | Agregar `items: { take: 10 }` en incluye |

---

## ✅ CHECKLIST FINAL

```
ANTES DE HACER PUSH A MAIN:

[ ] Línea 284 fija: completedBy usa technicianId
[ ] Línea 306-313: nextDate validada con if (!nextDate)
[ ] schema.prisma: requiresPhotoOLP agregado a AppSettings
[ ] (Opcional) Enum ExecutionSourceType agregado
[ ] Migración creada: npx prisma migrate dev
[ ] npm run dev sin errores
[ ] npm run build sin errores
[ ] Postman test: POST /api/preventive-orders OK
[ ] Postman test: GET /api/preventive-orders OK
[ ] Postman test: PUT /:id/items/:itemId OK con Execution creada
[ ] Git commit con mensaje claro
[ ] Push a rama correcta (main o feature branch)
```
