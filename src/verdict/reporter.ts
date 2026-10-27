import { writeText } from "../util/fs-util.js";
import type { Citation, Verdict } from "../config/types.js";
import type { ModelUsage } from "../config/types.js";

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
  fallbackReason?: string;
  runnerUsage?: ModelUsage;
  fallbackUsage?: ModelUsage;
}

export interface SurfaceTitle { key: string; name: string }
interface SurfaceNode { name: string; tests?: ReportedTest[]; children: Map<string, SurfaceNode> }

export function aggregateFindings(results: ReportedTest[], verbose: boolean): string[] {
  const lines: string[] = [];
  for (const result of results) {
    if (result.verdict !== "fail" && result.verdict !== "unsure" && !(verbose && result.verdict === "pass")) continue;
    if (result.verdict === "pass" && result.evidence.length === 0 && !result.explanation) continue;
    lines.push(`${result.verdict}  ${result.surface}: ${result.text}`);
    for (const citation of result.evidence) lines.push(`  ${citation.file}:${citation.line}`);
    if (result.explanation) lines.push(`  ${result.explanation}`);
    lines.push("");
  }
  return lines;
}

export function summaryLines(results: ReportedTest[], unsureBlocks: boolean, options: { elapsedMs?: number; runnerUsage?: ModelUsage; fallbackUsage?: ModelUsage; color?: boolean } = {}): string[] {
  const counts = countVerdicts(results);
  const color = (code: string, text: string) => options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const colored = `${color("32", String(counts.pass))} pass, ${color("31", String(counts.fail))} fail, ${color("33", String(counts.unsure))} unsure`;
  const lines = [
    `${colored}${counts.skipped ? `, ${counts.skipped} skipped (unchanged)` : ""}${options.elapsedMs === undefined ? "" : ` ${color("34", `[${formatElapsed(options.elapsedMs)}]`)}`}`,
  ];
  if (options.runnerUsage) lines.push(`runner tokens: ${usageText(options.runnerUsage)}`);
  if (options.fallbackUsage) lines.push(`fallback-model tokens: ${usageText(options.fallbackUsage)}`);
  if (counts.fail > 0) lines.push("fail blocks CI");
  if (counts.unsure > 0 && unsureBlocks) lines.push("unsure blocks CI");
  return lines;
}

export function fallbackLines(results: ReportedTest[]): string[] {
  const labels = results.flatMap((result) => (result.fallback ? [result.fallback] : []));
  if (labels.length === 0) return [];
  const models = [...new Set(labels)];
  const noun = labels.length === 1 ? "1 test fell back" : `${labels.length} tests fell back`;
  const reasons = [...new Set(results.flatMap((result) => result.fallbackReason ? [result.fallbackReason] : []))];
  return [`${noun} to ${models.join(", ")} after the decision API failed`, ...reasons.map((reason) => `  ${reason}`)];
}

export function formatReport(
  results: ReportedTest[],
  unsureBlocks: boolean,
  verbose = false,
  showCached = false,
  titles: Map<string, string> = new Map(),
  totals: { elapsedMs?: number; runnerUsage?: ModelUsage; fallbackUsage?: ModelUsage } = {},
  color = false,
): string {
  const lines: string[] = [];
  const groups = new Map<string, ReportedTest[]>();
  for (const result of results) {
    if (!showCached && result.cached) continue;
    const group = groups.get(result.surface) ?? [];
    group.push(result);
    groups.set(result.surface, group);
  }
  const tree = new Map<string, SurfaceNode>();
  const visiblePaths = new Set<string>();
  for (const key of groups.keys()) {
    const parts = key.split("/");
    for (let length = 1; length <= parts.length; length += 1) visiblePaths.add(parts.slice(0, length).join("/"));
  }
  for (const [key, name] of titles) {
    if (visiblePaths.has(key)) ensureSurfaceNode(tree, key, name);
  }
  for (const [key, tests] of groups) ensureSurfaceNode(tree, key, titles.get(key) ?? key.split("/").at(-1) ?? key).tests = tests;
  const render = (nodes: Map<string, SurfaceNode>, depth: number): void => {
    for (const node of nodes.values()) {
      lines.push(`${"  ".repeat(depth)}${node.name}/`);
      for (const test of node.tests ?? []) {
        lines.push(`${"  ".repeat(depth + 1)}- ${test.verdict === "skipped" ? "skipped (unchanged)" : `${test.verdict}${test.cached ? " (cached)" : ""}`} ${test.text}`);
      }
      render(node.children, depth + 1);
    }
  };
  render(tree, 0);
  if (lines.length) lines.push("");
  lines.push(...summaryLines(results, unsureBlocks, { ...totals, color }));
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

function ensureSurfaceNode(tree: Map<string, SurfaceNode>, key: string, name: string): SurfaceNode {
  let nodes = tree;
  let node;
  const parts = key.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    node = nodes.get(part);
    if (!node) {
      node = { name: name && index === parts.length - 1 ? name : part, children: new Map() };
      nodes.set(part, node);
    }
    nodes = node!.children;
  }
  return node!;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function usageText(usage: ModelUsage): string {
  return usage.available ? `${usage.inputTokens} input, ${usage.outputTokens} output, ${usage.inputTokens + usage.outputTokens} total` : "unavailable";
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
