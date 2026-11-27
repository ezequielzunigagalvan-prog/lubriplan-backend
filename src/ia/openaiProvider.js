import { OPENAI_MODEL } from "./aiConfig.js";
import { logger } from "../config/logger.js";
import { getOpenAI } from "./openaiClient.js";

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
  const client = await getOpenAI();

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
    logger.error("Raw AI response: empty", {
      hasOutputText: Boolean(response?.output_text),
      outputItems: Array.isArray(response?.output) ? response.output.length : 0,
    });
    throw new Error("OPENAI_EMPTY_RESPONSE");
  }

  // Sin volcar el texto al log (puede incluir nombres de equipos y técnicos del cliente).
  logger.debug("[AI] respuesta sin parsear", { chars: text.length });
  return text;
}
