import type { Verdict } from "./types.js";

/**
 * Default rule ("worst"):
 * - the first run passing is a pass
 * - every run failing is a fail
 * - any fail mixed with another outcome is unsure
 * - a set with no pass-first and no fail is unsure
 */
export function aggregateVerdicts(runs: Verdict[], rule: "worst" = "worst"): Verdict {
  if (rule !== "worst") {
    throw new Error(`verdictRule must be "worst".`);
  }
  if (runs.length === 0) return "unsure";
  if (runs[0] === "pass") return "pass";
  if (runs.every((run) => run === "fail")) return "fail";
  return "unsure";
}

export function exitCodeFor(verdicts: Verdict[], unsureBlocks: boolean): number {
  for (const verdict of verdicts) {
    if (verdict === "fail") return 1;
    if (verdict === "unsure" && unsureBlocks) return 1;
  }
  return 0;
}
