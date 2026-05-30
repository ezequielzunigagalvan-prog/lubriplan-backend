// src/config/swagger.js
import swaggerJsdoc from "swagger-jsdoc";

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "LubriPlan API",
      version: "1.0.0",
      description: "API REST de LubriPlan — Sistema de gestión y control de lubricación industrial",
      contact: { name: "LubriPlan", email: "soporte@lubriplan.com" },
    },
    servers: [
      { url: "/api", description: "Servidor actual" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string", example: "Mensaje de error" },
          },
        },
        ValidationError: {
          type: "object",
          properties: {
            error: { type: "string", example: "Datos inválidos" },
            errors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Auth", description: "Autenticación y sesión" },
      { name: "Dashboard", description: "Métricas y resúmenes" },
      { name: "Activities", description: "Actividades y ejecuciones de mantenimiento" },
      { name: "Equipment", description: "Equipos y áreas" },
      { name: "Lubricants", description: "Lubricantes e inventario" },
      { name: "ConditionReports", description: "Reportes de condición" },
      { name: "OilSamples", description: "Muestras de aceite" },
      { name: "PurchaseOrders", description: "Órdenes de compra" },
      { name: "Notifications", description: "Notificaciones in-app" },
      { name: "AI", description: "Resumen ejecutivo IA y chatbot LubriBot" },
      { name: "Webhooks", description: "Configuración y envío de webhooks" },
    ],
  },
  // Rutas donde buscar comentarios JSDoc con @swagger
  apis: ["./src/routes/*.js", "./src/ia/*.js"],
};

export const swaggerSpec = swaggerJsdoc(options);
