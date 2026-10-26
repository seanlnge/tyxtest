export type Verdict = "pass" | "fail" | "unsure";

export interface Citation {
  file: string;
  line: number;
}

export interface ModelConfig {
  provider: string;
  model: string;
  apiKeyEnv?: string;
}

export type EntryMode = "ask-plain" | "ask-entry" | "required";

export type NonInteractive = "fail" | "search";

export interface Guards {
  literalKeyCheck: boolean;
  gitignoreEnv: boolean;
}

export interface TyxtestConfig {
  indexModel?: ModelConfig;
  runnerModel?: ModelConfig;
  entryMode: EntryMode;
  nonInteractive: NonInteractive;
  reruns: number;
  verdictRule: "worst";
  unsureBlocks: boolean;
  closureDepth: number | null;
  guards: Guards;
}

export type ModelPurpose = "index" | "run" | "resolve-entry" | "generate" | "search";

export interface ModelRequest {
  purpose: ModelPurpose;
  system: string;
  prompt: string;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<string>;
}

export type ModelSource = ModelClient | (() => ModelClient);
