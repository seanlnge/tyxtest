import path from "node:path";

import { defaultApiKeyEnv, parseConfig } from "./config.js";
import { writeText } from "./fs-util.js";
import { generateCommand } from "./generate.js";
import { ensureEnvGitignore, ensureIndexMergeAttributes, ensureOursMergeDriver } from "./git-files.js";
import type { Prompter } from "./prompter.js";
import type { ModelConfig, ModelKind } from "./types.js";

const PROVIDERS = new Set(["anthropic", "openai", "ollama", "typesafe", "laya"]);

export async function setupCommand(options: {
  cwd: string;
  prompter: Prompter;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
}): Promise<void> {
  const env = options.env ?? process.env;
  const index = await askModel(options.prompter, env, "index", "TYXTEST_INDEX_KEY", undefined);
  const runner = await askRunner(options.prompter, env);
  const escalateModel = await askOptionalModel(options.prompter, env);
  const entryAnswer = await options.prompter.ask("Entry mode (ask-plain, ask-entry, required) [ask-plain]:");
  const entryMode = entryAnswer.trim() || "ask-plain";
  const generateAnswer = await options.prompter.ask("Generate tests now? (yes/no) [no]:");

  const config = parseConfig({
    indexModel: index,
    runnerModel: runner,
    escalate: true,
    escalateModel: escalateModel ?? null,
    thresholds: { pass: 0.9, fail: 0.1 },
    ignoreUnchanged: true,
    baseRef: "origin/main",
    triage: false,
    relocateCheck: true,
    entryMode,
    nonInteractive: "fail",
    reruns: 2,
    verdictRule: "worst",
    unsureBlocks: false,
    closureDepth: null,
    guards: { literalKeyCheck: true, gitignoreEnv: true },
  });
  writeText(
    path.join(options.cwd, "tyxtest", "tyxtest.config.json"),
    renderConfig(config),
  );
  if (config.guards.gitignoreEnv) ensureEnvGitignore(options.cwd);
  ensureIndexMergeAttributes(options.cwd);
  ensureOursMergeDriver(options.cwd);
  options.prompter.log("Wrote tyxtest/tyxtest.config.json, .gitignore, and .gitattributes.");

  if (isYes(generateAnswer)) {
    await generateCommand({
      cwd: options.cwd,
      prompter: options.prompter,
      interactive: options.interactive ?? true,
      env,
    });
  }
}

async function askModel(
  prompter: Prompter,
  env: NodeJS.ProcessEnv,
  role: "index" | "runner" | "escalation",
  fallbackEnv: string,
  kind: ModelKind | undefined,
): Promise<ModelConfig> {
  const label = role === "index" ? "Index" : role === "runner" ? "Runner" : "Escalation";
  const provider = normalizeProvider(
    await required(prompter, `${label} model provider (anthropic, openai, ollama):`),
  );
  const model = await required(prompter, `${label} model name:`);
  return finishModel(prompter, env, role, fallbackEnv, provider, model, kind);
}

async function askRunner(prompter: Prompter, env: NodeJS.ProcessEnv): Promise<ModelConfig> {
  const kindAnswer = (await prompter.ask("Runner kind (decision/llm) [decision]:")).trim().toLowerCase() || "decision";
  if (kindAnswer !== "decision" && kindAnswer !== "llm") {
    throw new Error("Runner kind must be decision or llm.");
  }
  const kind = kindAnswer;
  const defaultProvider = kind === "decision" ? "typesafe" : "anthropic";
  const defaultModel = kind === "decision" ? "jev" : "";
  const provider = normalizeProvider(
    (await prompter.ask(`Runner model provider [${defaultProvider}]:`)).trim() || defaultProvider,
  );
  const model = (await prompter.ask(defaultModel ? `Runner model name [${defaultModel}]:` : "Runner model name:")).trim() || defaultModel;
  if (!model) throw new Error("Runner model name is required.");
  return finishModel(prompter, env, "runner", "TYXTEST_RUN_KEY", provider, model, kind);
}

async function askOptionalModel(prompter: Prompter, env: NodeJS.ProcessEnv): Promise<ModelConfig | undefined> {
  const providerAnswer = (await prompter.ask("Escalation model provider (blank to use the index model):")).trim();
  if (!providerAnswer) return undefined;
  const provider = normalizeProvider(providerAnswer);
  const model = await required(prompter, "Escalation model name:");
  return finishModel(prompter, env, "escalation", "TYXTEST_INDEX_KEY", provider, model, "llm");
}

async function finishModel(
  prompter: Prompter,
  env: NodeJS.ProcessEnv,
  role: "index" | "runner" | "escalation",
  fallbackEnv: string,
  provider: string,
  model: string,
  kind: ModelKind | undefined,
): Promise<ModelConfig> {
  const config: ModelConfig = { provider, model };
  if (kind) config.kind = kind;
  if (provider === "ollama") return config;
  const fallback = defaultApiKeyEnv(provider) ?? fallbackEnv;
  const named = (await prompter.ask(`Env var for the ${role} model key [${fallback}]:`)).trim() || fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(named)) {
    throw new Error(`${named} is not an environment variable name.`);
  }
  config.apiKeyEnv = named;
  if (!env[named]) prompter.warn(`${named} is not set. Add it to .env locally or to the CI secrets.`);
  return config;
}

async function required(prompter: Prompter, question: string): Promise<string> {
  const answer = (await prompter.ask(question)).trim();
  if (!answer) throw new Error(`An answer is required (${question.replace(/:$/, "")}).`);
  return answer;
}

function normalizeProvider(value: string): string {
  const provider = value.trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new Error(`Unsupported provider "${value}". Use anthropic, openai, ollama, typesafe, or laya.`);
  }
  return provider;
}

function renderConfig(config: {
  indexModel?: ModelConfig;
  runnerModel?: ModelConfig;
  escalateModel?: ModelConfig;
  entryMode: string;
}): string {
  return `${JSON.stringify(
    {
      indexModel: config.indexModel,
      runnerModel: config.runnerModel,
      escalate: true,
      escalateModel: config.escalateModel ?? null,
      thresholds: { pass: 0.9, fail: 0.1 },
      ignoreUnchanged: true,
      baseRef: "origin/main",
      entryMode: config.entryMode,
      nonInteractive: "fail",
      reruns: 2,
      verdictRule: "worst",
      unsureBlocks: false,
      triage: false,
      relocateCheck: true,
      closureDepth: null,
      guards: { literalKeyCheck: true, gitignoreEnv: true },
    },
    null,
    2,
  )}\n`;
}

function isYes(value: string): boolean {
  return ["y", "yes", "true", "1"].includes(value.trim().toLowerCase());
}
