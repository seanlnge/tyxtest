import { withRateLimitBackoff } from "./backoff.js";
import { resolveApiKey, resolveApiKeyName } from "../config/config.js";
import type { DecisionAnswer, DecisionRequest, ModelClient, ModelConfig, ModelRequest } from "../config/types.js";

const REQUEST_TIMEOUT_MS = 120_000;

export function createModelClient(config: ModelConfig, env: NodeJS.ProcessEnv): ModelClient {
  if (config.kind === "decision") return createDecisionClient(config, env);
  const provider = config.provider.toLowerCase();
  if (provider === "ollama") return new OllamaClient(config.model, env);
  const key = resolveApiKey(config, env);
  if (!key) {
    const name = resolveApiKeyName(config) ?? `${config.provider} API key`;
    throw new Error(`Missing API key. Set ${name}.`);
  }
  if (provider === "anthropic") return new AnthropicClient(config.model, key);
  if (provider === "openai") return new OpenAIClient(config.model, key);
  throw new Error(`Unsupported provider "${config.provider}". Use anthropic, openai, ollama, or a decision provider.`);
}

function createDecisionClient(config: ModelConfig, env: NodeJS.ProcessEnv): ModelClient {
  const provider = config.provider.toLowerCase();
  if (provider === "ollama") {
    throw new Error("Ollama is an LLM provider. Set runnerModel.kind to llm, or use typesafe, laya, or openai.");
  }
  const key = resolveApiKey(config, env);
  if (!key) {
    const name = resolveApiKeyName(config) ?? "TYXTEST_RUN_KEY";
    throw new Error(`Missing API key. Set ${name}.`);
  }
  return new DecisionClient(config, key, env);
}

class AnthropicClient implements ModelClient {
  constructor(
    private readonly model: string,
    private readonly apiKey: string,
  ) {}

  async complete(request: ModelRequest): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: request.prompt }],
    };
    if (request.system) body.system = request.system;
    const payload = await postJson("https://api.anthropic.com/v1/messages", body, {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    });
    const content = (payload as { content?: Array<{ text?: string }> }).content;
    const text = content?.map((block) => block.text ?? "").join("") ?? "";
    if (!text) throw new Error("Anthropic returned an empty response.");
    return text;
  }
}

class OpenAIClient implements ModelClient {
  constructor(
    private readonly model: string,
    private readonly apiKey: string,
  ) {}

  async complete(request: ModelRequest): Promise<string> {
    const messages = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    messages.push({ role: "user", content: request.prompt });
    const payload = await postJson(
      "https://api.openai.com/v1/chat/completions",
      { model: this.model, messages },
      { authorization: `Bearer ${this.apiKey}` },
    );
    const message = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message
      ?.content;
    const text = contentText(message);
    if (!text) throw new Error("OpenAI returned an empty response.");
    return text;
  }
}

class OllamaClient implements ModelClient {
  constructor(
    private readonly model: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async complete(request: ModelRequest): Promise<string> {
    const host = (this.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
    const messages = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    messages.push({ role: "user", content: request.prompt });
    const payload = await postJson(`${host}/api/chat`, { model: this.model, messages, stream: false }, {});
    const text = (payload as { message?: { content?: string } }).message?.content ?? "";
    if (!text) throw new Error("Ollama returned an empty response.");
    return text;
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  return withRateLimitBackoff(() => postJsonOnce(url, body, headers));
}

async function postJsonOnce(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 429) {
    const text = await response.text();
    throw new Error(`Model request failed (429): rate limit ${text.slice(0, 200)}`);
  }
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = { raw: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? JSON.stringify((payload as { error?: unknown }).error).slice(0, 500)
        : text.slice(0, 500);
    throw new Error(`Model request failed (${response.status}): ${message}`);
  }
  return payload;
}

class DecisionClient implements ModelClient {
  constructor(
    private readonly config: ModelConfig,
    private readonly apiKey: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async complete(): Promise<string> {
    throw new Error("Decision models cannot generate text.");
  }

  async decide(request: DecisionRequest): Promise<DecisionAnswer> {
    const provider = this.config.provider.toLowerCase();
    const model = this.config.model === "jev" ? "jev-latest" : this.config.model;
    const criteria: Record<string, string> = {};
    for (const option of request.options) criteria[option] = option;
    const instructions =
      request.purpose === "evidence"
        ? "Does this chunk implement the claim? Choose only from the given options."
        : request.purpose === "triage"
          ? "Could this diff change whether the claim is true? Choose only from the given options."
          : "Does the code satisfy the claim? Choose only from the given options.";
    if (provider === "openai") {
      const payload = await postJson(
        "https://api.openai.com/v1/decisions",
        {
          model,
          input: request.state,
          questions: [{ type: "choice", name: "answer", options: request.options, prompt: instructions }],
        },
        { authorization: `Bearer ${this.apiKey}` },
      );
      return { probabilities: readProbabilities(payload, request.options) };
    }
    const laya = provider === "laya" || model.toLowerCase().startsWith("laya");
    const url = laya
      ? (this.env.LAYA_BASE_URL || "https://api.laya.ai/v1/systemone").replace(/\/$/, "")
      : "https://jevtypesafeai.com/api/v1/decide";
    const payload = await postJson(
      url,
      {
        model,
        state: request.state,
        questions: { answer: { type: "choice", instructions, criteria } },
      },
      { authorization: `Bearer ${this.apiKey}` },
    );
    return { probabilities: readProbabilities(payload, request.options) };
  }
}

function readProbabilities(payload: unknown, options: string[]): number[] {
  const found = findProbabilityMap(payload);
  if (!found) throw new Error("Decision response did not include probabilities.");
  return options.map((option) => {
    const value = found[option];
    if (typeof value !== "number") throw new Error(`Decision response missing probability for ${option}.`);
    return value;
  });
}

function findProbabilityMap(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProbabilityMap(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.probabilities && typeof record.probabilities === "object" && !Array.isArray(record.probabilities)) {
    return record.probabilities as Record<string, number>;
  }
  for (const nested of Object.values(record)) {
    const found = findProbabilityMap(nested);
    if (found) return found;
  }
  return undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}
