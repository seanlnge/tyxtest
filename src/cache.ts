import fs from "node:fs";

import { readText, writeText } from "./fs-util.js";
import { hashContent } from "./hash.js";
import { prettyJson } from "./json.js";
import type { Citation, Verdict } from "./types.js";

export interface CacheKeyInput {
  testId: string;
  testText: string;
  closureHash: string;
  lockfileHash: string;
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

export function cacheKey(input: CacheKeyInput): string {
  return hashContent([input.testId, input.testText, input.closureHash, input.lockfileHash].join("\0"));
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
