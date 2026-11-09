# PASO 4: Refactorizar Código - Plan de Mejora

## 🎯 Objetivo

Eliminar duplicación, mejorar mantenibilidad y seguir principios SOLID sin cambiar funcionalidad.

---

## 📊 Análisis de Código

### Duplicación Identificada

#### 1️⃣ **Error Handling Pattern** (Répetido 3+ veces)
```javascript
// Patrón repetido en routes:
if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid ID" });

try {
  // ... lógica
} catch (e) {
  logger.error("...", e);
  return res.status(500).json({ error: "Error..." });
}
```

**Solución:** Crear middleware `validateRequest` + `asyncHandler`

#### 2️⃣ **State Transition Validation** (Répetido en workOrders)
```javascript
const VALID_TRANSITIONS = {
  REQUESTED: ["PENDING_APPROVAL"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED"],
  // ... duplicado
};
```

**Solución:** Crear archivo `workOrderStateManager.js`

#### 3️⃣ **Database Query Patterns** (Répetido en todas las rutas)
```javascript
const item = await prisma.resource?.findFirst({
  where: { id, plantId },
  include: { /* relationships */ },
});
if (!item) return res.status(404).json({ error: "Not found" });
```

**Solución:** Crear `findOneWithPlantId()` helper

#### 4️⃣ **Response Formatting** (Répetido)
```javascript
return res.json({ ok: true, item: data });
// vs
return res.json(data);
// vs
return res.status(201).json({ ...data, lastActivityAt: null });
```

**Solución:** Crear `responseFormatter.js`

---

## 🛠️ Refactoring Tasks

### Prioridad Alta (1-2 horas)

#### 1️⃣ Crear Middleware de Validación
```javascript
// src/middleware/validateRequest.js
export const validatePlantId = (req, res, next) => {
  if (!req.currentPlantId) {
    return res.status(400).json({ error: "PLANT_REQUIRED" });
  }
  next();
};

export const validateNumericId = (paramName = "id") => {
  return (req, res, next) => {
    const id = parseInt(req.params[paramName]);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }
    req.params[paramName] = id;
    next();
  };
};
```

**Antes:**
```javascript
router.get("/:id", auth, async (req, res) => {
  const plantId = req.currentPlantId;
  if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
  
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid ID" });
  // ...
});
```

**Después:**
```javascript
router.get(
  "/:id",
  auth,
  validatePlantId,
  validateNumericId("id"),
  async (req, res) => {
    // Directo a lógica
  }
);
```

#### 2️⃣ Crear State Machine Manager
```javascript
// src/utils/workOrderStateManager.js
export const VALID_TRANSITIONS = { /* ... */ };

export function isValidTransition(from, to) {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function validateTransition(currentStatus, newStatus) {
  if (!isValidTransition(currentStatus, newStatus)) {
    return {
      valid: false,
      error: `Cannot transition from ${currentStatus} to ${newStatus}`,
      validTransitions: VALID_TRANSITIONS[currentStatus] || [],
    };
  }
  return { valid: true };
}
```

**Uso:**
```javascript
const validation = validateTransition(current, newStatus);
if (!validation.valid) {
  return res.status(400).json(validation);
}
```

#### 3️⃣ Crear Database Helpers
```javascript
// src/utils/dbHelpers.js
export async function findOneWithPlantId(prismaModel, id, plantId) {
  if (!Number.isFinite(id)) throw new Error("Invalid ID");
  
  const item = await prismaModel.findFirst({
    where: { id, plantId },
  });
  
  if (!item) throw new Error("Not found");
  return item;
}

export async function findManyWithPlantId(prismaModel, plantId, filters = {}) {
  return prismaModel.findMany({
    where: { plantId, ...filters },
    orderBy: { createdAt: "desc" },
  });
}
```

#### 4️⃣ Crear Async Error Handler
```javascript
// src/middleware/asyncHandler.js
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      logger.error(error);
      return res.status(500).json({ error: error.message || "Internal error" });
    });
  };
};
```

**Uso:**
```javascript
router.get(
  "/:id",
  validatePlantId,
  validateNumericId("id"),
  asyncHandler(async (req, res) => {
    const item = await prisma.model.findFirst({...});
    return res.json(item); // Errores manejados automáticamente
  })
);
```

### Prioridad Media (30-45 minutos)

#### 5️⃣ Consolidar Response Format
```javascript
// src/utils/responseFormatter.js
export const formatSuccess = (data, statusCode = 200) => {
  return { status: statusCode, body: data };
};

export const formatError = (error, statusCode = 500) => {
  return { status: statusCode, body: { error } };
};
```

#### 6️⃣ Crear Constants File
```javascript
// src/constants/workOrderStatuses.js
export const WO_STATUSES = {
  REQUESTED: "REQUESTED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  ASSIGNED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  FINISHED: "FINISHED",
  VALIDATED: "VALIDATED",
  REJECTED: "REJECTED",
};

export const ERROR_CODES = {
  PLANT_REQUIRED: "PLANT_REQUIRED",
  INVALID_ID: "INVALID_ID",
  NOT_FOUND: "NOT_FOUND",
  INVALID_TRANSITION: "INVALID_TRANSITION",
};
```

### Prioridad Baja (30 minutos)

#### 7️⃣ Mejorar Naming
```javascript
// Antes
const wo = await prisma.workOrder.findFirst(...)
const t = await prisma.technician.findFirst(...)
const es = Array.isArray(items) ? items : []

// Después
const workOrder = await prisma.workOrder.findFirst(...)
const technician = await prisma.technician.findFirst(...)
const safeItems = Array.isArray(items) ? items : []
```

---

## 📋 Checklist de Refactoring

### Middleware Layer
- [ ] Crear `validateRequest.js`
  - [ ] validatePlantId
  - [ ] validateNumericId
  - [ ] validateOptionalId

- [ ] Crear `asyncHandler.js`
  - [ ] Wrapper para async routes
  - [ ] Manejo centralizado de errores

### Utils Layer
- [ ] Crear `workOrderStateManager.js`
  - [ ] VALID_TRANSITIONS constant
  - [ ] isValidTransition()
  - [ ] validateTransition()

- [ ] Crear `dbHelpers.js`
  - [ ] findOneWithPlantId()
  - [ ] findManyWithPlantId()
  - [ ] countWithPlantId()

- [ ] Crear `responseFormatter.js`
  - [ ] Formato consistente

- [ ] Crear `constants/`
  - [ ] workOrderStatuses.js
  - [ ] errorCodes.js

### Routes Refactoring
- [ ] workOrders.routes.js
  - [ ] Usar validateRequest middleware
  - [ ] Usar asyncHandler
  - [ ] Usar dbHelpers
  - [ ] Usar workOrderStateManager

- [ ] assetExpedient.routes.js
  - [ ] Usar validateRequest
  - [ ] Usar asyncHandler

- [ ] assetHierarchy.routes.js
  - [ ] Usar validateRequest
  - [ ] Usar asyncHandler

- [ ] preventiveOrders.routes.js
  - [ ] Usar validateRequest
  - [ ] Usar asyncHandler

- [ ] assetHistory.routes.js
  - [ ] Usar validateRequest
  - [ ] Usar asyncHandler

### Code Quality
- [ ] Eliminar variables innecesarias
- [ ] Mejorar nombres de funciones
- [ ] Consolidar imports
- [ ] Agregar JSDoc donde sea necesario

---

## 📊 Impacto Esperado

### Antes (Status Quo)
```
Líneas de código: ~2,000
Duplicación: ~30%
Complejidad: Alta
Mantenibilidad: Media
```

### Después (Post-Refactoring)
```
Líneas de código: ~1,600 (-20%)
Duplicación: ~5% (-25 puntos)
Complejidad: Media
Mantenibilidad: Alta
```

---

## 🚀 Proceso de Refactoring

### Fase 1: Infrastructure (30 min)
1. Crear archivos base (middleware, utils, constants)
2. Implementar funciones helper
3. Actualizar imports en routes

### Fase 2: Routes (45 min)
1. Refactorizar workOrders.routes.js (más complejo)
2. Refactorizar otras rutas
3. Validar funcionamiento

### Fase 3: Code Quality (15 min)
1. Mejorar naming
2. Eliminar duplicación residual
3. Agregar documentación

---

## ✅ Validación

### Testing
- [ ] Todos los tests siguen pasando
- [ ] No hay cambios en API contracts
- [ ] Errores siguen retornando mismo formato

### Performance
- [ ] Sin degradación de performance
- [ ] Middleware no agrega latencia significativa

### Maintenance
- [ ] Código más legible
- [ ] Menos duplicación
- [ ] Más fácil agregar nuevos endpoints

---

## 📈 Métricas

| Métrica | Antes | Después | Ganancia |
|---------|-------|---------|----------|
| **LOC (routes)** | 2,000 | 1,600 | -20% |
| **Duplicación** | 30% | 5% | -25pts |
| **Complejidad** | Alta | Media | ↓ |
| **Testabilidad** | Media | Alta | ↑ |
| **Mantenibilidad** | Media | Alta | ↑ |

---

## 🎯 Resultado Final

Código más limpio, modular y mantenible sin cambiar funcionalidad.

**Tiempo Estimado:** 2 horas  
**Riesgo:** Bajo (no cambia behavior)  
**ROI:** Alto (mantenimiento futuro más fácil)
