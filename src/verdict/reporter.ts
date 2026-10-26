import { writeText } from "../util/fs-util.js";
import type { Citation, Verdict } from "../config/types.js";

export interface ReportedTest {
  surface: string;
  id: string;
  text: string;
  verdict: Verdict;
  cached: boolean;
  runs: Verdict[];
  evidence: Citation[];
  explanation: string;
  /** Set when this run answered the test with the fallback model after the decision API failed. */
  fallback?: string;
}

export function aggregateFindings(results: ReportedTest[], verbose: boolean): string[] {
  const lines: string[] = [];
  for (const result of results) {
    if (result.verdict !== "fail" && result.verdict !== "unsure" && !(verbose && result.verdict === "pass")) continue;
    if (result.verdict === "pass" && result.evidence.length === 0 && !result.explanation) continue;
    lines.push(`${result.verdict}  [${result.surface}/${result.id}] ${result.text}`);
    for (const citation of result.evidence) lines.push(`  ${citation.file}:${citation.line}`);
    if (result.explanation) lines.push(`  ${result.explanation}`);
    lines.push("");
  }
  return lines;
}

export function summaryLines(results: ReportedTest[], unsureBlocks: boolean): string[] {
  const counts = countVerdicts(results);
  const lines = [
    `${counts.pass} pass, ${counts.fail} fail, ${counts.unsure} unsure${counts.skipped ? `, ${counts.skipped} skipped (unchanged)` : ""}`,
  ];
  if (counts.fail > 0) lines.push("fail blocks CI");
  if (counts.unsure > 0 && unsureBlocks) lines.push("unsure blocks CI");
  return lines;
}

export function fallbackLines(results: ReportedTest[]): string[] {
  const labels = results.flatMap((result) => (result.fallback ? [result.fallback] : []));
  if (labels.length === 0) return [];
  const models = [...new Set(labels)];
  const noun = labels.length === 1 ? "1 test fell back" : `${labels.length} tests fell back`;
  return [`${noun} to ${models.join(", ")} after the decision API failed`];
}

export function formatReport(
  results: ReportedTest[],
  unsureBlocks: boolean,
  verbose = false,
  showCached = false,
): string {
  const lines: string[] = [];
  const groups = new Map<string, ReportedTest[]>();
  for (const result of results) {
    const group = groups.get(result.surface) ?? [];
    group.push(result);
    groups.set(result.surface, group);
  }
  for (const [surface, tests] of groups) {
    const visible = showCached ? tests : tests.filter((test) => !test.cached);
    if (visible.length === 0) continue;
    lines.push(surface);
    for (const test of visible) {
      if (test.verdict === "skipped") {
        lines.push(`  skipped (unchanged)  [${test.id}] ${test.text}`);
        continue;
      }
      const cached = test.cached ? " (cached)" : "";
      lines.push(`  ${test.verdict}  [${test.id}] ${test.text}${cached}`);
    }
    lines.push("");
  }
  lines.push(...summaryLines(results, unsureBlocks));
  const findings = aggregateFindings(results, verbose);
  if (findings.length > 0) {
    lines.push("");
    lines.push(...findings);
  }
  const fallback = fallbackLines(results);
  if (fallback.length > 0) {
    lines.push("");
    lines.push(...fallback);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function writeReports(dir: string, results: ReportedTest[], unsureBlocks: boolean): { json: string; junit: string } {
  const json = `${dir}/results.json`;
  const junit = `${dir}/junit.xml`;
  writeText(json, `${JSON.stringify({ tests: results, summary: countVerdicts(results) }, null, 2)}\n`);
  writeText(junit, renderJUnit(results, unsureBlocks));
  return { json, junit };
}

function countVerdicts(results: ReportedTest[]): { pass: number; fail: number; unsure: number; skipped: number } {
  return {
    pass: results.filter((result) => result.verdict === "pass").length,
    fail: results.filter((result) => result.verdict === "fail").length,
    unsure: results.filter((result) => result.verdict === "unsure").length,
    skipped: results.filter((result) => result.verdict === "skipped").length,
  };
}

function renderJUnit(results: ReportedTest[], unsureBlocks: boolean): string {
  const failures = results.filter(
    (result) => result.verdict === "fail" || (result.verdict === "unsure" && unsureBlocks),
  ).length;
  const cases = results
    .map((result) => {
      const name = escapeXml(result.id);
      const classname = escapeXml(result.surface);
      const body =
        result.verdict === "skipped"
          ? `<skipped message="unchanged"/>`
          : result.verdict === "fail" || (result.verdict === "unsure" && unsureBlocks)
            ? `<failure message="${escapeXml(result.verdict)}">${escapeXml(result.explanation)}</failure>`
            : result.verdict === "unsure"
              ? `<system-out>${escapeXml(result.explanation || "unsure")}</system-out>`
              : "";
      return `    <testcase name="${name}" classname="${classname}">${body}</testcase>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="tyxtest" tests="${results.length}" failures="${failures}">\n${cases}\n</testsuite>\n`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
