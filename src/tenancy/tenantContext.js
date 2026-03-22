// src/tenancy/tenantContext.js
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/**
 * Corre un callback con el contexto de tenancy (plantId)
 */
export function runWithTenant(tenant, fn) {
  return als.run(tenant, fn);
}

/**
 * Obtiene el plantId actual (si existe)
 */
export function getCurrentPlantId() {
  const store = als.getStore();
  return store?.plantId ?? null;
}