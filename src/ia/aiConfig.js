// src/ia/aiConfig.js
export const AI_MODE = String(process.env.AI_MODE || "mock").toLowerCase(); // mock | provider
export const AI_SCHEMA_VERSION = Number(process.env.AI_SCHEMA_VERSION || 1);

export const AI_CACHE_TTL_MS =
  Number(process.env.AI_CACHE_TTL_MS || 24) * 60 * 60 * 1000;

export const AI_RATE_LIMIT_USER_PER_HOUR =
  Number(process.env.AI_RATE_LIMIT_USER_PER_HOUR || 10);

export const AI_RATE_LIMIT_PLANT_PER_HOUR =
  Number(process.env.AI_RATE_LIMIT_PLANT_PER_HOUR || 50);

export const AI_LANG_DEFAULT = String(process.env.AI_LANG_DEFAULT || "es-MX");