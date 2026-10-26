import type { Thresholds, Verdict } from "../config/types.js";

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
 * Combine Jev attempts without relying on their order.
 */
export function aggregateVerdicts(
  runs: JudgedVerdict[],
  rule: "worst" | "majority" | "best" = "worst",
): JudgedVerdict {
  if (runs.length === 0) return "unsure";
  const hasPass = runs.some((run) => run === "pass");
  const hasFail = runs.some((run) => run === "fail");
  if (rule === "best") {
    if (hasPass) return "pass";
    return hasFail && runs.every((run) => run === "fail") ? "fail" : "unsure";
  }
  if (rule === "majority") {
    const passes = runs.filter((run) => run === "pass").length;
    const fails = runs.filter((run) => run === "fail").length;
    if (passes > runs.length / 2) return "pass";
    if (fails > runs.length / 2) return "fail";
    return "unsure";
  }
  if (rule !== "worst") throw new Error(`Unsupported verdictRule: ${String(rule)}.`);
  if (hasPass && hasFail) return "unsure";
  if (runs.every((run) => run === "pass")) return "pass";
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
