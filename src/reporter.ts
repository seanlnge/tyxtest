import { writeText } from "./fs-util.js";
import type { Citation, Verdict } from "./types.js";

export interface ReportedTest {
  surface: string;
  id: string;
  text: string;
  verdict: Verdict;
  cached: boolean;
  runs: Verdict[];
  evidence: Citation[];
  explanation: string;
}

export function formatReport(results: ReportedTest[], unsureBlocks: boolean, verbose = false): string {
  const lines: string[] = [];
  const groups = new Map<string, ReportedTest[]>();
  for (const result of results) {
    const group = groups.get(result.surface) ?? [];
    group.push(result);
    groups.set(result.surface, group);
  }
  for (const [surface, tests] of groups) {
    lines.push(surface);
    for (const test of tests) {
      if (test.verdict === "skipped") {
        lines.push(`  skipped (unchanged)  [${test.id}] ${test.text}`);
        continue;
      }
      const cached = test.cached ? " (cached)" : "";
      lines.push(`  ${test.verdict}  [${test.id}] ${test.text}${cached}`);
      if (test.verdict === "pass" && !verbose) continue;
      for (const citation of test.evidence) {
        lines.push(`    ${citation.file}:${citation.line}`);
      }
      if (test.explanation) lines.push(`    ${test.explanation}`);
    }
    lines.push("");
  }
  const counts = countVerdicts(results);
  lines.push(
    `${counts.pass} pass, ${counts.fail} fail, ${counts.unsure} unsure${counts.skipped ? `, ${counts.skipped} skipped (unchanged)` : ""}`,
  );
  if (counts.fail > 0) lines.push("fail blocks CI");
  if (counts.unsure > 0) {
    lines.push(unsureBlocks ? "unsure blocks CI" : "unsure warns and does not block CI");
  }
  return `${lines.join("\n")}\n`;
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
