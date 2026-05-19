// CSV / Excel import & export using exceljs
import ExcelJS from "exceljs";
import { Readable } from "stream";

// Parse uploaded buffer (xlsx or csv) → array of asset objects
export async function parseAssetFile(buffer, originalname) {
  const ext = (originalname || "").toLowerCase();
  const workbook = new ExcelJS.Workbook();

  if (ext.endsWith(".csv")) {
    const stream = Readable.from(buffer.toString("utf8"));
    await workbook.csv.read(stream);
  } else {
    await workbook.xlsx.load(buffer);
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Archivo vacío o sin hojas");

  const headers = [];
  sheet.getRow(1).eachCell((cell) => {
    headers.push(String(cell.value || "").trim().toLowerCase());
  });

  const required = ["id", "nombre"];
  for (const h of required) {
    if (!headers.includes(h)) throw new Error(`Columna requerida faltante: "${h}"`);
  }

  const assets = [];
  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const obj = {};
    row.eachCell((cell, colNum) => {
      const key = headers[colNum - 1];
      if (key) obj[key] = cell.value != null ? String(cell.value).trim() : "";
    });
    if (obj.id) {
      assets.push({
        externalId: obj.id,
        externalName: obj.nombre || "",
        externalData: obj,
      });
    }
  });

  return assets;
}

// Generate Excel export of executions
export async function buildExecutionsExcel(executions) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "LubriPlan";
  const sheet = workbook.addWorksheet("Ejecuciones");

  sheet.columns = [
    { header: "ID", key: "id", width: 8 },
    { header: "Equipo", key: "equipment", width: 25 },
    { header: "Ruta", key: "route", width: 30 },
    { header: "Técnico", key: "technician", width: 20 },
    { header: "Estado", key: "status", width: 14 },
    { header: "Programado", key: "scheduledAt", width: 20 },
    { header: "Ejecutado", key: "executedAt", width: 20 },
    { header: "Condición", key: "condition", width: 14 },
    { header: "Observaciones", key: "observations", width: 35 },
    { header: "Cantidad usada", key: "usedQuantity", width: 16 },
  ];

  // Bold headers
  sheet.getRow(1).font = { bold: true };

  for (const ex of executions) {
    sheet.addRow({
      id: ex.id,
      equipment: ex.equipment?.name || ex.route?.equipment?.name || "",
      route: ex.route?.name || ex.manualTitle || "",
      technician: ex.technician?.name || "",
      status: ex.status,
      scheduledAt: ex.scheduledAt ? new Date(ex.scheduledAt).toISOString() : "",
      executedAt: ex.executedAt ? new Date(ex.executedAt).toISOString() : "",
      condition: ex.condition || "",
      observations: ex.observations || "",
      usedQuantity: ex.usedQuantity != null ? ex.usedQuantity : "",
    });
  }

  return workbook.xlsx.writeBuffer();
}
