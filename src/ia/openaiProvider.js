import { OPENAI_MODEL } from "./aiConfig.js";

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

export async function generateExecutiveSummary({ prompt }) {
  const client = await getClient();
  const response = await client.responses.create({
    model: OPENAI_MODEL,
    input: String(prompt || ""),
  });

  const text = extractResponseText(response);
  if (!text) throw new Error("OPENAI_EMPTY_RESPONSE");
  return text;
}
