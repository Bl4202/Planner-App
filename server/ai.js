// Ask an AI model (Claude or Gemini) how long an assignment will take.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const TYPES = ["reading", "writing", "problem-set", "coding", "project", "exam-prep", "discussion", "lab", "other"];
export const PROVIDERS = ["claude", "gemini"];

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

// Enums are validated by hand below: the output schema only hints them, and a
// stray value shouldn't throw away an otherwise good estimate.
const EstimateSchema = z.object({
  type: z.string(),
  minutes: z.number().int(),
  confidence: z.string(),
  breakdown: z.array(z.object({ step: z.string(), minutes: z.number().int() })),
  reasoning: z.string(),
});

const SYSTEM = `You estimate how long a college student will need to complete a homework assignment, so a planner app can schedule it.

Given the course, title, due date and the full assignment instructions, return:
- type: the best-fitting category, exactly one of: ${TYPES.join(", ")}.
- minutes: realistic TOTAL hands-on time for a typical, reasonably prepared student to finish and submit it, including reading the instructions, any required reading/research, drafting, revising and submitting. Not wall-clock time until the due date.
- confidence: low, medium or high - how well the instructions pin down the workload.
- breakdown: 2-6 concrete steps whose minutes sum to the total.
- reasoning: one or two plain sentences a student would find useful.

Anchor on concrete signals in the instructions: page/word counts, number of problems, number of sources, readings listed, required deliverables. Typical paces: ~250-350 polished words per hour of writing, ~20-30 pages per hour of textbook reading, 10-20 minutes per moderate problem-set question. Always estimate for a typical student; the app personalizes the number afterwards from the student's own track record.`;

export class EstimateError extends Error {}

/** The key to use for a provider: the one saved in Settings, else the environment. */
export function providerKey(settings) {
  return settings.aiProvider === "gemini"
    ? settings.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
    : settings.apiKey || process.env.ANTHROPIC_API_KEY || "";
}

export async function estimateAssignment(input, { provider = "claude", apiKey } = {}) {
  const user = [
    `Course: ${input.course || "(none)"}`,
    `Title: ${input.title || "(untitled)"}`,
    `Due: ${input.dueDate || "(unknown)"}`,
    "",
    "Assignment instructions:",
    input.instructions?.trim() || "(no instructions provided - estimate from the title and course)",
  ].join("\n");

  const out = provider === "gemini" ? await askGemini(user, apiKey) : await askClaude(user, apiKey);

  const type = String(out.type).toLowerCase().trim();
  const confidence = String(out.confidence).toLowerCase().trim();
  return {
    ...out,
    type: TYPES.includes(type) ? type : "other",
    confidence: ["low", "medium", "high"].includes(confidence) ? confidence : "medium",
    minutes: Math.max(5, Math.min(out.minutes, 100 * 60)),
    provider,
  };
}

// ---------- Claude ----------
let client = null;
let clientKey = null;

function getClient(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || undefined;
  if (!client || clientKey !== key) {
    client = new Anthropic(key ? { apiKey: key } : {});
    clientKey = key;
  }
  return client;
}

async function askClaude(user, apiKey) {
  let response;
  try {
    response = await getClient(apiKey).messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(EstimateSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new EstimateError("Your Anthropic API key was rejected. Check it in Settings.");
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new EstimateError("Rate limited by the Anthropic API. Try again in a minute.");
    }
    if (err instanceof Anthropic.APIError) {
      throw new EstimateError(`AI request failed (${err.status ?? "network"}): ${err.message}`);
    }
    if (/api key|apiKey|authentication/i.test(String(err?.message))) {
      throw new EstimateError("No Anthropic API key set. Add one in Settings, or enter the time manually.");
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw new EstimateError("The AI declined to estimate this one. Enter the time manually.");
  }
  if (!response.parsed_output) throw new EstimateError("The AI returned an unreadable estimate. Try again or enter the time manually.");
  return response.parsed_output;
}

// ---------- Gemini (REST, no SDK needed) ----------
// Same fields as EstimateSchema, in the OpenAPI-style schema Gemini expects.
const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    type: { type: "STRING", enum: TYPES },
    minutes: { type: "INTEGER" },
    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
    breakdown: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { step: { type: "STRING" }, minutes: { type: "INTEGER" } },
        required: ["step", "minutes"],
      },
    },
    reasoning: { type: "STRING" },
  },
  required: ["type", "minutes", "confidence", "breakdown", "reasoning"],
  propertyOrdering: ["type", "minutes", "confidence", "breakdown", "reasoning"],
};

async function askGemini(user, apiKey) {
  if (!apiKey) throw new EstimateError("No Gemini API key set. Add one in Settings, or enter the time manually.");

  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: GEMINI_SCHEMA },
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new EstimateError(`Couldn't reach the Gemini API: ${err.message}`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || res.statusText;
    if (res.status === 400 && /api key/i.test(msg)) throw new EstimateError("Your Gemini API key was rejected. Check it in Settings.");
    if (res.status === 401 || res.status === 403) throw new EstimateError("Your Gemini API key was rejected. Check it in Settings.");
    if (res.status === 429) throw new EstimateError("Rate limited by the Gemini API. Try again in a minute.");
    throw new EstimateError(`AI request failed (${res.status}): ${msg}`);
  }

  const cand = data.candidates?.[0];
  if (!cand || data.promptFeedback?.blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(cand.finishReason)) {
    throw new EstimateError("The AI declined to estimate this one. Enter the time manually.");
  }
  // Skip any thought-summary parts; the answer is the JSON text.
  const text = (cand.content?.parts || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");
  try {
    return EstimateSchema.parse(JSON.parse(text));
  } catch {
    throw new EstimateError("The AI returned an unreadable estimate. Try again or enter the time manually.");
  }
}
