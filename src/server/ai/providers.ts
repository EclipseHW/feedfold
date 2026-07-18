import type { AiProvider, AiUsage } from "../../shared/types.js";
import { AiError } from "./errors.js";
import type { AiGenerationResult, AiProviderAdapter } from "./types.js";

const EMPTY_USAGE: AiUsage = { inputTokens: null, outputTokens: null };

export interface AiProviderEndpoints {
  gemini?: string;
  openai?: string;
  anthropic?: string;
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function geminiInvalidKey(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const details = error as Record<string, unknown>;
  return (
    details.status === "INVALID_ARGUMENT" &&
    typeof details.message === "string" &&
    details.message.includes("API key not valid")
  );
}

function providerError(provider: string, status: number, body: unknown): AiError {
  if (status === 401) {
    return new AiError(
      "AI_KEY_REJECTED",
      502,
      `${provider} rejected the saved API key. Update it in Settings.`,
    );
  }
  if (provider === "Google Gemini" && status === 400 && geminiInvalidKey(body)) {
    return new AiError(
      "AI_KEY_REJECTED",
      502,
      `${provider} rejected the saved API key. Update it in Settings.`,
    );
  }
  if (status === 429) {
    return new AiError(
      "AI_RATE_LIMITED",
      429,
      `${provider} is rate limiting requests. Try again shortly.`,
    );
  }
  if (status === 400 || status === 403 || status === 404 || status === 422) {
    return new AiError(
      "AI_MODEL_UNAVAILABLE",
      422,
      `The selected ${provider} model could not process this article.`,
    );
  }
  return new AiError(
    "AI_PROVIDER_FAILED",
    502,
    `${provider} could not complete the summary. Try again.`,
  );
}

async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new AiError(
        "AI_PROVIDER_TIMEOUT",
        504,
        `${provider} took too long to respond. Try again.`,
      );
    }
    throw new AiError("AI_PROVIDER_FAILED", 502, `${provider} could not be reached. Try again.`);
  }
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw providerError(provider, response.status, body);
  }
  try {
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AiError(
      "AI_PROVIDER_FAILED",
      502,
      `${provider} returned an unreadable response. Try again.`,
    );
  }
}

function requireText(provider: string, values: string[], refused = false): string {
  if (refused) {
    throw new AiError("AI_RESPONSE_REFUSED", 422, `${provider} could not summarize this article.`);
  }
  const text = values.join("").trim();
  if (text) return text;
  throw new AiError("AI_PROVIDER_FAILED", 502, `${provider} returned an empty summary. Try again.`);
}

function geminiAdapter(baseUrl: string): AiProviderAdapter {
  const label = "Google Gemini";
  return {
    id: "gemini",
    label,
    defaultModel: "gemini-3.1-flash-lite",
    models: [{ id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" }],
    async generateText(request): Promise<AiGenerationResult> {
      const response = await postJson(
        label,
        endpoint(baseUrl, `/models/${encodeURIComponent(request.model)}:generateContent`),
        { "x-goog-api-key": request.apiKey },
        {
          store: false,
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: "user", parts: [{ text: request.input }] }],
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            thinkingConfig: { thinkingLevel: "minimal" },
          },
        },
        request.signal,
      );
      const promptFeedback = response.promptFeedback as Record<string, unknown> | undefined;
      if (typeof promptFeedback?.blockReason === "string") {
        throw new AiError("AI_RESPONSE_REFUSED", 422, `${label} could not summarize this article.`);
      }
      const candidates = Array.isArray(response.candidates) ? response.candidates : [];
      const first = candidates[0] as Record<string, unknown> | undefined;
      const finishReason = first?.finishReason;
      const refused =
        typeof finishReason === "string" &&
        ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"].includes(finishReason);
      if (refused) {
        throw new AiError("AI_RESPONSE_REFUSED", 422, `${label} could not summarize this article.`);
      }
      if (finishReason !== "STOP") {
        throw new AiError(
          "AI_PROVIDER_FAILED",
          502,
          `${label} did not finish the summary. Try again.`,
        );
      }
      const content = first?.content as Record<string, unknown> | undefined;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const values = parts.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? [text] : [];
      });
      const usage = response.usageMetadata as Record<string, unknown> | undefined;
      return {
        text: requireText(label, values),
        usage: usage
          ? {
              inputTokens: tokenCount(usage.promptTokenCount),
              outputTokens: tokenCount(usage.candidatesTokenCount),
            }
          : EMPTY_USAGE,
      };
    },
  };
}

function openAiAdapter(baseUrl: string): AiProviderAdapter {
  const label = "OpenAI";
  return {
    id: "openai",
    label,
    defaultModel: "gpt-5.6-luna",
    models: [{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
    async generateText(request): Promise<AiGenerationResult> {
      const response = await postJson(
        label,
        endpoint(baseUrl, "/responses"),
        { Authorization: `Bearer ${request.apiKey}` },
        {
          model: request.model,
          instructions: request.system,
          input: request.input,
          max_output_tokens: request.maxOutputTokens,
          reasoning: { effort: "none" },
          text: { verbosity: "low" },
          store: false,
        },
        request.signal,
      );
      if (response.status !== "completed") {
        const details = response.incomplete_details as Record<string, unknown> | undefined;
        if (details?.reason === "content_filter") {
          throw new AiError(
            "AI_RESPONSE_REFUSED",
            422,
            `${label} could not summarize this article.`,
          );
        }
        throw new AiError(
          "AI_PROVIDER_FAILED",
          502,
          `${label} did not finish the summary. Try again.`,
        );
      }
      const output = Array.isArray(response.output) ? response.output : [];
      let refused = false;
      const values: string[] = [];
      for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const content = (item as Record<string, unknown>).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const block = part as Record<string, unknown>;
          if (block.type === "refusal") refused = true;
          if (block.type === "output_text" && typeof block.text === "string") {
            values.push(block.text);
          }
        }
      }
      const usage = response.usage as Record<string, unknown> | undefined;
      return {
        text: requireText(label, values, refused),
        usage: usage
          ? {
              inputTokens: tokenCount(usage.input_tokens),
              outputTokens: tokenCount(usage.output_tokens),
            }
          : EMPTY_USAGE,
      };
    },
  };
}

function anthropicAdapter(baseUrl: string): AiProviderAdapter {
  const label = "Anthropic";
  return {
    id: "anthropic",
    label,
    defaultModel: "claude-haiku-4-5-20251001",
    models: [{ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }],
    async generateText(request): Promise<AiGenerationResult> {
      const response = await postJson(
        label,
        endpoint(baseUrl, "/messages"),
        {
          "x-api-key": request.apiKey,
          "anthropic-version": "2023-06-01",
        },
        {
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.input }],
        },
        request.signal,
      );
      if (response.stop_reason === "refusal") {
        throw new AiError("AI_RESPONSE_REFUSED", 422, `${label} could not summarize this article.`);
      }
      if (response.stop_reason !== "end_turn") {
        throw new AiError(
          "AI_PROVIDER_FAILED",
          502,
          `${label} did not finish the summary. Try again.`,
        );
      }
      const content = Array.isArray(response.content) ? response.content : [];
      const values = content.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const block = part as Record<string, unknown>;
        return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
      });
      const usage = response.usage as Record<string, unknown> | undefined;
      return {
        text: requireText(label, values),
        usage: usage
          ? {
              inputTokens: tokenCount(usage.input_tokens),
              outputTokens: tokenCount(usage.output_tokens),
            }
          : EMPTY_USAGE,
      };
    },
  };
}

export function createAiProviders(
  endpoints: AiProviderEndpoints = {},
): ReadonlyMap<AiProvider, AiProviderAdapter> {
  const providers: AiProviderAdapter[] = [
    geminiAdapter(endpoints.gemini ?? "https://generativelanguage.googleapis.com/v1beta"),
    openAiAdapter(endpoints.openai ?? "https://api.openai.com/v1"),
    anthropicAdapter(endpoints.anthropic ?? "https://api.anthropic.com/v1"),
  ];
  return new Map(providers.map((provider) => [provider.id, provider]));
}
