import fs from "node:fs";
import path from "node:path";

import { withRateLimitBackoff } from "../model/backoff.js";
import { cacheKey, loadCache, saveCache, type CacheHit } from "../verdict/cache.js";
import { chunkClosure, evidenceForChunks, selectChunks, type CodeChunk } from "../closure/chunk.js";
import { loadConfig, requireModels } from "../config/config.js";
import { collectClosure, computeSurfaceClosure, hashClosure, type ClosureFile } from "../closure/closure.js";
import { discoverSurfaces, filterSurfaces, type Surface } from "../surface/discover.js";
import { affectsTest, changedFiles, diffPatch, renamedPaths } from "../verdict/diff.js";
import { loadEnvFile } from "../config/env.js";
import { applyEvidenceCheck } from "../verdict/evidence.js";
import { readIndex, type FlowRecord, type IndexedChunk, type SurfaceIndex } from "../surface/index-file.js";
import { hashLockfiles } from "../verdict/lockfile.js";
import { asRecord, asStringArray, parseModelJson } from "../model/model-json.js";
import { recordSuggestion } from "../surface/pending.js";
import { mapPool } from "../util/pool.js";
import { normalizeRel } from "../util/paths.js";
import { createModelClient } from "../model/providers.js";
import { createRunProgress, type ProgressSink } from "../verdict/progress.js";
import { formatReport, writeReports, type ReportedTest } from "../verdict/reporter.js";
import { listSourceFiles } from "../closure/repo-files.js";
import { readTests, setFrontmatterField } from "../surface/surface.js";
import type { Citation, DecisionAnswer, DecisionRequest, ModelClient, ModelConfig, ModelSource, TyxtestConfig, Verdict } from "../config/types.js";
import { aggregateVerdicts, EVIDENCE_OPTIONS, exitCodeFor, thresholdVerdict, VERDICT_OPTIONS } from "../verdict/verdict.js";

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
  /** Live ordered status lines. Set for an interactive terminal. */
  live?: boolean;
  progressSink?: ProgressSink;
  showCached?: boolean;
  /** Judge every test. Skips the unchanged filter and the verdict cache. */
  all?: boolean;
}): Promise<RunOutcome> {
  const config = options.config ?? loadConfig(options.cwd);
  const env = loadEnvFile(options.cwd, options.env ?? process.env);
  const stdout = options.stdout ?? ((message: string) => process.stdout.write(message));
  const baseStderr = options.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  let progress: ReturnType<typeof createRunProgress> | null = null;
  const stderr = (message: string) => {
    if (progress) progress.note(message);
    else baseStderr(message);
  };
  const surfaces = discoverSurfaces(options.cwd);
  if (surfaces.length === 0) throw new Error("No tyxtest surfaces found.");
  const selected = filterSurfaces(surfaces, options.surfaces);
  if (selected.length === 0) throw new Error("No matching surfaces.");

  const indexes = new Map<string, SurfaceIndex>();
  for (const surface of surfaces) {
    const file = path.join(surface.dir, ".index.json");
    if (fs.existsSync(file)) indexes.set(surface.relativeDir, readIndex(file));
  }

  const diff = options.all || !config.ignoreUnchanged ? undefined : changedFiles(options.cwd, config.baseRef);
  const lockfileHash = hashLockfiles(options.cwd);
  const cacheFile = path.join(options.cwd, ".tyxtest", "verdict-cache.json");
  const cache = loadCache(cacheFile);
  let cacheDirty = false;
  const showCached = options.showCached === true || config.showCached;
  const jobs: Array<{ surface: string; id: string; text: string; cacheHit: boolean; run: () => Promise<ReportedTest> }> = [];
  const cacheHitFor = (
    test: { id: string; text: string },
    closureHash: string,
    chunkIds: string[],
    forceUnsure: boolean,
  ): boolean => {
    if (options.all || forceUnsure) return false;
    const key = cacheKey({
      testId: test.id,
      testText: test.text,
      closureHash,
      lockfileHash,
      optionOrder: VERDICT_OPTIONS,
      chunkIds,
    });
    const hit = cache.entries[key];
    return Boolean(hit && hit.testId === test.id && isJudged(hit.verdict));
  };
  let runner: ModelClient | null = null;
  let searcher: ModelClient | null = null;
  let escalator: ModelClient | null = null;
  const fallbackLabel =
    modelLabel(config.escalateModel) ?? modelLabel(config.indexModel) ?? "the escalation model";
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
            jobs.push({
              surface: surface.relativeDir,
              id: test.id,
              text: test.text,
              cacheHit: false,
              run: async () => skipped(surface, test),
            });
            continue;
          }
          jobs.push({
            surface: surface.relativeDir,
            id: test.id,
            text: test.text,
            cacheHit: cacheHitFor(test, searched.closureHash, [], true),
            run: () =>
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
              chunkRefs: null,
              chunkIds: [],
              runner: runnerClient(),
              escalate: escalateClient(),
              fallback: escalateClient(),
              fallbackLabel,
              indexModel: indexClient,
              forceUnsure: true,
              ignoreCache: options.all === true,
              cache,
              lockfileHash,
              diffText: "",
              onCacheWrite: () => {
                cacheDirty = true;
              },
            }),
          });
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
        jobs.push({
          surface: surface.relativeDir,
          id: test.id,
          text: test.text,
          cacheHit: false,
          run: async () => skipped(surface, test),
        });
        continue;
      }
      jobs.push({
        surface: surface.relativeDir,
        id: test.id,
        text: test.text,
        cacheHit: cacheHitFor(test, testClosure.closureHash, chunkIdsFor(index, test.id), false),
        run: () =>
        judgeTest({
          cwd: options.cwd,
          config,
          env,
          stderr,
          surface,
          test,
          closure: testClosure,
          hashSource: index.closure,
          symbols: chunkSymbols(index, test.id),
          flows: index.flows ?? [],
          chunkRefs: chunkRefsFor(index, test.id),
          chunkIds: chunkIdsFor(index, test.id),
          runner: runnerClient(),
          escalate: escalateClient(),
          fallback: escalateClient(),
          fallbackLabel,
          indexModel: indexClient,
          forceUnsure: false,
          ignoreCache: options.all === true,
          cache,
          lockfileHash,
          diffText,
          onCacheWrite: () => {
            cacheDirty = true;
          },
        }),
      });
    }
  }

  const sink: ProgressSink | null = options.progressSink ?? (options.live ? process.stdout : null);
  if (sink) {
    const color = sink === process.stdout ? process.stdout.hasColors?.() !== false && !process.env.NO_COLOR : true;
    const visible = showCached ? jobs : jobs.filter((job) => !job.cacheHit);
    progress = createRunProgress(sink, visible, { color });
  }
  let results: ReportedTest[];
  try {
    results = await mapPool(jobs, config.concurrency, async (job) => {
      const started = performance.now();
      const result = await job.run();
      progress?.complete(result, performance.now() - started);
      return result;
    });
  } catch (error) {
    progress?.dispose();
    throw error;
  }
  if (cacheDirty) saveCache(cacheFile, cache);
  if (progress) {
    progress.finish(results, { unsureBlocks: config.unsureBlocks, verbose: options.verbose === true });
  } else {
    stdout(formatReport(results, config.unsureBlocks, options.verbose === true, showCached));
  }
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
  /** Null when the surface has no index and the fresh closure is the code under test. */
  chunkRefs: IndexedChunk[] | null;
  chunkIds: string[];
  runner: ModelClient;
  escalate: ModelClient;
  fallback: ModelClient;
  fallbackLabel: string;
  indexModel: () => ModelClient;
  forceUnsure: boolean;
  ignoreCache?: boolean;
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
    chunkIds: options.chunkIds,
  });
  const hit = options.cache.entries[key];
  if (!options.ignoreCache && !options.forceUnsure && hit && hit.testId === options.test.id && isJudged(hit.verdict)) {
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
  if (!options.ignoreCache && !options.forceUnsure && options.config.triage && kind === "decision" && options.runner.decide) {
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
  const flowJudge = Boolean(flow && flow.steps.length > 0 && kind === "decision");
  const codeChunks = flowJudge ? [] : chunksFor(options);
  let judged: ReportedTest & { indexStale?: boolean; fallback?: string };
  if (!flowJudge && options.chunkRefs !== null && codeChunks.length === 0) {
    judged = await judgeMissingChunks(options);
  } else if (flowJudge && flow) {
    judged = await judgeFlow(options, flow);
  } else if (kind === "llm") {
    judged = await judgeWithLlm({ ...options, chunks: codeChunks }, options.runner);
  } else {
    judged = await judgeWithDecision({ ...options, chunks: codeChunks });
  }
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
    ...(judged.fallback ? { fallback: judged.fallback } : {}),
  };
}

async function judgeMissingChunks(options: {
  cwd: string;
  config: TyxtestConfig;
  env: NodeJS.ProcessEnv;
  stderr: (message: string) => void;
  surface: Surface;
  test: { id: string; text: string };
  closure: { files: ClosureFile[]; closureHash: string };
  symbols: string[];
  chunkRefs: IndexedChunk[] | null;
  indexModel: () => ModelClient;
  forceUnsure: boolean;
}): Promise<ReportedTest> {
  if (options.chunkRefs && options.chunkRefs.length > 0 && options.config.relocateCheck && !options.forceUnsure) {
    const relocated = await relocateIfEvidenceGone(options, "indexed chunks for this test are not in the closure.");
    const verdict = relocated.verdict === "fail" ? "fail" : "unsure";
    return resultOf(options, verdict, [], [verdict], relocated.explanation);
  }
  if (options.chunkRefs && options.chunkRefs.length > 0) {
    return resultOf(options, "fail", [], ["fail"], "indexed chunks for this test are not in the closure.");
  }
  return resultOf(options, "unsure", [], ["unsure"], "no chunks indexed for this test. Run `tyxtest index`.");
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
  fallback: ModelClient;
  fallbackLabel: string;
  chunks: CodeChunk[];
}): Promise<ReportedTest & { indexStale?: boolean; fallback?: string }> {
  const chunks = options.chunks;
  const requests: DecisionRequest[] = [
    {
      purpose: "verdict",
      state: renderClaim(options.surface, options.test, chunks),
      options: [...VERDICT_OPTIONS],
    },
  ];
  for (const chunk of chunks) requests.push(evidenceRequest(options.test.text, chunk));
  const attempts: Array<"pass" | "fail" | "unsure"> = [];
  const probabilities: number[] = [];
  let evidence: Citation[] = [];
  let shownRank = -1;
  const total = 1 + options.config.reruns;
  for (let attempt = 0; attempt < total; attempt += 1) {
    let answers: DecisionAnswer[];
    try {
      answers = await askAll(options.runner, requests);
    } catch (error) {
      if (!options.config.fallback) throw error;
      const llm = await judgeWithLlm(options, options.fallback);
      return { ...llm, fallback: options.fallbackLabel };
    }
    const pPass = probabilityOf(answers[0]?.probabilities ?? [], VERDICT_OPTIONS, "pass");
    const band = thresholdVerdict(pPass, options.config.thresholds);
    probabilities.push(pPass);
    if (band === "between") {
      attempts.push("unsure");
    } else {
      attempts.push(band);
      const scores = chunks.map((_, index) =>
        probabilityOf(answers[index + 1]?.probabilities ?? [], EVIDENCE_OPTIONS, "yes"),
      );
      if (VERDICT_RANK[band] >= shownRank) {
        shownRank = VERDICT_RANK[band];
        evidence = evidenceForChunks(chunks, scores);
      }
    }
    if (band === "pass") break;
  }
  const combined = aggregateVerdicts(attempts, options.config.verdictRule);
  if (combined === "unsure") {
    if (!options.config.escalate) {
      const betweenOnly = attempts.every((item) => item === "unsure");
      return resultOf(
        options,
        "unsure",
        betweenOnly ? [] : evidence,
        attempts,
        betweenOnly
          ? `p(pass)=${probabilities.join(", ")} is between the thresholds.`
          : `p(pass)=${probabilities.join(", ")}`,
      );
    }
    return judgeWithLlm(options, options.escalate);
  }
  return resultOf(options, combined, evidence, attempts, `p(pass)=${probabilities.join(", ")}`);
}

async function askAll(runner: ModelClient, requests: DecisionRequest[]): Promise<DecisionAnswer[]> {
  if (requests.length === 0) return [];
  return withRateLimitBackoff(async () => {
    if (runner.decideMany) return runner.decideMany(requests);
    const decide = runner.decide?.bind(runner);
    if (!decide) throw new Error("The decision runner does not implement decide().");
    const answers: DecisionAnswer[] = [];
    for (const request of requests) answers.push(await decide(request));
    return answers;
  });
}

function evidenceRequest(claim: string, chunk: CodeChunk): DecisionRequest {
  return {
    purpose: "evidence",
    state: `Claim: ${claim}\n\nChunk ${chunk.path}:${chunk.line} ${chunk.name}\n${chunk.text}`,
    options: [...EVIDENCE_OPTIONS],
  };
}

async function judgeWithLlm(
  options: {
    cwd: string;
    config: TyxtestConfig;
    surface: Surface;
    test: { id: string; text: string };
    closure: { files: ClosureFile[]; closureHash: string };
    hashSource: Array<{ path: string; hash: string }>;
    chunks?: CodeChunk[];
  },
  model: ModelClient,
): Promise<ReportedTest & { indexStale?: boolean }> {
  const contents = readClosureContents(options.cwd, options.closure.files);
  const bundle =
    options.chunks !== undefined
      ? options.chunks.map((chunk) => `===== ${chunk.path}:${chunk.line} ${chunk.name} =====\n${chunk.text}`).join("\n\n")
      : options.closure.files.map((file) => `===== ${file.path} =====\n${contents[file.path] ?? ""}`).join("\n");
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
  return {
    ...resultOf(options, adjusted, judged.evidence, [adjusted], judged.explanation),
    indexStale: judged.indexStale,
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
    fallback: ModelClient;
    fallbackLabel: string;
    indexModel: () => ModelClient;
  },
  flow: FlowRecord,
): Promise<ReportedTest & { indexStale?: boolean; fallback?: string }> {
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
  const stepVerdicts: Array<"pass" | "fail" | "unsure"> = [];
  const evidence: Citation[] = [];
  let indexStale = false;
  const requests: DecisionRequest[] = [];
  const plans: Array<{
    step: FlowRecord["steps"][number];
    closure: { files: ClosureFile[]; closureHash: string };
    chunks: CodeChunk[];
    verdictIndex: number;
    missing: boolean;
  }> = [];
  for (const step of flow.steps) {
    const refs = locateChunks(options.cwd, options.config.baseRef, step.chunks ?? []);
    const files = [...new Map(refs.map((ref) => [ref.path, { path: ref.path }])).values()];
    const chunks = selectChunks(chunkClosure(options.cwd, files, options.config.chunkMaxTokens), refs);
    const stepClosure = fs.existsSync(path.join(options.cwd, step.entry))
      ? computeSurfaceClosure({
          cwd: options.cwd,
          entry: step.entry,
          depth: options.config.closureDepth,
          parentClosure: null,
        })
      : { files: [], closureHash: "" };
    if (chunks.length === 0) {
      plans.push({ step, closure: stepClosure, chunks, verdictIndex: -1, missing: true });
      continue;
    }
    const verdictIndex = requests.length;
    requests.push({
      purpose: "verdict",
      state: [`Step [${step.id}] ${step.text}`, renderClaim(options.surface, { id: step.id, text: step.text }, chunks)].join(
        "\n\n",
      ),
      options: [...VERDICT_OPTIONS],
    });
    for (const chunk of chunks) requests.push(evidenceRequest(step.text, chunk));
    plans.push({ step, closure: stepClosure, chunks, verdictIndex, missing: false });
  }
  if (requests.length === 0) {
    return resultOf(
      options,
      "unsure",
      [],
      flow.steps.map(() => "unsure"),
      "no chunks indexed for this test. Run `tyxtest index`.",
    );
  }
  let answers: DecisionAnswer[];
  try {
    answers = await askAll(options.runner, requests);
  } catch (error) {
    if (!options.config.fallback) throw error;
    const llm = await judgeWithLlm(
      { ...options, chunks: plans.flatMap((plan) => plan.chunks) },
      options.fallback,
    );
    return { ...llm, fallback: options.fallbackLabel };
  }
  for (const plan of plans) {
    if (plan.missing) {
      stepVerdicts.push("unsure");
      continue;
    }
    const band = thresholdVerdict(
      probabilityOf(answers[plan.verdictIndex]?.probabilities ?? [], VERDICT_OPTIONS, "pass"),
      options.config.thresholds,
    );
    if (band === "between") {
      if (!options.config.escalate) {
        stepVerdicts.push("unsure");
        continue;
      }
      const escalated = await judgeWithLlm(
        { ...options, test: { id: plan.step.id, text: plan.step.text }, closure: plan.closure, chunks: plan.chunks },
        options.escalate,
      );
      stepVerdicts.push(escalated.verdict === "skipped" ? "unsure" : escalated.verdict);
      evidence.push(...escalated.evidence);
      if (escalated.indexStale) indexStale = true;
      continue;
    }
    stepVerdicts.push(band);
    const scores = plan.chunks.map((_, index) =>
      probabilityOf(answers[plan.verdictIndex + 1 + index]?.probabilities ?? [], EVIDENCE_OPTIONS, "yes"),
    );
    evidence.push(...evidenceForChunks(plan.chunks, scores));
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

function modelLabel(model: ModelConfig | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.provider}/${model.model}`;
}

function chunkRefsFor(index: SurfaceIndex, testId: string): IndexedChunk[] {
  return index.tests?.find((test) => test.testId === testId)?.chunks ?? [];
}

function chunkSymbols(index: SurfaceIndex, testId: string): string[] {
  const flow = index.flows?.find((item) => item.testId === testId);
  if (flow && flow.steps.length > 0) return flow.steps.flatMap((step) => step.chunks.map((chunk) => chunk.symbol));
  return chunkRefsFor(index, testId).map((chunk) => chunk.symbol);
}

function chunkIdsFor(index: SurfaceIndex, testId: string): string[] {
  const flow = index.flows?.find((item) => item.testId === testId);
  if (flow && flow.steps.length > 0) {
    return flow.steps.flatMap((step) => step.chunks.map((chunk) => `${step.id}\0${chunk.path}#${chunk.symbol}`));
  }
  return chunkRefsFor(index, testId).map((chunk) => `${chunk.path}#${chunk.symbol}`);
}

function locateChunks(cwd: string, baseRef: string, refs: IndexedChunk[]): IndexedChunk[] {
  let renamed: Map<string, string> | null = null;
  return refs.map((ref) => {
    const pathName = normalizeRel(ref.path);
    if (fs.existsSync(path.join(cwd, pathName))) return { path: pathName, symbol: ref.symbol };
    renamed ??= renamedPaths(cwd, baseRef);
    const next = renamed.get(pathName);
    if (next && fs.existsSync(path.join(cwd, next))) return { path: next, symbol: ref.symbol };
    return { path: pathName, symbol: ref.symbol };
  });
}

function chunksFor(options: {
  cwd: string;
  config: TyxtestConfig;
  closure: { files: Array<{ path: string }> };
  chunkRefs: IndexedChunk[] | null;
}): CodeChunk[] {
  if (options.chunkRefs === null) {
    return chunkClosure(options.cwd, options.closure.files, options.config.chunkMaxTokens);
  }
  const refs = locateChunks(options.cwd, options.config.baseRef, options.chunkRefs);
  const files = [...new Map(refs.map((ref) => [ref.path, { path: ref.path }])).values()];
  return selectChunks(chunkClosure(options.cwd, files, options.config.chunkMaxTokens), refs);
}

function isJudged(value: unknown): value is "pass" | "fail" | "unsure" {
  return value === "pass" || value === "fail" || value === "unsure";
}

function resolveModel(source: ModelSource | undefined, fallback: () => ModelClient): ModelClient {
  if (!source) return fallback();
  return typeof source === "function" ? source() : source;
}
