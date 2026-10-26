import fs from "node:fs";
import path from "node:path";

import type { ModelConfig, ModelKind, Thresholds, TyxtestConfig } from "./types.js";

const LITERAL_KEY = /sk-[A-Za-z0-9_-]{8,}/;
const ENTRY_MODES = ["ask-plain", "ask-entry", "required"] as const;
const NON_INTERACTIVE = ["fail", "search"] as const;

export function configPath(cwd: string): string {
  return path.join(cwd, "tyxtest", "tyxtest.config.json");
}

export function defaultApiKeyEnv(provider: string): string | undefined {
  switch (provider.toLowerCase()) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "ollama":
      return undefined;
    case "google":
    case "gemini":
      return "GEMINI_API_KEY";
    default:
      return undefined;
  }
}

export function assertNoLiteralApiKeys(value: unknown): void {
  const hits = findLiteralKeys(value, "");
  if (hits.length === 0) return;
  const where = hits.join(", ");
  throw new Error(
    `Config value at ${where} looks like a literal API key (sk-...). Name an env var in apiKeyEnv instead.`,
  );
}

function findLiteralKeys(value: unknown, keyPath: string): string[] {
  if (typeof value === "string") {
    return LITERAL_KEY.test(value) ? [keyPath || "(root)"] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findLiteralKeys(item, `${keyPath}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      const next = keyPath ? `${keyPath}.${key}` : key;
      return findLiteralKeys(item, next);
    });
  }
  return [];
}

function literalKeyCheckEnabled(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
  const guards = (raw as Record<string, unknown>).guards;
  if (!guards || typeof guards !== "object" || Array.isArray(guards)) return true;
  return (guards as Record<string, unknown>).literalKeyCheck !== false;
}

export function parseConfig(raw: unknown): TyxtestConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("tyxtest.config.json must be a JSON object.");
  }
  if (literalKeyCheckEnabled(raw)) assertNoLiteralApiKeys(raw);
  return applyDefaults(raw as Record<string, unknown>);
}

export function loadConfig(cwd: string): TyxtestConfig {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${path.relative(cwd, file) || file}. Run \`tyxtest setup\`.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${file}: ${message}`);
  }
  return parseConfig(parsed);
}

export function requireModels(config: TyxtestConfig): { indexModel: ModelConfig; runnerModel: ModelConfig } {
  if (!config.indexModel || !config.runnerModel) {
    throw new Error("Set indexModel and runnerModel in tyxtest/tyxtest.config.json.");
  }
  return { indexModel: config.indexModel, runnerModel: config.runnerModel };
}

function applyDefaults(raw: Record<string, unknown>): TyxtestConfig {
  const guardsRaw = raw.guards;
  const guards =
    guardsRaw && typeof guardsRaw === "object" && !Array.isArray(guardsRaw)
      ? (guardsRaw as Record<string, unknown>)
      : {};

  return {
    indexModel: pickModel(raw.indexModel, "indexModel"),
    runnerModel: pickModel(raw.runnerModel, "runnerModel", "decision"),
    escalate: pickBoolean(raw.escalate, true, "escalate"),
    escalateModel: pickModel(raw.escalateModel, "escalateModel"),
    thresholds: pickThresholds(raw.thresholds),
    ignoreUnchanged: pickBoolean(raw.ignoreUnchanged, true, "ignoreUnchanged"),
    baseRef: pickBaseRef(raw.baseRef),
    entryMode: pickEnum(raw.entryMode, ENTRY_MODES, "ask-plain", "entryMode"),
    nonInteractive: pickEnum(raw.nonInteractive, NON_INTERACTIVE, "fail", "nonInteractive"),
    reruns: pickReruns(raw.reruns),
    verdictRule: pickVerdictRule(raw.verdictRule),
    unsureBlocks: pickBoolean(raw.unsureBlocks, false, "unsureBlocks"),
    triage: pickBoolean(raw.triage, false, "triage"),
    relocateCheck: pickBoolean(raw.relocateCheck, true, "relocateCheck"),
    closureDepth: pickDepth(raw.closureDepth),
    guards: {
      literalKeyCheck: pickBoolean(guards.literalKeyCheck, true, "guards.literalKeyCheck"),
      gitignoreEnv: pickBoolean(guards.gitignoreEnv, true, "guards.gitignoreEnv"),
    },
  };
}

function pickModel(value: unknown, label: string, defaultKind?: ModelKind): ModelConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object with provider and model.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || record.provider.trim() === "") {
    throw new Error(`${label}.provider is required.`);
  }
  if (typeof record.model !== "string" || record.model.trim() === "") {
    throw new Error(`${label}.model is required.`);
  }
  const model: ModelConfig = {
    provider: record.provider.trim(),
    model: record.model.trim(),
  };
  const kind = pickKind(record.kind, defaultKind, label);
  if (kind) model.kind = kind;
  if (record.apiKeyEnv !== undefined) {
    if (typeof record.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(record.apiKeyEnv)) {
      throw new Error(`${label}.apiKeyEnv must be an environment variable name.`);
    }
    model.apiKeyEnv = record.apiKeyEnv;
  }
  return model;
}

function pickKind(value: unknown, fallback: ModelKind | undefined, label: string): ModelKind | undefined {
  const picked = value === undefined ? fallback : value;
  if (picked === undefined) return undefined;
  if (picked !== "decision" && picked !== "llm") {
    throw new Error(`${label}.kind must be decision or llm.`);
  }
  return picked;
}

function pickThresholds(value: unknown): Thresholds {
  const defaults = { pass: 0.9, fail: 0.1 };
  if (value === undefined || value === null) return defaults;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("thresholds must be an object with pass and fail.");
  }
  const record = value as Record<string, unknown>;
  const pass = record.pass === undefined ? defaults.pass : record.pass;
  const fail = record.fail === undefined ? defaults.fail : record.fail;
  if (typeof pass !== "number" || typeof fail !== "number" || pass <= fail || pass > 1 || fail < 0) {
    throw new Error("thresholds.pass must be greater than thresholds.fail, both between 0 and 1.");
  }
  return { pass, fail };
}

function pickBaseRef(value: unknown): string {
  const picked = value === undefined ? "origin/main" : value;
  if (typeof picked !== "string" || picked.trim() === "") throw new Error("baseRef must be a git ref.");
  return picked.trim();
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
  const picked = value === undefined ? fallback : value;
  if (typeof picked !== "string" || !allowed.includes(picked as T)) {
    throw new Error(`${label} must be ${allowed.join(", ")}.`);
  }
  return picked as T;
}

function pickReruns(value: unknown): number {
  const picked = value === undefined ? 2 : value;
  if (typeof picked !== "number" || !Number.isInteger(picked) || picked < 0) {
    throw new Error("reruns must be a non-negative integer.");
  }
  return picked;
}

function pickVerdictRule(value: unknown): "worst" {
  const picked = value === undefined ? "worst" : value;
  if (picked !== "worst") {
    throw new Error('verdictRule must be "worst".');
  }
  return "worst";
}

function pickBoolean(value: unknown, fallback: boolean, label: string): boolean {
  const picked = value === undefined ? fallback : value;
  if (typeof picked !== "boolean") throw new Error(`${label} must be true or false.`);
  return picked;
}

function pickDepth(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("closureDepth must be a non-negative integer or null.");
  }
  return value;
}

export function resolveApiKeyName(model: ModelConfig): string | undefined {
  return model.apiKeyEnv ?? defaultApiKeyEnv(model.provider);
}

export function resolveApiKey(model: ModelConfig, env: NodeJS.ProcessEnv): string | undefined {
  const name = resolveApiKeyName(model);
  if (!name) return undefined;
  const value = env[name];
  if (!value) return undefined;
  return value;
}
