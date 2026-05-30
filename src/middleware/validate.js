// src/middleware/validate.js
// Middleware genérico de validación con Zod.
// Uso: router.post("/ruta", validate(schema), handler)
import { ZodError } from "zod";

export function validate(schema, source = "body") {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      // Zod v4 usa .issues; .errors es alias legacy que puede no estar presente
      const issues = result.error.issues ?? result.error.errors ?? [];
      const errors = issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      }));
      return res.status(400).json({ error: "Datos inválidos", errors });
    }
    // Reemplaza el body/query/params con el valor parseado (ya limpio y tipado)
    req[source] = result.data;
    return next();
  };
}
