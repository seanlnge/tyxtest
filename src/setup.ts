import path from "node:path";

import { defaultApiKeyEnv, parseConfig } from "./config.js";
import { writeText } from "./fs-util.js";
import { generateCommand } from "./generate.js";
import { ensureEnvGitignore, ensureIndexMergeAttributes, ensureOursMergeDriver } from "./git-files.js";
import type { Prompter } from "./prompter.js";
import type { ModelConfig } from "./types.js";

const PROVIDERS = new Set(["anthropic", "openai", "ollama"]);

export async function setupCommand(options: {
  cwd: string;
  prompter: Prompter;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
}): Promise<void> {
  const env = options.env ?? process.env;
  const index = await askModel(options.prompter, env, "index", "TYXTEST_INDEX_KEY");
  const runner = await askModel(options.prompter, env, "runner", "TYXTEST_RUN_KEY");
  const entryAnswer = await options.prompter.ask("Entry mode (ask-plain, ask-entry, required) [ask-plain]:");
  const entryMode = entryAnswer.trim() || "ask-plain";
  const generateAnswer = await options.prompter.ask("Generate tests now? (yes/no) [no]:");

  const config = parseConfig({
    indexModel: index,
    runnerModel: runner,
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
    renderConfig(config.indexModel!, config.runnerModel!, config.entryMode),
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
  role: "index" | "runner",
  fallbackEnv: string,
): Promise<ModelConfig> {
  const label = role === "index" ? "Index" : "Runner";
  const provider = normalizeProvider(await required(prompter, `${label} model provider (anthropic, openai, ollama):`));
  const model = await required(prompter, `${label} model name:`);
  const config: ModelConfig = { provider, model };
  if (provider === "ollama") return config;
  const fallback = defaultApiKeyEnv(provider) ?? fallbackEnv;
  const named = (await prompter.ask(`Env var for the ${role} model key [${fallback}]:`)).trim() || fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(named)) {
    throw new Error(`${named} is not an environment variable name.`);
  }
  config.apiKeyEnv = named;
  if (!env[named]) {
    prompter.warn(`${named} is not set. Add it to .env locally or to the CI secrets.`);
  }
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
    throw new Error(`Unsupported provider "${value}". Use anthropic, openai, or ollama.`);
  }
  return provider;
}

function renderConfig(indexModel: ModelConfig, runnerModel: ModelConfig, entryMode: string): string {
  return `${JSON.stringify(
    {
      indexModel,
      runnerModel,
      entryMode,
      nonInteractive: "fail",
      reruns: 2,
      verdictRule: "worst",
      unsureBlocks: false,
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
