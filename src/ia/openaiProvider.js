import { OPENAI_MODEL } from "./aiConfig.js";

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "period",
    "plantId",
    "kpis",
    "highlights",
    "risks",
    "recommendations",
    "executiveSummary",
    "schemaVersion",
  ],
  properties: {
    title: { type: "string" },
    period: { type: "string" },
    plantId: { type: "string" },
    kpis: {
      type: "object",
      additionalProperties: false,
      required: [
        "completed",
        "pending",
        "overdue",
        "conditionOpen",
        "conditionInProgress",
        "lowStockCount",
        "unassignedPending",
      ],
      properties: {
        completed: { type: "integer" },
        pending: { type: "integer" },
        overdue: { type: "integer" },
        conditionOpen: { type: "integer" },
        conditionInProgress: { type: "integer" },
        lowStockCount: { type: "integer" },
        unassignedPending: { type: "integer" },
      },
    },
    highlights: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 6,
    },
    risks: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["level", "message", "action"],
        properties: {
          level: {
            type: "string",
            enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
          },
          message: { type: "string" },
          action: { type: "string" },
        },
      },
    },
    recommendations: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 6,
    },
    executiveSummary: { type: "string" },
    schemaVersion: { type: "integer" },
  },
};

let clientPromise = null;

async function getClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");

    const mod = await import("openai");
    const OpenAI = mod?.default || mod?.OpenAI || mod;
    return new OpenAI({ apiKey });
  })();

  return clientPromise;
}

function extractResponseText(response) {
  const direct = String(response?.output_text || "").trim();
  if (direct) return direct;

  const outputs = Array.isArray(response?.output) ? response.output : [];
  const parts = [];

  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      const text =
        chunk?.text?.value ??
        chunk?.text ??
        chunk?.output_text ??
        chunk?.value ??
        "";
      if (text) parts.push(String(text));
    }
  }

  return parts.join("\n").trim();
}

function extractParsedResponse(response) {
  if (response?.output_parsed && typeof response.output_parsed === "object") {
    return response.output_parsed;
  }

  const outputs = Array.isArray(response?.output) ? response.output : [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      if (chunk?.parsed && typeof chunk.parsed === "object") {
        return chunk.parsed;
      }
    }
  }

  return null;
}

export async function generateExecutiveSummary({ prompt }) {
  const client = await getClient();
  console.log("AI_MODE:", process.env.AI_MODE);
  console.log("AI_MODEL:", OPENAI_MODEL);
  console.log("OPENAI_API_KEY exists:", Boolean(process.env.OPENAI_API_KEY));

  const response = await client.responses.create({
    model: OPENAI_MODEL,
    input: String(prompt || ""),
    text: {
      format: {
        type: "json_schema",
        name: "lubriplan_executive_summary",
        strict: true,
        schema: SUMMARY_SCHEMA,
      },
    },
  });

  const parsed = extractParsedResponse(response);
  if (parsed) return parsed;

  const text = extractResponseText(response);
  if (!text) {
    console.error("Raw AI response: empty", {
      hasOutputText: Boolean(response?.output_text),
      outputItems: Array.isArray(response?.output) ? response.output.length : 0,
    });
    throw new Error("OPENAI_EMPTY_RESPONSE");
  }

  console.log("Raw AI response:", text.slice(0, 1200));
  return text;
}
