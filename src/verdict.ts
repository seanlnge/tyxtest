import type { Thresholds, Verdict } from "./types.js";

type JudgedVerdict = Exclude<Verdict, "skipped">;

export const VERDICT_OPTIONS = ["pass", "fail"] as const;
export const EVIDENCE_OPTIONS = ["yes", "no"] as const;

/** p(pass) at or above the pass cutoff passes, at or below the fail cutoff fails, and the open interval escalates. */
export function thresholdVerdict(pPass: number, thresholds: Thresholds): "pass" | "fail" | "between" {
  if (pPass >= thresholds.pass) return "pass";
  if (pPass <= thresholds.fail) return "fail";
  return "between";
}

/**
 * Default rule ("worst"):
 * - the first run passing is a pass
 * - every run failing is a fail
 * - any fail mixed with another outcome is unsure
 * - a set with no pass-first and no fail is unsure
 */
export function aggregateVerdicts(runs: JudgedVerdict[], rule: "worst" = "worst"): JudgedVerdict {
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
