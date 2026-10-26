export type Verdict = "pass" | "fail" | "unsure" | "skipped";

export interface Citation {
  file: string;
  line: number;
}

export type ModelKind = "decision" | "llm";

export interface ModelConfig {
  provider: string;
  model: string;
  apiKeyEnv?: string;
  kind?: ModelKind;
}

export type EntryMode = "ask-plain" | "ask-entry" | "required";

export type NonInteractive = "fail" | "search";

export interface Guards {
  literalKeyCheck: boolean;
  gitignoreEnv: boolean;
}

export interface Thresholds {
  pass: number;
  fail: number;
}

export interface TyxtestConfig {
  indexModel?: ModelConfig;
  runnerModel?: ModelConfig;
  escalate: boolean;
  escalateModel?: ModelConfig;
  thresholds: Thresholds;
  ignoreUnchanged: boolean;
  baseRef: string;
  entryMode: EntryMode;
  nonInteractive: NonInteractive;
  reruns: number;
  verdictRule: "worst";
  unsureBlocks: boolean;
  triage: boolean;
  closureDepth: number | null;
  guards: Guards;
}

export type ModelPurpose = "index" | "run" | "resolve-entry" | "generate" | "search";

export interface ModelRequest {
  purpose: ModelPurpose;
  system: string;
  prompt: string;
}

export type DecisionPurpose = "verdict" | "evidence" | "triage";

export interface DecisionRequest {
  purpose: DecisionPurpose;
  state: string;
  options: string[];
}

/** Probabilities aligned with `options`, in that same order. Decision models do not return text or line numbers. */
export interface DecisionAnswer {
  probabilities: number[];
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<string>;
  decide?(request: DecisionRequest): Promise<DecisionAnswer>;
}

export type ModelSource = ModelClient | (() => ModelClient);
