import { resolveApiKey, resolveApiKeyName } from "./config.js";
import type { ModelClient, ModelConfig, ModelRequest } from "./types.js";

const REQUEST_TIMEOUT_MS = 120_000;

export function createModelClient(config: ModelConfig, env: NodeJS.ProcessEnv): ModelClient {
  const provider = config.provider.toLowerCase();
  if (provider === "ollama") return new OllamaClient(config.model, env);
  const key = resolveApiKey(config, env);
  if (!key) {
    const name = resolveApiKeyName(config) ?? `${config.provider} API key`;
    throw new Error(`Missing API key. Set ${name}.`);
  }
  if (provider === "anthropic") return new AnthropicClient(config.model, key);
  if (provider === "openai") return new OpenAIClient(config.model, key);
  throw new Error(`Unsupported provider "${config.provider}". Use anthropic, openai, or ollama.`);
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
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
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
