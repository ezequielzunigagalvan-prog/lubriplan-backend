# 🚨 DIAGNÓSTICO: 500 ERRORS EN /api/settings Y /api/dashboard/onboarding-progress

**Fecha:** 2026-06-04  
**Status:** IDENTIFICADO  
**Severidad:** 🔴 CRÍTICA

---

## 📊 ERRORES IDENTIFICADOS

### ERROR 1: GET /api/settings (500)

**Ubicación:** `src/routes/settings.routes.js:17-28`

```javascript
router.get("/settings", auth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const settings = await ensureRow();  // ← FALLA AQUÍ
    return res.json({ ok: true, settings });
  } catch (e) {
    logger.error("GET /settings error:", e);
    return res.status(500).json({ error: "Error cargando settings" });
  }
});
```

**Función `ensureRow()` (línea 8-14):**
```javascript
const ensureRow = async () => {
  return prisma.appSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
};
```

**Problema Raíz:**

La tabla `app_settings` en **producción NO tiene el campo `requiresPhotoOLP`**.

El schema.prisma define:
```prisma
model AppSettings {
  // ... otros campos ...
  requiresPhotoOLP Boolean @default(false)  // ← AQUÍ
  // ... más campos ...
}
```

Pero la **migración SQL no lo incluye**:
- Archivo: `prisma/migrations/20260602000000_add_preventive_orders/migration.sql`
- **Líneas 1-160:** Crea tablas PreventiveOrder y PreventiveOrderItem
- **FALTA:** `ALTER TABLE "AppSettings" ADD COLUMN "requiresPhotoOLP" BOOLEAN DEFAULT false;`

**¿Por qué falla?**
1. Cuando Prisma intenta hacer `upsert` en AppSettings, genera SQL basado en el schema
2. El schema define el campo `requiresPhotoOLP`
3. Pero la tabla en BD NO tiene este campo
4. PostgreSQL devuelve error: `column "requiresPhotoOLP" does not exist`
5. Prisma captura el error y retorna 500

**Error SQL exacto (en logs de producción):**
```
error: column "requiresPhotoOLP" does not exist
  at Protocol._pushMessage (node:internal/streams:end-writable-stream.js:...)
```

---

### ERROR 2: GET /api/dashboard/onboarding-progress (500)

**Ubicación:** `src/routes/dashboard.routes.js:1175-1196`

```javascript
router.get("/onboarding-progress", auth, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const [areas, equipments, technicians, routes] = await Promise.all([
      prisma.area.count({ where: { plantId } }),           // ← QUERY 1
      prisma.equipment.count({ where: { plantId, deletedAt: null } }),  // ← QUERY 2
      prisma.technician.count({ where: { plantId, deletedAt: null } }), // ← QUERY 3
      prisma.route.count({ where: { plantId } }),          // ← QUERY 4
    ]);

    return res.json({
      ok: true,
      progress: { areas, equipments, technicians, routes },
      completed: areas > 0 && equipments > 0 && technicians > 0 && routes > 0,
    });
  } catch (e) {
    logger.error("onboarding-progress error:", e);
    return res.status(500).json({ error: "Error obteniendo progreso de onboarding" });
  }
});
```

**Problema Raíz:**

Una o más de estas tablas tiene un **campo nuevo que no existe en la BD de producción**:

Probables culpables:
1. Tabla `equipment` - probablemente falta algún campo nuevo
2. Tabla `technician` - probablemente falta algún campo nuevo

**¿Por qué falla?**

Cuando Prisma hace la query `prisma.equipment.count({ where: { plantId, deletedAt: null } })`:
1. El schema define un campo `deletedAt` en Equipment
2. Si este campo NO existe en la tabla en producción, PostgreSQL devuelve error
3. Error: `column "Equipment"."deletedAt" does not exist`
4. El query falla y retorna 500

**Campos sospechosos:**

Revisa el schema Equipment en `prisma/schema.prisma` buscando campos con `@default`:
- Si hay campos nuevos con `@default(...)`, la migración necesita agregarlos a la tabla
- Si la migración NO lo hace, la tabla no tiene el campo

---

## 🔍 VERIFICACIÓN RÁPIDA

Para confirmar, en el servidor de producción, ejecuta:

```bash
psql lubri_plan -c "
  \d \"AppSettings\"
  SELECT column_name, data_type 
  FROM information_schema.columns 
  WHERE table_name = 'AppSettings';
"
```

**Esperado:** Debe mostrar una columna `requiresPhotoOLP` de tipo `boolean`  
**Si NO está:** Ese es el problema

---

## 📋 RESUMEN DE PROBLEMAS

| Endpoint | Tabla | Campo faltante | Migración | Status |
|----------|-------|----------------|-----------|--------|
| `/api/settings` | AppSettings | `requiresPhotoOLP` | NO lo agrega | ❌ BROKEN |
| `/api/dashboard/onboarding-progress` | Equipment | `deletedAt` (probable) | DESCONOCIDO | ⚠️ POSIBLE |

---

## 🛠️ SOLUCIONES (Sin modificar nada todavía)

**Opción A - Manual (Recomendado):**
1. Crear una nueva migración que agregue los campos faltantes
2. Ejecutar `npx prisma migrate deploy` en producción

**Opción B - Nuclear:**
1. Ejecutar `npx prisma migrate deploy` (si hay migraciones pendientes)
2. Ejecutar `npx prisma db push` (sincronizar schema)
3. Riesgo: Puede perder datos

**Opción C - Rollback:**
1. Revertir el commit e1f6712
2. Volver a la versión anterior sin OLP

---

## 📝 PRÓXIMOS PASOS

```
1. Ver logs exactos en producción:
   docker-compose logs lubriplan-api | grep -A 5 "GET /settings error"

2. Confirmar que falta el campo:
   psql lubri_plan -c "\d \"AppSettings\""

3. Crear migración para agregar campos faltantes:
   npx prisma migrate dev --name "add_missing_fields_production"

4. Ejecutar migración en producción:
   npx prisma migrate deploy

5. Reiniciar backend:
   docker-compose restart lubriplan-api
```

---

**ESPERA INSTRUCCIONES ANTES DE HACER CAMBIOS** ⚠️
