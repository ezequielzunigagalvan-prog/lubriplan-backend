# 📋 MÓDULO DE PLANES MEJORADO

## ✨ NUEVAS FUNCIONALIDADES IMPLEMENTADAS

### 1. **Programación Automática** 🔄
Cuando se ejecuta un plan, automáticamente se programa el siguiente respetando la frecuencia.

**Ejemplo:**
- Plan ejecutado: 12 de octubre 2026
- Frecuencia: Mensual (MONTH)
- Próximo: 12 de noviembre 2026 ✅

**Frecuencias soportadas:**
- `DAY` - Diarios (cada N días)
- `WEEK` - Semanales (cada N semanas)
- `MONTH` - Mensuales (respeta el día del mes)
- `YEAR` - Anuales (cada N años)

---

### 2. **Hoja de Ruta tipo SAP** 📊
Cada plan genera una "hoja de ruta" con:
- ✅ Checklist detallado
- ✅ Técnicos asignados
- ✅ Refacciones requeridas
- ✅ Historial de ejecuciones
- ✅ Estimación de tiempo

**Endpoint:**
```
GET /api/maintenance/plans/:id/roadmap
```

**Response:**
```json
{
  "plan": {
    "code": "PM-00001",
    "title": "Mantenimiento Preventivo Bomba A",
    "frequency": "Cada 1 MONTH",
    "nextDue": "2026-12-12T00:00:00Z",
    "estimatedMinutes": 120
  },
  "asset": {
    "code": "EQ-001",
    "name": "Bomba Centrífuga",
    "location": "Sala de Bombeo"
  },
  "checklist": [
    {
      "order": 1,
      "description": "Inspeccionar vibraciones",
      "type": "CHECK",
      "required": true
    },
    {
      "order": 2,
      "description": "Medir temperatura",
      "type": "MEASURE",
      "required": true
    }
  ],
  "assignedTechnicians": [
    {
      "name": "Juan García",
      "code": "TECH-001",
      "role": "EXECUTOR"
    }
  ],
  "requiredSpares": [
    {
      "code": "SP-123",
      "name": "Sello mecánico",
      "quantity": 1
    }
  ]
}
```

---

### 3. **Asignación de Técnicos** 👨‍🔧

**Agregar técnico a plan:**
```
POST /api/maintenance/plans/:id/technicians

{
  "technicianId": 5,
  "role": "EXECUTOR"  // EXECUTOR, REVIEWER, INSPECTOR
}
```

**Remover técnico:**
```
DELETE /api/maintenance/plans/:id/technicians/:technicianId
```

**Roles disponibles:**
- `EXECUTOR` - Ejecuta el mantenimiento
- `REVIEWER` - Revisa el trabajo
- `INSPECTOR` - Inspecciona después de completado

---

### 4. **Asignación de Refacciones** 🔧

**Agregar refacción a plan:**
```
POST /api/maintenance/plans/:id/spareparts

{
  "sparePartId": 42,
  "quantityRequired": 2
}
```

**Remover refacción:**
```
DELETE /api/maintenance/plans/:id/spareparts/:sparePartId
```

---

### 5. **Ejecución y Historial** 📝

**Ejecutar un plan:**
```
POST /api/maintenance/plans/:id/execute

{
  "technicians": [5, 7],  // IDs de técnicos
  "notes": "Ejecución normal"
}
```

**Respuesta:**
```json
{
  "success": true,
  "workOrder": {
    "id": 123,
    "number": "WO-2026-001"
  },
  "execution": {
    "id": 456,
    "status": "PENDING",
    "technicians": [...],
    "spares": [...]
  },
  "nextSchedule": {
    "nextDueDate": "2026-12-12T00:00:00Z"
  }
}
```

**Completar ejecución:**
```
POST /api/maintenance/plans/execution/:id/complete

{
  "tasksCompleted": 5,
  "duration": 125,  // minutos
  "checklist": [
    { "id": 1, "completed": true, "result": "OK" },
    { "id": 2, "completed": true, "result": "WITHIN_RANGE" }
  ],
  "notes": "Mantenimiento completado exitosamente"
}
```

**Obtener historial:**
```
GET /api/maintenance/plans/:id/history
```

---

### 6. **Buscadores** 🔍

**Buscar equipos:**
```
GET /api/maintenance/plans/search/assets?q=bomba&limit=10
```

**Buscar técnicos:**
```
GET /api/maintenance/plans/search/technicians?q=juan&limit=10
```

**Buscar refacciones:**
```
GET /api/maintenance/plans/search/spareparts?q=sello&limit=10
```

---

### 7. **Planes Vencidos y Próximos** ⏰

**Planes vencidos (deben ejecutarse ahora):**
```
GET /api/maintenance/plans/list/overdue
```

**Planes próximos (próximos 7 días):**
```
GET /api/maintenance/plans/list/upcoming?days=7
```

---

## 🏗️ NUEVA ESTRUCTURA DE BASE DE DATOS

### Modelos creados:

#### `MtPlanTechnician`
Relación muchos a muchos entre planes y técnicos.

```prisma
model MtPlanTechnician {
  id              Int
  planId          Int         // Plan del que es parte
  technicianId    Int         // Técnico asignado
  role            String      // EXECUTOR, REVIEWER, INSPECTOR
  notes           String?
  createdAt       DateTime
}
```

#### `MtPlanSparePart`
Relación muchos a muchos entre planes y refacciones.

```prisma
model MtPlanSparePart {
  id                    Int
  planId                Int         // Plan del que es parte
  sparePartId           Int         // Refacción requerida
  quantityRequired      Decimal     // Cantidad necesaria
  comments              String?
  createdAt             DateTime
}
```

#### `MtPlanExecutionHistory`
Historial completo de cada ejecución de plan.

```prisma
model MtPlanExecutionHistory {
  id                  Int
  planId              Int
  workOrderId         Int?
  executionDate       DateTime
  executedBy          Int
  status              String      // COMPLETED, PENDING, POSTPONED, CANCELLED
  techniciansAssigned Json?       // Array de técnicos
  sparesUsed          Json?       // Array de refacciones usadas
  tasksCompleted      Int
  tasksTotal          Int
  checklist           Json?       // Resultado de checklist
  notes               String?
  duration            Int?        // Minutos
  nextScheduleAt      DateTime?
  createdAt           DateTime
  updatedAt           DateTime
}
```

---

## 🚀 CÓMO IMPLEMENTAR

### Paso 1: Aplicar migraciones

```bash
cd lubriplan-backend
npx prisma migrate dev --name add_plan_improvements
```

### Paso 2: Reiniciar backend

```bash
npm run dev
```

---

## 📊 FLUJO COMPLETO DE UN PLAN

```
1. CREAR PLAN
   └─ Definir: frecuencia, equipamiento, checklist, etc.

2. ASIGNAR RECURSOS
   ├─ Agregar técnicos con sus roles
   └─ Agregar refacciones requeridas

3. ESPERAR A FECHA VENCIDA
   └─ Sistema monitorea nextDueAt

4. EJECUTAR PLAN
   ├─ POST /plans/:id/execute
   ├─ Crea Work Order automáticamente
   ├─ Guarda en historial
   └─ Programa próxima ejecución automáticamente

5. COMPLETAR EJECUCIÓN
   ├─ POST /execution/:id/complete
   ├─ Marca checklist
   ├─ Guarda duración real
   └─ Actualiza historial

6. VISUALIZAR HISTORIAL
   └─ GET /plans/:id/history
      └─ Estadísticas: cumplimiento, duraciones, etc.

7. PRÓXIMO CICLO
   └─ Vuelve al paso 3
```

---

## 📚 SERVICIOS DISPONIBLES

### `planScheduler.js`
Maneja la programación automática:

```javascript
import planScheduler from "./planScheduler.js";

// Calcular próxima fecha
const nextDate = planScheduler.calculateNextDueDate(
  new Date("2026-10-12"),
  "MONTH",
  1
);
// Retorna: 2026-11-12

// Obtener planes vencidos
const overdue = await planScheduler.getOverduePlans(plantId);

// Obtener planes próximos
const upcoming = await planScheduler.getUpcomingPlans(plantId, 7);
```

### `planExecution.js`
Maneja la ejecución y historial:

```javascript
import planExecution from "./planExecution.js";

// Ejecutar un plan
const result = await planExecution.executePlan(
  planId,
  plantId,
  userId,
  { technicians: [5, 7] }
);

// Completar ejecución
await planExecution.completePlanExecution(
  executionId,
  plantId,
  { tasksCompleted: 5, duration: 120 }
);

// Obtener hoja de ruta
const roadmap = await planExecution.getPlanRoadmap(planId, plantId);

// Obtener historial
const history = await planExecution.getPlanHistory(planId, plantId);
```

---

## 🎯 CASOS DE USO

### Caso 1: Mantenimiento Mensual de Bomba

```json
{
  "code": "PM-BOMBA-MENSUAL",
  "title": "Mantenimiento Preventivo - Bomba Centrífuga",
  "assetId": 1,
  "type": "PREVENTIVE",
  "frequencyUnit": "MONTH",
  "frequencyEvery": 1,
  "anchorDate": "2026-10-12T08:00:00Z",
  "priority": "HIGH",
  "estimatedMinutes": 120,
  "tasks": [
    {
      "position": 1,
      "description": "Inspeccionar vibraciones",
      "kind": "CHECK",
      "required": true
    },
    {
      "position": 2,
      "description": "Medir temperatura",
      "kind": "MEASURE",
      "unit": "°C",
      "minValue": 40,
      "maxValue": 70,
      "required": true
    }
  ]
}
```

Luego:
1. Asignar técnicos
2. Asignar refacciones
3. Ejecutar en fecha vencida
4. Completar con checklist
5. Próximo se genera automáticamente para 12 de noviembre

---

## ⚙️ CONFIGURACIÓN ADICIONAL

### Lead Days (Días de anticipación)
Si configuras `leadDays: 5`, la orden se crea 5 días antes.

### Grace Days (Días de tolerancia)
Si configuras `graceDays: 3`, puedes ejecutar hasta 3 días después sin marcar como atrasado.

### Skip If Open
Si es `true`, no genera nueva orden si la anterior está abierta.

---

## 📈 MÉTRICAS DISPONIBLES

```json
{
  "stats": {
    "total": 24,
    "completed": 22,
    "pending": 1,
    "cancelled": 1,
    "compliance": "91.7%",
    "avgDuration": 115.5
  }
}
```

---

## ✅ CHECKLIST DE IMPLEMENTACIÓN

- [ ] Ejecutar migraciones: `npx prisma migrate dev`
- [ ] Reiniciar backend: `npm run dev`
- [ ] Crear un plan de prueba
- [ ] Asignar técnicos
- [ ] Asignar refacciones
- [ ] Ejecutar plan (POST /plans/:id/execute)
- [ ] Completar ejecución (POST /execution/:id/complete)
- [ ] Verificar que próximo plan se generó automáticamente
- [ ] Verificar historial (GET /plans/:id/history)
- [ ] Verificar hoja de ruta (GET /plans/:id/roadmap)

---

*Documentación - Módulo Planes Mejorado - 2026-11-10*
