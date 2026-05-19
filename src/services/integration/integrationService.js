// Orchestrator: loads config, decrypts credentials, routes to connector, logs results
import { decrypt } from "./crypto.js";
import { testMaximoConnection, pullMaximoAssets, pushMaximoWorkOrder } from "./maximoConnector.js";
import { testSapConnection, pullSapEquipment, pushSapMaintenanceOrder } from "./sapConnector.js";

function buildConnectorConfig(cfg) {
  return {
    baseUrl: cfg.baseUrl || null,
    apiKey: cfg.apiKey ? decrypt(cfg.apiKey) : null,
    username: cfg.username || null,
    password: cfg.passwordEnc ? decrypt(cfg.passwordEnc) : null,
    extra: cfg.extra || {},
  };
}

export async function testConnection(cfg) {
  const connCfg = buildConnectorConfig(cfg);
  switch (cfg.type) {
    case "MAXIMO":   return testMaximoConnection(connCfg);
    case "SAP_ODATA":
    case "SAP_RFC":  return testSapConnection(connCfg);
    case "CSV":      return { ok: true, message: "CSV no requiere conexión remota" };
    default:         throw new Error(`Tipo de integración desconocido: ${cfg.type}`);
  }
}

export async function syncAssets(prisma, cfg) {
  const connCfg = buildConnectorConfig(cfg);
  const log = { direction: "PULL", entity: "assets", status: "OK", recordsTotal: 0, recordsOk: 0, recordsError: 0, errors: [] };
  const startedAt = new Date();

  let assets = [];
  try {
    switch (cfg.type) {
      case "MAXIMO":   assets = await pullMaximoAssets(connCfg); break;
      case "SAP_ODATA":
      case "SAP_RFC":  assets = await pullSapEquipment(connCfg); break;
      default: throw new Error(`syncAssets no soportado para tipo ${cfg.type}`);
    }
  } catch (err) {
    log.status = "ERROR";
    log.errors = [{ message: err.message }];
    await saveLog(prisma, cfg.id, log, startedAt);
    throw err;
  }

  log.recordsTotal = assets.length;

  for (const asset of assets) {
    try {
      await prisma.assetMapping.upsert({
        where: { integrationId_externalId: { integrationId: cfg.id, externalId: asset.externalId } },
        create: {
          integrationId: cfg.id,
          externalId: asset.externalId,
          externalName: asset.externalName,
          externalData: asset.externalData,
        },
        update: {
          externalName: asset.externalName,
          externalData: asset.externalData,
        },
      });
      log.recordsOk++;
    } catch (err) {
      log.recordsError++;
      log.errors.push({ externalId: asset.externalId, message: err.message });
    }
  }

  if (log.recordsError > 0 && log.recordsOk === 0) log.status = "ERROR";
  else if (log.recordsError > 0) log.status = "PARTIAL";

  await prisma.integrationConfig.update({ where: { id: cfg.id }, data: { lastSyncAt: new Date() } });
  await saveLog(prisma, cfg.id, log, startedAt);

  return { synced: log.recordsOk, errors: log.recordsError, total: log.recordsTotal };
}

export async function syncWorkOrders(prisma, cfg, plantId) {
  const connCfg = buildConnectorConfig(cfg);
  const log = { direction: "PUSH", entity: "workorders", status: "OK", recordsTotal: 0, recordsOk: 0, recordsError: 0, errors: [] };
  const startedAt = new Date();

  const since = cfg.lastSyncAt || new Date(Date.now() - 7 * 86400_000);

  const executions = await prisma.execution.findMany({
    where: { plantId, status: "COMPLETED", executedAt: { gte: since } },
    include: {
      route: { include: { equipment: true } },
      equipment: true,
      technician: true,
    },
    take: 200,
    orderBy: { executedAt: "desc" },
  });

  log.recordsTotal = executions.length;

  for (const ex of executions) {
    const mapping = await prisma.assetMapping.findFirst({
      where: {
        integrationId: cfg.id,
        equipmentId: ex.equipmentId || ex.route?.equipmentId || null,
        confirmed: true,
      },
    });

    const workOrder = buildWorkOrder(ex, mapping?.externalId);

    try {
      switch (cfg.type) {
        case "MAXIMO":
          await pushMaximoWorkOrder(connCfg, workOrder);
          break;
        case "SAP_ODATA":
        case "SAP_RFC":
          await pushSapMaintenanceOrder(connCfg, workOrder);
          break;
        default:
          throw new Error(`syncWorkOrders no soportado para tipo ${cfg.type}`);
      }
      log.recordsOk++;
    } catch (err) {
      log.recordsError++;
      log.errors.push({ executionId: ex.id, message: err.message });
    }
  }

  if (log.recordsError > 0 && log.recordsOk === 0) log.status = "ERROR";
  else if (log.recordsError > 0) log.status = "PARTIAL";

  await prisma.integrationConfig.update({ where: { id: cfg.id }, data: { lastSyncAt: new Date() } });
  await saveLog(prisma, cfg.id, log, startedAt);

  return { pushed: log.recordsOk, errors: log.recordsError, total: log.recordsTotal };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildWorkOrder(ex, externalAssetId) {
  return {
    description: ex.route?.name || ex.manualTitle || `Ejecución #${ex.id}`,
    externalAssetId: externalAssetId || null,
    technician: ex.technician?.name || null,
    scheduledAt: ex.scheduledAt,
    completedAt: ex.executedAt,
    condition: ex.condition || null,
    observations: ex.observations || null,
    usedQuantity: ex.usedQuantity || null,
    source: "LubriPlan",
    sourceId: String(ex.id),
  };
}

async function saveLog(prisma, integrationId, log, startedAt) {
  await prisma.integrationSyncLog.create({
    data: {
      integrationId,
      direction: log.direction,
      entity: log.entity,
      status: log.status,
      recordsTotal: log.recordsTotal,
      recordsOk: log.recordsOk,
      recordsError: log.recordsError,
      errors: log.errors.length ? log.errors : null,
      startedAt,
      finishedAt: new Date(),
    },
  });
}
