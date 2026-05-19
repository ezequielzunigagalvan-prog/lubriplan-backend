// SAP OData connector (S/4HANA or ECC via gateway)
// Handles CSRF token fetch + POST

export async function testSapConnection(config) {
  const { baseUrl, username, password } = config;
  if (!baseUrl) throw new Error("baseUrl requerido para SAP");
  if (!username || !password) throw new Error("username y password requeridos para SAP");

  const pingUrl = `${baseUrl.replace(/\/$/, "")}/$metadata`;
  const res = await fetchSap(pingUrl, { username, password });
  if (!res.ok) throw new Error(`SAP respondió ${res.status}: ${await res.text()}`);
  return { ok: true };
}

export async function pullSapEquipment(config) {
  const { baseUrl, username, password } = config;
  if (!baseUrl) throw new Error("baseUrl requerido para SAP");

  const url = `${baseUrl.replace(/\/$/, "")}/EquipmentSet?$format=json&$top=500`;
  const res = await fetchSap(url, { username, password });
  if (!res.ok) throw new Error(`SAP respondió ${res.status}: ${await res.text()}`);

  const body = await res.json();
  const results = body?.d?.results || body?.value || [];

  return results.map((e) => ({
    externalId: String(e.Equipment || e.EquipmentNumber || ""),
    externalName: String(e.EquipmentName || e.Description || ""),
    externalData: {
      functionalLocation: e.FunctionalLocation,
      planningPlant: e.PlanningPlant,
      category: e.EquipmentCategory,
      status: e.SystemStatus,
    },
  })).filter((e) => e.externalId);
}

export async function pushSapMaintenanceOrder(config, order) {
  const { baseUrl, username, password } = config;
  if (!baseUrl) throw new Error("baseUrl requerido para SAP");

  const csrfToken = await fetchCsrfToken(baseUrl, { username, password });

  const url = `${baseUrl.replace(/\/$/, "")}/MaintenanceOrderSet`;
  const res = await fetchSap(url, {
    username,
    password,
    method: "POST",
    body: order,
    extra: { "X-CSRF-Token": csrfToken },
  });
  if (!res.ok) throw new Error(`SAP respondió ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildHeaders({ username, password, extra = {} }) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
    ...extra,
  };
  return headers;
}

async function fetchCsrfToken(baseUrl, { username, password }) {
  const url = `${baseUrl.replace(/\/$/, "")}/$metadata`;
  const res = await fetchSap(url, {
    username,
    password,
    extra: { "X-CSRF-Token": "Fetch" },
  });
  return res.headers.get("x-csrf-token") || "";
}

async function fetchSap(url, { username, password, method = "GET", body, extra = {} } = {}) {
  const opts = {
    method,
    headers: buildHeaders({ username, password, extra }),
    signal: AbortSignal.timeout(30_000),
  };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  return fetch(url, opts);
}
