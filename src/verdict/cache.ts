import fs from "node:fs";

import { readText, writeText } from "../util/fs-util.js";
import { hashContent } from "../util/hash.js";
import { prettyJson } from "../util/json.js";
import type { Citation, TyxtestConfig, Verdict } from "../config/types.js";
import type { FlowRecord } from "../surface/index-file.js";

export interface CacheKeyInput {
  testId: string;
  testText: string;
  closureHash: string;
  lockfileHash: string;
  optionOrder: readonly string[];
  /** Versioned identity of the judgment policy and rendered context. */
  judgmentContext: string;
  /** Indexed chunk identities. Omitted and empty mean the same key. */
  chunkIds?: readonly string[];
}

export interface CacheHit {
  testId: string;
  /** Claim text needed to ensure triage does not reuse a renamed claim. */
  testText?: string;
  verdict: Verdict;
  evidence: Citation[];
  explanation: string;
  /** Missing on legacy entries; those entries are not reusable via triage. */
  judgmentContext?: string;
  /** Rendered source spans allow cached citations to follow line-only shifts. */
  evidenceRanges?: Array<{ path: string; line: number; endLine: number; id: string }>;
}

export interface VerdictCache {
  entries: Record<string, CacheHit>;
}

/** Bump when the text sent to the model changes without the source files changing. */
const CHUNK_RENDER = "indexed-evidence-v4-shared-scopes";
const JUDGMENT_CONTEXT_VERSION = "jctx-v6";

export interface JudgmentSurface {
  relativeDir: string;
  name: string;
  description: string;
  context?: string;
}

/** Fingerprint only settings and content that can change the resulting judgment. */
export function judgmentContextFingerprint(
  config: TyxtestConfig,
  surface: JudgmentSurface,
  flows: readonly FlowRecord[],
  chunkIds: readonly string[] = [],
  semanticContext = "",
): string {
  const model = (value: TyxtestConfig["runnerModel"]) =>
    value ? { provider: value.provider, model: value.model, kind: value.kind ?? null } : null;
  const context = {
    version: JUDGMENT_CONTEXT_VERSION,
    promptSchema: { verdict: ["pass", "fail"], evidence: ["yes", "no"], triage: ["changes", "unchanged"] },
    surface: {
      relativeDir: surface.relativeDir,
      name: surface.name,
      description: surface.description,
      context: semanticContext,
    },
    config: {
      runnerModel: model(config.runnerModel),
      indexModel: model(config.indexModel),
      escalate: config.escalate,
      escalateModel: model(config.escalateModel),
      fallback: config.fallback,
      thresholds: { pass: config.thresholds.pass, fail: config.thresholds.fail },
      reruns: config.reruns,
      verdictRule: config.verdictRule,
      triage: config.triage,
      relocateCheck: config.relocateCheck,
      chunkMaxTokens: config.chunkMaxTokens,
      markdown: config.markdown,
    },
    flows: flows.map((flow) => ({
      testId: flow.testId,
      steps: flow.steps.map((step) => ({
        id: step.id,
        text: step.text,
        context: step.context ?? [],
        chunks: step.chunks.map((chunk) => ({ path: chunk.path, symbol: chunk.symbol })),
      })),
    })),
    chunkIds: [...chunkIds],
  };
  return `${JUDGMENT_CONTEXT_VERSION}:${hashContent(JSON.stringify(context))}`;
}

export function cacheKey(input: CacheKeyInput): string {
  return hashContent(
    [
      input.testId,
      input.testText,
      input.closureHash,
      input.lockfileHash,
      input.optionOrder.join("\0"),
      input.judgmentContext,
      (input.chunkIds ?? []).join("\0"),
      CHUNK_RENDER,
    ].join("\0"),
  );
}

export function emptyCache(): VerdictCache {
  return { entries: {} };
}

export function loadCache(file: string): VerdictCache {
  if (!fs.existsSync(file)) return emptyCache();
  try {
    const parsed = JSON.parse(readText(file)) as Partial<VerdictCache>;
    if (!parsed.entries || typeof parsed.entries !== "object") return emptyCache();
    return { entries: parsed.entries };
  } catch {
    return emptyCache();
  }
}

export function saveCache(file: string, cache: VerdictCache): void {
  writeText(file, prettyJson(cache));
}
