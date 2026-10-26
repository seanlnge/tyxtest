import fs from "node:fs";

import { readText, writeText } from "../util/fs-util.js";
import { hashContent } from "../util/hash.js";
import { prettyJson } from "../util/json.js";
import type { Citation, Verdict } from "../config/types.js";

export interface CacheKeyInput {
  testId: string;
  testText: string;
  closureHash: string;
  lockfileHash: string;
  optionOrder: readonly string[];
  /** Indexed chunk identities. Omitted and empty mean the same key. */
  chunkIds?: readonly string[];
}

export interface CacheHit {
  testId: string;
  verdict: Verdict;
  evidence: Citation[];
  explanation: string;
}

export interface VerdictCache {
  entries: Record<string, CacheHit>;
}

/** Bump when the text sent to the model changes without the source files changing. */
const CHUNK_RENDER = "constants";

export function cacheKey(input: CacheKeyInput): string {
  return hashContent(
    [
      input.testId,
      input.testText,
      input.closureHash,
      input.lockfileHash,
      input.optionOrder.join("\0"),
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
