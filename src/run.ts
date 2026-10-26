import fs from "node:fs";
import path from "node:path";

import { withRateLimitBackoff } from "./backoff.js";
import { cacheKey, loadCache, saveCache, type CacheHit } from "./cache.js";
import { chunkClosure, evidenceForChunks, type CodeChunk } from "./chunk.js";
import { loadConfig, requireModels } from "./config.js";
import { collectClosure, computeSurfaceClosure, hashClosure, type ClosureFile } from "./closure.js";
import { discoverSurfaces, filterSurfaces, type Surface } from "./discover.js";
import { affectsTest, changedFiles, diffPatch, renamedPaths } from "./diff.js";
import { loadEnvFile } from "./env.js";
import { applyEvidenceCheck } from "./evidence.js";
import { readIndex, type FlowRecord, type SurfaceIndex } from "./index-file.js";
import { hashLockfiles } from "./lockfile.js";
import { asRecord, asStringArray, parseModelJson } from "./model-json.js";
import { recordSuggestion } from "./pending.js";
import { mapPool } from "./pool.js";
import { normalizeRel } from "./paths.js";
import { createModelClient } from "./providers.js";
import { formatReport, writeReports, type ReportedTest } from "./reporter.js";
import { listSourceFiles } from "./repo-files.js";
import { readTests, setFrontmatterField } from "./surface.js";
import type { Citation, ModelClient, ModelSource, TyxtestConfig, Verdict } from "./types.js";
import { aggregateVerdicts, EVIDENCE_OPTIONS, exitCodeFor, thresholdVerdict, VERDICT_OPTIONS } from "./verdict.js";

const VERDICT_RANK: Record<Exclude<Verdict, "skipped">, number> = { pass: 0, unsure: 1, fail: 2 };
const TRIAGE_OPTIONS = ["changes", "unchanged"] as const;

export interface RunOutcome {
  exitCode: number;
  results: ReportedTest[];
}

export async function runCommand(options: {
  cwd: string;
  interactive?: boolean;
  surfaces?: string[];
  env?: NodeJS.ProcessEnv;
  config?: TyxtestConfig;
  model?: ModelSource;
  indexModel?: ModelSource;
  escalateModel?: ModelSource;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  verbose?: boolean;
}): Promise<RunOutcome> {
  const config = options.config ?? loadConfig(options.cwd);
  const env = loadEnvFile(options.cwd, options.env ?? process.env);
  const stdout = options.stdout ?? ((message: string) => process.stdout.write(message));
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  const surfaces = discoverSurfaces(options.cwd);
  if (surfaces.length === 0) throw new Error("No tyxtest surfaces found.");
  const selected = filterSurfaces(surfaces, options.surfaces);
  if (selected.length === 0) throw new Error("No matching surfaces.");

  const indexes = new Map<string, SurfaceIndex>();
  for (const surface of surfaces) {
    const file = path.join(surface.dir, ".index.json");
    if (fs.existsSync(file)) indexes.set(surface.relativeDir, readIndex(file));
  }

  const diff = config.ignoreUnchanged ? changedFiles(options.cwd, config.baseRef) : undefined;
  const lockfileHash = hashLockfiles(options.cwd);
  const cacheFile = path.join(options.cwd, ".tyxtest", "verdict-cache.json");
  const cache = loadCache(cacheFile);
  let cacheDirty = false;
  const jobs: Array<() => Promise<ReportedTest>> = [];
  let runner: ModelClient | null = null;
  let searcher: ModelClient | null = null;
  let escalator: ModelClient | null = null;
  const runnerClient = (): ModelClient => {
    if (!runner) {
      runner = resolveModel(options.model, () => createModelClient(requireModels(config).runnerModel, env));
    }
    return runner;
  };
  const indexClient = (): ModelClient => {
    if (!searcher) {
      searcher = resolveModel(options.indexModel ?? options.model, () =>
        createModelClient(requireModels(config).indexModel, env),
      );
    }
    return searcher;
  };
  const escalateClient = (): ModelClient => {
    if (!escalator) {
      if (options.escalateModel) escalator = resolveModel(options.escalateModel, indexClient);
      else if (config.escalateModel) escalator = createModelClient(config.escalateModel, env);
      else escalator = indexClient();
    }
    return escalator;
  };

  for (const surface of selected) {
    const markdown = fs.readFileSync(surface.markdownPath, "utf8");
    const tests = readTests(markdown);
    const index = indexes.get(surface.relativeDir);
    const surfacePath = normalizeRel(path.relative(options.cwd, surface.markdownPath));

    if (!index) {
      if (options.interactive === false && config.nonInteractive === "search") {
        const searched = await searchClosure(indexClient(), options.cwd, surface, markdown);
        for (const test of tests) {
          if (diff && !affectsTest({ changed: diff.files, lockfileChanged: diff.lockfileChanged, closurePaths: searched.files.map((file) => file.path), surfacePath })) {
            jobs.push(async () => skipped(surface, test));
            continue;
          }
          jobs.push(() =>
            judgeTest({
              cwd: options.cwd,
              config,
              env,
              stderr,
              surface,
              test,
              closure: searched,
              hashSource: searched.files,
              symbols: [],
              flows: [],
              runner: runnerClient(),
              escalate: escalateClient(),
              indexModel: indexClient,
              forceUnsure: true,
              cache,
              lockfileHash,
              diffText: "",
              onCacheWrite: () => {
                cacheDirty = true;
              },
            }),
          );
        }
        continue;
      }
      throw new Error(`Surface "${surface.relativeDir}" is not indexed. Run \`tyxtest index\` locally.`);
    }

    const indexedEntry = index.entry[0] ?? surface.entry;
    if (!indexedEntry) {
      throw new Error(`Surface "${surface.relativeDir}" is not indexed. Run \`tyxtest index\` locally.`);
    }
    const entry = resolveMovedEntry({
      cwd: options.cwd,
      surface,
      entry: indexedEntry,
      baseRef: config.baseRef,
      stderr,
    });
    const live = computeSurfaceClosure({
      cwd: options.cwd,
      entry,
      depth: config.closureDepth,
      parentClosure: parentClosure(surface, indexes),
    });
    if (closurePathsDiffer(index.closure, live.files)) {
      stderr(
        `index stale: "${surface.relativeDir}" import closure changed. Run \`tyxtest index\` to refresh it.`,
      );
    }
    const diffText = config.triage
      ? diffPatch(
          options.cwd,
          config.baseRef,
          live.files.map((file) => file.path),
        )
      : "";
    for (const test of tests) {
      const testClosure = closureForTest({
        cwd: options.cwd,
        surface,
        test,
        index,
        live,
        depth: config.closureDepth,
        parentClosure: parentClosure(surface, indexes),
        stderr,
      });
      if (
        diff &&
        !affectsTest({
          changed: diff.files,
          lockfileChanged: diff.lockfileChanged,
          closurePaths: testClosure.files.map((file) => file.path),
          surfacePath,
        })
      ) {
        jobs.push(async () => skipped(surface, test));
        continue;
      }
      jobs.push(() =>
        judgeTest({
          cwd: options.cwd,
          config,
          env,
          stderr,
          surface,
          test,
          closure: testClosure,
          hashSource: index.closure,
          symbols: index.files.flatMap((file) => file.symbols),
          flows: index.flows ?? [],
          runner: runnerClient(),
          escalate: escalateClient(),
          indexModel: indexClient,
          forceUnsure: false,
          cache,
          lockfileHash,
          diffText,
          onCacheWrite: () => {
            cacheDirty = true;
          },
        }),
      );
    }
  }

  const results = await mapPool(jobs, config.concurrency, (job) => job());
  if (cacheDirty) saveCache(cacheFile, cache);
  const report = formatReport(results, config.unsureBlocks, options.verbose === true);
  stdout(report);
  const written = writeReports(path.join(options.cwd, ".tyxtest"), results, config.unsureBlocks);
  stdout(`JSON: ${path.relative(options.cwd, written.json)}\nJUnit: ${path.relative(options.cwd, written.junit)}\n`);
  return { exitCode: exitCodeFor(results.map((result) => result.verdict), config.unsureBlocks), results };
}

async function judgeTest(options: {
  cwd: string;
  config: TyxtestConfig;
  surface: Surface;
  test: { id: string; text: string };
  env: NodeJS.ProcessEnv;
  stderr: (message: string) => void;
  closure: { files: ClosureFile[]; closureHash: string };
  hashSource: Array<{ path: string; hash: string }>;
  symbols: string[];
  flows: FlowRecord[];
  runner: ModelClient;
  escalate: ModelClient;
  indexModel: () => ModelClient;
  forceUnsure: boolean;
  cache: { entries: Record<string, CacheHit> };
  lockfileHash: string;
  diffText: string;
  onCacheWrite: () => void;
}): Promise<ReportedTest> {
  const key = cacheKey({
    testId: options.test.id,
    testText: options.test.text,
    closureHash: options.closure.closureHash,
    lockfileHash: options.lockfileHash,
    optionOrder: VERDICT_OPTIONS,
  });
  const hit = options.cache.entries[key];
  if (!options.forceUnsure && hit && hit.testId === options.test.id && isJudged(hit.verdict)) {
    return {
      surface: options.surface.relativeDir,
      id: options.test.id,
      text: options.test.text,
      verdict: hit.verdict,
      cached: true,
      runs: [hit.verdict],
      evidence: hit.evidence ?? [],
      explanation: hit.explanation ?? "",
    };
  }

  const kind = options.config.runnerModel?.kind ?? "decision";
  if (!options.forceUnsure && options.config.triage && kind === "decision" && options.runner.decide) {
    const previous = Object.values(options.cache.entries).find((entry) => entry.testId === options.test.id && isJudged(entry.verdict));
    if (previous && hit === undefined) {
      const triage = await options.runner.decide({
        purpose: "triage",
        state: `Claim: ${options.test.text}\n\nDiff:\n${options.diffText || "(closure or lockfile changed)"}`,
        options: [...TRIAGE_OPTIONS],
      });
      const pChanges = probabilityOf(triage.probabilities, TRIAGE_OPTIONS, "changes");
      if (pChanges <= options.config.thresholds.fail) {
        options.cache.entries[key] = previous;
        options.onCacheWrite();
        return {
          surface: options.surface.relativeDir,
          id: options.test.id,
          text: options.test.text,
          verdict: previous.verdict,
          cached: true,
          runs: [previous.verdict],
          evidence: previous.evidence,
          explanation: "triage reused the cached verdict",
        };
      }
    }
  }

  const flow = options.flows.find((item) => item.testId === options.test.id);
  const judged =
    flow && flow.steps.length > 0 && kind === "decision"
      ? await judgeFlow(options, flow)
      : kind === "llm"
        ? await judgeWithLlm(options, options.runner)
        : await judgeWithDecision(options);
  let verdict = judged.verdict;
  let explanation = judged.explanation;
  if (judged.indexStale) {
    recordSuggestion({
      cwd: options.cwd,
      env: options.env,
      stderr: options.stderr,
      surface: options.surface.relativeDir,
      testId: options.test.id,
      reason: "index may be stale",
      detail: explanation,
    });
  }
  if (verdict === "fail" && options.config.relocateCheck && !options.forceUnsure && !flow) {
    const relocated = await relocateIfEvidenceGone(options, explanation);
    verdict = relocated.verdict;
    explanation = relocated.explanation;
  }
  if (options.forceUnsure && verdict !== "skipped") verdict = "unsure";
  if (!options.forceUnsure && isJudged(verdict)) {
    options.cache.entries[key] = {
      testId: options.test.id,
      verdict,
      evidence: judged.evidence,
      explanation,
    };
    options.onCacheWrite();
  }
  return {
    surface: judged.surface,
    id: judged.id,
    text: judged.text,
    verdict,
    cached: judged.cached,
    runs: judged.runs,
    evidence: judged.evidence,
    explanation,
  };
}

async function relocateIfEvidenceGone(
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stderr: (message: string) => void;
    surface: Surface;
    test: { id: string; text: string };
    closure: { files: ClosureFile[]; closureHash: string };
    symbols: string[];
    indexModel: () => ModelClient;
  },
  explanation: string,
): Promise<{ verdict: "fail" | "unsure"; explanation: string }> {
  const chunks = chunkClosure(options.cwd, options.closure.files);
  if (!evidenceChunksGone(options.symbols, chunks)) return { verdict: "fail", explanation };
  const response = await withRateLimitBackoff(() => options.indexModel().complete({
    purpose: "relocate",
    system:
      'Indexed evidence for this claim is gone. Reply with JSON only: {"found":true,"path":"relative/file.ts"} when the feature exists outside the indexed closure, or {"found":false}.',
    prompt: [
      `Surface: ${options.surface.name}`,
      `Test [${options.test.id}] ${options.test.text}`,
      `Missing symbols: ${options.symbols.join(", ") || "(none)"}`,
      `Indexed closure:\n${options.closure.files.map((file) => file.path).join("\n") || "(none)"}`,
      `Repository files:\n${listSourceFiles(options.cwd).join("\n") || "(none)"}`,
    ].join("\n\n"),
  }));
  const record = asRecord(parseModelJson(response), "Relocate response");
  if (record.found !== true) return { verdict: "fail", explanation };
  const where = typeof record.path === "string" && record.path.trim() ? normalizeRel(record.path) : "another file";
  const note = `Proposed index update: [${options.test.id}] ${options.test.text} now lives in ${where}.`;
  recordSuggestion({
    cwd: options.cwd,
    env: options.env,
    stderr: options.stderr,
    surface: options.surface.relativeDir,
    testId: options.test.id,
    reason: "index may be stale",
    detail: note,
  });
  return { verdict: "unsure", explanation: note };
}

function evidenceChunksGone(symbols: string[], chunks: Array<{ name: string; symbol?: string }>): boolean {
  if (symbols.length === 0) return false;
  const names = new Set(chunks.flatMap((chunk) => [chunk.name, chunk.symbol ?? ""]));
  return symbols.some((symbol) => symbol.length > 0 && !names.has(symbol));
}

function closurePathsDiffer(indexed: Array<{ path: string }>, live: Array<{ path: string }>): boolean {
  if (indexed.length !== live.length) return true;
  const paths = new Set(live.map((file) => normalizeRel(file.path)));
  return indexed.some((file) => !paths.has(normalizeRel(file.path)));
}

function resolveMovedEntry(options: {
  cwd: string;
  surface: Surface;
  entry: string;
  baseRef: string;
  stderr: (message: string) => void;
}): string {
  const entry = normalizeRel(options.entry);
  if (fs.existsSync(path.join(options.cwd, entry))) return entry;
  const renamed = renamedPaths(options.cwd, options.baseRef).get(entry);
  if (renamed && fs.existsSync(path.join(options.cwd, renamed))) {
    const markdown = fs.readFileSync(options.surface.markdownPath, "utf8");
    const updated = setFrontmatterField(markdown, "entry", renamed);
    fs.writeFileSync(options.surface.markdownPath, updated.endsWith("\n") ? updated : `${updated}\n`);
    options.stderr(`Entry for "${options.surface.relativeDir}" renamed from ${entry} to ${renamed}. Updated entry:.`);
    return renamed;
  }
  throw new Error(
    `Entry ${entry} for surface "${options.surface.relativeDir}" was deleted. Run \`tyxtest index\` to re-index the surface.`,
  );
}

async function judgeWithDecision(options: {
  cwd: string;
  config: TyxtestConfig;
  surface: Surface;
  test: { id: string; text: string };
  closure: { files: ClosureFile[]; closureHash: string };
  hashSource: Array<{ path: string; hash: string }>;
  runner: ModelClient;
  escalate: ModelClient;
}): Promise<ReportedTest & { indexStale?: boolean }> {
  const decide = options.runner.decide?.bind(options.runner);
  if (!decide) throw new Error("The decision runner does not implement decide().");
  const chunks = chunkClosure(options.cwd, options.closure.files, options.config.chunkMaxTokens);
  const verdictAnswer = await withRateLimitBackoff(() =>
    decide({
      purpose: "verdict",
      state: renderClaim(options.surface, options.test, chunks),
      options: [...VERDICT_OPTIONS],
    }),
  );
  const pPass = probabilityOf(verdictAnswer.probabilities, VERDICT_OPTIONS, "pass");
  const band = thresholdVerdict(pPass, options.config.thresholds);
  if (band === "between") {
    if (!options.config.escalate) {
      return resultOf(options, "unsure", [], [`unsure`], `p(pass)=${pPass} is between the thresholds.`);
    }
    return judgeWithLlm(options, options.escalate);
  }
  const scores = await mapPool(chunks, options.config.concurrency, async (chunk) => {
    const answer = await withRateLimitBackoff(() =>
      decide({
        purpose: "evidence",
        state: `Claim: ${options.test.text}\n\nChunk ${chunk.path}:${chunk.line} ${chunk.name}\n${chunk.text}`,
        options: [...EVIDENCE_OPTIONS],
      }),
    );
    return probabilityOf(answer.probabilities, EVIDENCE_OPTIONS, "yes");
  });
  return resultOf(options, band, evidenceForChunks(chunks, scores), [band], `p(pass)=${pPass}`);
}

async function judgeWithLlm(
  options: {
    cwd: string;
    config: TyxtestConfig;
    surface: Surface;
    test: { id: string; text: string };
    closure: { files: ClosureFile[]; closureHash: string };
    hashSource: Array<{ path: string; hash: string }>;
  },
  model: ModelClient,
): Promise<ReportedTest & { indexStale?: boolean }> {
  const contents = readClosureContents(options.cwd, options.closure.files);
  const bundle = options.closure.files
    .map((file) => `===== ${file.path} =====\n${contents[file.path] ?? ""}`)
    .join("\n");
  const attempts: Array<"pass" | "fail" | "unsure"> = [];
  let evidence: Citation[] = [];
  let explanation = "";
  let worst: "pass" | "fail" | "unsure" = "pass";
  let indexStale = false;
  const total = 1 + options.config.reruns;
  for (let attempt = 0; attempt < total; attempt += 1) {
    const response = await withRateLimitBackoff(() =>
      model.complete({
        purpose: "run",
        system: [
          "You check one product claim against the source that was provided.",
          'Reply with JSON only: {"verdict":"pass|fail|unsure","evidence":[{"file":"relative/path.tsx","line":1}],"explanation":"...","notes":[],"indexStale":false}.',
          "Set indexStale to true only when the index looks wrong or incomplete for this test. Do not rewrite the index.",
          "A pass must cite at least one file:line that exists in the provided source.",
        ].join(" "),
        prompt: [
          `Surface: ${options.surface.name}`,
          options.surface.description ? `Description: ${options.surface.description}` : "",
          `Test [${options.test.id}] ${options.test.text}`,
          "Code:",
          bundle || "(no code)",
        ]
          .filter(Boolean)
          .join("\n\n"),
      }),
    );
    const judged = parseJudge(response);
    const adjusted = applyEvidenceCheck(judged.verdict, judged.evidence, options.hashSource, contents);
    attempts.push(adjusted);
    if (judged.indexStale) indexStale = true;
    if (VERDICT_RANK[adjusted] >= VERDICT_RANK[worst] || attempt === 0) {
      worst = adjusted;
      evidence = judged.evidence;
      explanation = judged.explanation;
    }
    if (attempt === 0 && adjusted === "pass") break;
  }
  return {
    ...resultOf(options, aggregateVerdicts(attempts, options.config.verdictRule), evidence, attempts, explanation),
    indexStale,
  };
}

function resultOf(
  options: { surface: Surface; test: { id: string; text: string } },
  verdict: "pass" | "fail" | "unsure",
  evidence: Citation[],
  runs: Array<"pass" | "fail" | "unsure">,
  explanation: string,
): ReportedTest {
  return {
    surface: options.surface.relativeDir,
    id: options.test.id,
    text: options.test.text,
    verdict,
    cached: false,
    runs,
    evidence,
    explanation,
  };
}

function skipped(surface: Surface, test: { id: string; text: string }): ReportedTest {
  return {
    surface: surface.relativeDir,
    id: test.id,
    text: test.text,
    verdict: "skipped",
    cached: false,
    runs: [],
    evidence: [],
    explanation: "skipped (unchanged)",
  };
}

function renderClaim(surface: Surface, test: { id: string; text: string }, chunks: CodeChunk[]): string {
  const body = chunks.map((chunk) => `===== ${chunk.path}:${chunk.line} ${chunk.name} =====\n${chunk.text}`).join("\n\n");
  return [`Surface: ${surface.name}`, surface.description, `Test [${test.id}] ${test.text}`, body || "(no code)"]
    .filter(Boolean)
    .join("\n\n");
}

export function probabilityOf(probabilities: number[], options: readonly string[], name: string): number {
  const index = options.indexOf(name);
  if (index < 0 || probabilities.length !== options.length || typeof probabilities[index] !== "number") {
    throw new Error(`Decision model did not return p(${name}) for options ${options.join(", ")}.`);
  }
  return probabilities[index];
}

async function searchClosure(
  model: ModelClient,
  cwd: string,
  surface: Surface,
  markdown: string,
): Promise<{ files: ClosureFile[]; closureHash: string }> {
  const listing = listSourceFiles(cwd);
  const response = await model.complete({
    purpose: "search",
    system: 'Reply with JSON only: {"files":["relative/file.tsx"]}. Pick existing files that implement the surface.',
    prompt: `Surface: ${surface.name}\n\n${markdown}\n\nFiles:\n${listing.join("\n")}`,
  });
  const record = asRecord(parseModelJson(response), "Search response");
  const picked = asStringArray(record.files)
    .map((file) => normalizeRel(file))
    .filter((file) => file.length > 0 && !file.split("/").includes("node_modules") && fs.existsSync(path.join(cwd, file)));
  if (picked.length === 0) {
    throw new Error(`Search found no files for "${surface.relativeDir}". Run \`tyxtest index\` locally.`);
  }
  return collectClosure({ cwd, entries: picked, depth: null });
}

function parentClosure(surface: Surface, indexes: Map<string, SurfaceIndex>): Array<{ path: string }> | null {
  if (!surface.parentRelativeDir) return null;
  const parent = indexes.get(surface.parentRelativeDir);
  if (!parent) {
    throw new Error(`Parent surface "${surface.parentRelativeDir}" is not indexed. Run \`tyxtest index\` locally.`);
  }
  return parent.closure;
}

function readClosureContents(cwd: string, files: ClosureFile[]): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const file of files) {
    const absolute = path.join(cwd, file.path);
    if (!fs.existsSync(absolute)) continue;
    contents[file.path] = fs.readFileSync(absolute, "utf8");
  }
  return contents;
}

function parseJudge(text: string): {
  verdict: "pass" | "fail" | "unsure";
  evidence: Citation[];
  explanation: string;
  notes: string[];
  indexStale: boolean;
} {
  const record = asRecord(parseModelJson(text), "Verdict");
  const verdict = record.verdict === "pass" || record.verdict === "fail" || record.verdict === "unsure" ? record.verdict : "unsure";
  const evidence: Citation[] = [];
  if (Array.isArray(record.evidence)) {
    for (const item of record.evidence) {
      if (!item || typeof item !== "object") continue;
      const citation = item as Record<string, unknown>;
      if (typeof citation.file !== "string" || typeof citation.line !== "number") continue;
      evidence.push({ file: normalizeRel(citation.file), line: citation.line });
    }
  }
  return {
    verdict,
    evidence,
    explanation: typeof record.explanation === "string" ? record.explanation : "",
    notes: asStringArray(record.notes),
    indexStale: record.indexStale === true,
  };
}

export function atMostBound(text: string): number | null {
  const match = /\bat most\s+(\d+)\b/i.exec(text);
  if (!match) return null;
  return Number(match[1]);
}

function closureForTest(options: {
  cwd: string;
  surface: Surface;
  test: { id: string };
  index: SurfaceIndex;
  live: { files: ClosureFile[]; closureHash: string };
  depth: number | null;
  parentClosure: Array<{ path: string }> | null;
  stderr: (message: string) => void;
}): { files: ClosureFile[]; closureHash: string } {
  const flow = (options.index.flows ?? []).find((item) => item.testId === options.test.id);
  if (!flow || flow.steps.length === 0) return options.live;
  const parts = [];
  for (const step of flow.steps) {
    if (!fs.existsSync(path.join(options.cwd, step.entry))) continue;
    try {
      parts.push(
        computeSurfaceClosure({
          cwd: options.cwd,
          entry: step.entry,
          depth: options.depth,
          parentClosure: options.parentClosure,
        }),
      );
    } catch {
      continue;
    }
  }
  if (parts.length === 0) return options.live;
  const union = unionClosures(parts);
  const baseline = flow.closure.length > 0 ? flow.closure : options.index.closure;
  if (closurePathsDiffer(baseline, union.files)) {
    options.stderr(
      `index stale: "${options.surface.relativeDir}" import closure changed. Run \`tyxtest index\` to refresh it.`,
    );
  }
  return union;
}

function unionClosures(parts: Array<{ files: ClosureFile[] }>): { files: ClosureFile[]; closureHash: string } {
  const byPath = new Map<string, ClosureFile>();
  for (const part of parts) {
    for (const file of part.files) byPath.set(file.path, file);
  }
  const files = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  return { files, closureHash: hashClosure(files) };
}

async function judgeFlow(
  options: {
    cwd: string;
    config: TyxtestConfig;
    env: NodeJS.ProcessEnv;
    stderr: (message: string) => void;
    surface: Surface;
    test: { id: string; text: string };
    closure: { files: ClosureFile[]; closureHash: string };
    hashSource: Array<{ path: string; hash: string }>;
    runner: ModelClient;
    escalate: ModelClient;
    indexModel: () => ModelClient;
  },
  flow: FlowRecord,
): Promise<ReportedTest & { indexStale?: boolean }> {
  const bound = atMostBound(options.test.text);
  if (bound !== null && flow.steps.length > bound) {
    return resultOf(
      options,
      "fail",
      [],
      ["fail"],
      `path has ${flow.steps.length} steps; at most ${bound} is checked as path length.`,
    );
  }
  const decide = options.runner.decide?.bind(options.runner);
  if (!decide) throw new Error("The decision runner does not implement decide().");
  const stepVerdicts: Array<"pass" | "fail" | "unsure"> = [];
  const evidence: Citation[] = [];
  let indexStale = false;
  for (const step of flow.steps) {
    const stepClosure = fs.existsSync(path.join(options.cwd, step.entry))
      ? computeSurfaceClosure({
          cwd: options.cwd,
          entry: step.entry,
          depth: options.config.closureDepth,
          parentClosure: null,
        })
      : { files: [], closureHash: "" };
    const chunks = chunkClosure(options.cwd, stepClosure.files, options.config.chunkMaxTokens);
    const answer = await withRateLimitBackoff(() =>
      decide({
        purpose: "verdict",
        state: [`Step [${step.id}] ${step.text}`, renderClaim(options.surface, { id: step.id, text: step.text }, chunks)]
          .join("\n\n"),
        options: [...VERDICT_OPTIONS],
      }),
    );
    const band = thresholdVerdict(probabilityOf(answer.probabilities, VERDICT_OPTIONS, "pass"), options.config.thresholds);
    if (band === "between") {
      if (!options.config.escalate) {
        stepVerdicts.push("unsure");
        continue;
      }
      const escalated = await judgeWithLlm(
        { ...options, test: { id: step.id, text: step.text }, closure: stepClosure },
        options.escalate,
      );
      stepVerdicts.push(escalated.verdict === "skipped" ? "unsure" : escalated.verdict);
      evidence.push(...escalated.evidence);
      if (escalated.indexStale) indexStale = true;
      continue;
    }
    stepVerdicts.push(band);
    const scores = await mapPool(chunks, options.config.concurrency, async (chunk) => {
      const scored = await withRateLimitBackoff(() =>
        decide({
          purpose: "evidence",
          state: `Claim: ${step.text}\n\nChunk ${chunk.path}:${chunk.line} ${chunk.name}\n${chunk.text}`,
          options: [...EVIDENCE_OPTIONS],
        }),
      );
      return probabilityOf(scored.probabilities, EVIDENCE_OPTIONS, "yes");
    });
    evidence.push(...evidenceForChunks(chunks, scores));
  }
  if (stepVerdicts.some((verdict) => verdict === "fail") && options.config.relocateCheck) {
    const response = await withRateLimitBackoff(() =>
      options.indexModel().complete({
        purpose: "relocate",
        system:
          'A flow step failed. Reply with JSON only: {"found":true,"path":"relative/file.ts"} if the path moved, or {"found":false}.',
        prompt: `Test [${options.test.id}] ${options.test.text}\nSteps:\n${flow.steps
          .map((step) => `${step.id}: ${step.text} (${step.entry})`)
          .join("\n")}`,
      }),
    );
    const record = asRecord(parseModelJson(response), "Relocate response");
    if (record.found === true) {
      const where = typeof record.path === "string" && record.path.trim() ? normalizeRel(record.path) : "another file";
      return {
        ...resultOf(
          options,
          "unsure",
          evidence,
          stepVerdicts,
          `Proposed index update: [${options.test.id}] ${options.test.text} now lives in ${where}.`,
        ),
        indexStale: true,
      };
    }
  }
  if (stepVerdicts.some((verdict) => verdict === "fail")) {
    return resultOf(options, "fail", evidence, stepVerdicts, "a flow step failed");
  }
  if (stepVerdicts.some((verdict) => verdict === "unsure") || indexStale) {
    return { ...resultOf(options, "unsure", evidence, stepVerdicts, "a flow step is unsure"), indexStale };
  }
  return { ...resultOf(options, "pass", evidence, stepVerdicts, ""), indexStale };
}

function isJudged(value: unknown): value is "pass" | "fail" | "unsure" {
  return value === "pass" || value === "fail" || value === "unsure";
}

function resolveModel(source: ModelSource | undefined, fallback: () => ModelClient): ModelClient {
  if (!source) return fallback();
  return typeof source === "function" ? source() : source;
}
