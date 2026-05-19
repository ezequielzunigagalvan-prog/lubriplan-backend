// IBM Maximo REST API connector
// Supports both API key and HTTP Basic auth

export async function testMaximoConnection(config) {
  const { baseUrl, apiKey, username, password } = config;
  if (!baseUrl) throw new Error("baseUrl requerido para Maximo");

  const url = `${baseUrl.replace(/\/$/, "")}/maximo/oslc/whoami`;
  const res = await fetchMaximo(url, { apiKey, username, password });
  if (!res.ok) throw new Error(`Maximo respondió ${res.status}: ${await res.text()}`);
  return { ok: true };
}

export async function pullMaximoAssets(config) {
  const { baseUrl, apiKey, username, password } = config;
  if (!baseUrl) throw new Error("baseUrl requerido para Maximo");

  const oslcFields = "spi:assetnum,spi:description,spi:siteid,spi:status,spi:location,spi:serialnum";
  const url = `${baseUrl.replace(/\/$/, "")}/maximo/oslc/os/mxasset?oslc.select=${encodeURIComponent(oslcFields)}&oslc.pageSize=200&lean=1`;

  const res = await fetchMaximo(url, { apiKey, username, password });
  if (!res.ok) throw new Error(`Maximo respondió ${res.status}: ${await res.text()}`);

  const body = await res.json();
  const members = body["rdfs:member"] || body.member || [];

  return members.map((a) => ({
    externalId: String(a["spi:assetnum"] || a.assetnum || ""),
    externalName: String(a["spi:description"] || a.description || ""),
    externalData: {
      siteid: a["spi:siteid"] || a.siteid,
      status: a["spi:status"] || a.status,
      location: a["spi:location"] || a.location,
      serialnum: a["spi:serialnum"] || a.serialnum,
    },
  })).filter((a) => a.externalId);
}

export async function pushMaximoWorkOrder(config, workOrder) {
  const { baseUrl, apiKey, username, password } = config;
  if (!baseUrl) throw new Error("baseUrl requerido para Maximo");

  const url = `${baseUrl.replace(/\/$/, "")}/maximo/oslc/os/mxwo?lean=1`;
  const res = await fetchMaximo(url, { apiKey, username, password, method: "POST", body: workOrder });
  if (!res.ok) throw new Error(`Maximo respondió ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildHeaders({ apiKey, username, password }) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) {
    headers["apikey"] = apiKey;
  } else if (username && password) {
    headers["Authorization"] = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }
  return headers;
}

async function fetchMaximo(url, { apiKey, username, password, method = "GET", body } = {}) {
  const opts = {
    method,
    headers: buildHeaders({ apiKey, username, password }),
    signal: AbortSignal.timeout(30_000),
  };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  return fetch(url, opts);
}
