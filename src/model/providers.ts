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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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
    throw new Error(`Model request failed (${response.status}): ${errorText(payload, text)}`);
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
    const question = choiceQuestion(request);
    if (provider === "openai") {
      const payload = await postJson(
        "https://api.openai.com/v1/decisions",
        {
          model,
          input: request.state,
          questions: [{ type: "choice", name: "answer", options: request.options, prompt: question.instructions }],
        },
        { authorization: `Bearer ${this.apiKey}` },
      );
      return { probabilities: readProbabilities(payload, request.options) };
    }
    const laya = provider === "laya" || model.toLowerCase().startsWith("laya");
    const url = laya ? layaUrl(this.env) : typesafeUrl(this.env);
    const payload = await postJson(
      url,
      {
        model,
        state: request.state,
        questions: { answer: question },
      },
      { authorization: `Bearer ${this.apiKey}` },
    );
    return { probabilities: readChoiceProbabilities(payload, request.options) };
  }

  async decideMany(requests: DecisionRequest[]): Promise<DecisionAnswer[]> {
    if (requests.length === 0) return [];
    if (requests.length === 1) return [await this.decide(requests[0]!)];
    const provider = this.config.provider.toLowerCase();
    if (provider === "openai") {
      const answers: DecisionAnswer[] = [];
      for (const request of requests) answers.push(await this.decide(request));
      return answers;
    }
    const model = this.config.model === "jev" ? "jev-latest" : this.config.model;
    const state: Record<string, string> = {};
    const questions: Record<string, ReturnType<typeof choiceQuestion>> = {};
    requests.forEach((request, index) => {
      const key = `q${index}`;
      state[key] = request.state;
      questions[key] = choiceQuestion(request, key);
    });
    const laya = provider === "laya" || model.toLowerCase().startsWith("laya");
    const url = laya ? layaUrl(this.env) : typesafeUrl(this.env);
    const payload = await postJson(url, { model, state, questions }, { authorization: `Bearer ${this.apiKey}` });
    return requests.map((request, index) => ({
      probabilities: readChoiceProbabilities(payload, request.options, `q${index}`),
    }));
  }
}

const CHOICE_INSTRUCTIONS: Record<DecisionRequest["purpose"], string> = {
  verdict: "Does the code satisfy the claim?",
  evidence: "Does this chunk implement the claim?",
  triage: "Could this diff change whether the claim is true?",
};

const CHOICE_CRITERIA: Record<DecisionRequest["purpose"], Record<string, string>> = {
  verdict: {
    pass: "The code does what the claim says.",
    fail: "The code leaves the claim unsatisfied.",
  },
  evidence: {
    yes: "This chunk is part of how the claim is implemented.",
    no: "Nothing in this chunk carries out the claim.",
  },
  triage: {
    changes: "This diff could change whether the claim is true.",
    unchanged: "This diff leaves the claim as true or false as it was.",
  },
};

function choiceQuestion(
  request: DecisionRequest,
  stateKey?: string,
): {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
} {
  const known = CHOICE_CRITERIA[request.purpose];
  const criteria: Record<string, string> = {};
  for (const option of request.options) criteria[option] = known[option] ?? option;
  const instructions = stateKey
    ? `${CHOICE_INSTRUCTIONS[request.purpose]} Use only \`${stateKey}\`.`
    : CHOICE_INSTRUCTIONS[request.purpose];
  return { type: "choice", instructions, criteria };
}

function typesafeUrl(env: NodeJS.ProcessEnv): string {
  const base = (env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "");
  return `${base}/v1/systemone`;
}

function layaUrl(env: NodeJS.ProcessEnv): string {
  return (env.LAYA_BASE_URL || "https://api.laya.ai/v1/systemone").replace(/\/$/, "");
}

function errorText(payload: unknown, text: string): string {
  if (payload && typeof payload === "object") {
    const record = payload as { error?: unknown; detail?: unknown };
    if (record.error !== undefined) return JSON.stringify(record.error).slice(0, 500);
    if (record.detail !== undefined) return JSON.stringify(record.detail).slice(0, 500);
  }
  return text.slice(0, 500);
}

function readChoiceProbabilities(payload: unknown, options: string[], name = "answer"): number[] {
  const answers =
    payload && typeof payload === "object" ? (payload as { answers?: unknown }).answers : undefined;
  const answer =
    answers && typeof answers === "object" && !Array.isArray(answers)
      ? (answers as Record<string, unknown>)[name]
      : undefined;
  const probabilities =
    answer && typeof answer === "object" ? (answer as { probabilities?: unknown }).probabilities : undefined;
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) {
    throw new Error("Decision response did not include probabilities.");
  }
  return probabilitiesFor(probabilities as Record<string, unknown>, options);
}

function readProbabilities(payload: unknown, options: string[]): number[] {
  const found = findProbabilityMap(payload);
  if (!found) throw new Error("Decision response did not include probabilities.");
  return probabilitiesFor(found, options);
}

function probabilitiesFor(found: Record<string, unknown>, options: string[]): number[] {
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
