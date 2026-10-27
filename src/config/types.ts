export type Verdict = "pass" | "fail" | "unsure" | "skipped";

export interface Citation {
  file: string;
  line: number;
  /** Function, component, or class the chunker attributed. */
  symbol?: string;
  /** Short content hash of the chunk. Identity is `file#symbol@hash`, not the line. */
  hash?: string;
  id?: string;
}

export type ModelKind = "decision" | "llm";

export interface ModelConfig {
  provider: string;
  model: string;
  apiKeyEnv?: string;
  kind?: ModelKind;
}

export type NonInteractive = "fail" | "search";

export interface Guards {
  literalKeyCheck: boolean;
  gitignoreEnv: boolean;
}

export interface Thresholds {
  pass: number;
  fail: number;
}

export interface MarkdownConfig {
  testDiscovery: {
    mode: "headings" | "bullets";
    headingLevel: 2 | 3 | 4 | 5 | 6;
    prefix: string | null;
  };
}

export interface TyxtestConfig {
  markdown: MarkdownConfig;
  indexModel?: ModelConfig;
  runnerModel?: ModelConfig;
  escalate: boolean;
  escalateModel?: ModelConfig;
  /** When true, a failed decision request is answered by the escalation model. */
  fallback: boolean;
  thresholds: Thresholds;
  ignoreUnchanged: boolean;
  baseRef: string;
  nonInteractive: NonInteractive;
  reruns: number;
  verdictRule: "worst" | "majority" | "best";
  unsureBlocks: boolean;
  /** When false, a run hides tests whose verdict was reused from the cache. */
  showCached: boolean;
  triage: boolean;
  relocateCheck: boolean;
  maxQuestions: number;
  chunkMaxTokens: number;
  concurrency: number;
  guards: Guards;
}

export type ModelPurpose = "index" | "run" | "generate" | "search" | "relocate";

export interface ModelRequest {
  purpose: ModelPurpose;
  system: string;
  prompt: string;
}

export type DecisionPurpose = "verdict" | "evidence" | "triage";

/** One complete logical test/step context, shared by object identity within a batch. */
export interface DecisionScope {
  id: string;
  state: string;
}

export interface DecisionRequest {
  purpose: DecisionPurpose;
  state: string;
  options: string[];
  /** Optional native System One wire scope; state remains complete for other clients. */
  sharedState?: {
    scope: DecisionScope;
    chunk?: { path: string; symbol: string; line: number; endLine: number };
  };
}

/** Probabilities aligned with `options`, in that same order. Decision models do not return text or line numbers. */
export interface DecisionAnswer {
  probabilities: number[];
}

/** Provider-reported token usage. Missing usage is intentionally not estimated. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  available: boolean;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<string>;
  /** Cumulative usage reported by successful provider responses, when available. */
  usage?(): ModelUsage | undefined;
  decide?(request: DecisionRequest): Promise<DecisionAnswer>;
  /** One System One request for every question. Falls back to decide() when absent. */
  decideMany?(requests: DecisionRequest[]): Promise<DecisionAnswer[]>;
}

export type ModelSource = ModelClient | (() => ModelClient);
