# ✅ Lubriplan Maintenance - Checklist de Tareas

## 🚀 FASE 1: ARREGLOS URGENTES (COMPLETADO ✅)

### Backend
- [x] Arreglar endpoint `GET /api/maintenance/dashboard/summary` → Raw SQL seguro
- [x] Crear endpoint `POST /api/maintenance/reportar-falla` → Reportar fallas
- [x] Importar funciones necesarias en maintenance/index.js
- [x] Usar `Prisma.sql` para queries seguras contra SQL injection

### Scripts
- [x] Crear script de inicialización de datos: `scripts/init-maintenance-data.js`
- [x] Crear script de pruebas: `scripts/test-maintenance-endpoints.sh`
- [x] Documentar cambios: `MAINTENANCE_FIXES.md`

---

## 📋 FASE 2: VERIFICACIÓN & TESTING (AHORA)

### Verificar Backend
- [ ] Iniciar servidor backend: `npm run dev` (o `yarn dev`)
- [ ] Ejecutar script de inicialización: `node scripts/init-maintenance-data.js`
- [ ] Probar endpoints con Postman/Thunder Client/curl
- [ ] Verificar que no hay errores en los logs del servidor

### Endpoints a Probar
```bash
# 1. Dashboard Summary
GET /api/maintenance/dashboard/summary

# 2. List Assets
GET /api/maintenance/assets

# 3. List Work Orders
GET /api/maintenance/work-orders

# 4. Report Failure (NUEVO)
POST /api/maintenance/reportar-falla
Body: {
  "assetId": 1,
  "title": "Test failure",
  "description": "Test description",
  "priority": "HIGH"
}

# 5. Seed Failure Codes
POST /api/maintenance/failure-codes/seed
```

### Verificar Frontend
- [ ] Iniciar servidor frontend: `cd frontend && npm run dev`
- [ ] Navegar al dashboard de mantenimiento
- [ ] Verificar que carga los datos correctamente
- [ ] Probar crear un reporte de falla
- [ ] Probar listar órdenes de trabajo
- [ ] Probar listar activos

---

## 🔧 FASE 3: CORRECCIONES PENDIENTES (OPCIONAL)

### SQL Injection - Mejorar Assets Router
- [ ] Actualizar `src/modules/maintenance/assets/router.js` para usar `Prisma.sql`
- [ ] Reemplazar `$queryRawUnsafe` por `$queryRaw` con template literals

**Archivos a actualizar**:
- `src/modules/maintenance/assets/router.js` (líneas 34-40, 42, 50, 177)

### Tablas Faltantes
- [ ] Verificar que tabla `MtTechnician` existe
- [ ] Crear tabla si es necesario
- [ ] Populizar con datos de prueba

### Optimización BD
- [ ] Crear índices necesarios
- [ ] Ejecutar `node prisma/db.sql` si es necesario
- [ ] Verificar performance de queries

---

## 🎯 FASE 4: NUEVAS FUNCIONALIDADES (ROADMAP)

### Corto Plazo (1-2 días)
- [ ] Endpoint CRUD completo para Work Orders
- [ ] Endpoint para listar Failure Codes
- [ ] Sistema de notificaciones SSE (Server-Sent Events)
- [ ] Caché de datos en frontend

### Mediano Plazo (2-4 días)
- [ ] Reportes PDF/Excel
- [ ] Gráficos Analytics (Recharts)
- [ ] Exportación de datos
- [ ] Búsqueda avanzada y filtros
- [ ] Integración de email para notificaciones

### Largo Plazo (4+ días)
- [ ] Permisos granulares por rol
- [ ] Dashboard mejorado con más KPIs
- [ ] Integración con sistemas externos
- [ ] Mobile app

---

## 📊 ESTADO ACTUAL

| Componente | Estado | % Avance |
|-----------|--------|---------|
| Autenticación | ✅ OK | 100% |
| Base de Datos | ✅ OK (con correcciones) | 90% |
| Dashboard | ✅ ARREGLADO | 100% |
| Assets | ✅ OK | 85% |
| Work Orders | ✅ OK | 80% |
| Reportar Falla | ✨ NUEVO | 100% |
| Failure Codes | ✅ OK | 75% |
| Notificaciones | ✅ OK | 70% |
| Reportes | ⏳ PENDIENTE | 30% |
| Analytics | ⏳ PENDIENTE | 20% |

---

## 🛠️ COMANDOS ÚTILES

### Development
```bash
# Backend
cd lubriplan-backend
npm install
npm run dev

# Frontend
cd lubriplan-frontend
npm install
npm run dev
```

### Testing
```bash
# Inicializar datos
node scripts/init-maintenance-data.js

# Probar endpoints
bash scripts/test-maintenance-endpoints.sh

# Ejecutar tests
npm run test
npm run test:watch
```

### Database
```bash
# Push schema changes
npx prisma db push

# Generate migrations
npx prisma migrate dev --name descriptive_name

# Seed data
npm run seed

# View database
npx prisma studio
```

---

## 🔍 PROBLEMAS CONOCIDOS

### ✅ RESUELTOS
- Dashboard 500 error → **ARREGLADO con Prisma.sql**
- Reportar falla endpoint missing → **CREADO**
- SQL injection vulnerability → **PARCIALMENTE ARREGLADO**

### ⚠️ PENDIENTES
- Assets router aún usa `$queryRawUnsafe` → Necesita actualización
- Tabla MtTechnician → Verificar si existe
- Datos de prueba → Necesitan cargarse

---

## 📝 NOTAS IMPORTANTES

1. **Token JWT**: Los endpoints requieren un token JWT válido en el header `Authorization: Bearer <token>`
2. **Plant ID**: La mayoría de endpoints requieren un `plantId` válido
3. **Permisos**: Algunos endpoints requieren roles específicos (ADMIN, SUPERVISOR, TECHNICIAN)
4. **Rate Limiting**: Backend tiene rate limiting configurado
5. **CORS**: Verificar que CORS está habilitado para el frontend

---

## ✨ PRÓXIMO PASO

**Ejecutar server backend y probar endpoints**:

```bash
cd C:\Users\ferga\Documents\lubriplan-backend
npm run dev
```

Luego en otra terminal:

```bash
# Probar dashboard
curl -X GET http://localhost:3001/api/maintenance/health

# Con token JWT válido:
curl -X GET http://localhost:3001/api/maintenance/dashboard/summary \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

*Actualizado: 2026-11-09*
*Versión: 1.1.0*
