import fs from "node:fs";
import path from "node:path";

import { withRateLimitBackoff } from "../model/backoff.js";
import { cacheKey, judgmentContextFingerprint, loadCache, saveCache, type CacheHit } from "../verdict/cache.js";
import { chunkClosure, evidenceForChunks, type CodeChunk } from "../closure/chunk.js";
import { collectIndexedEvidence, type EvidenceContext } from "../closure/indexed-evidence.js";
import { loadConfig, requireModels } from "../config/config.js";
import { discoverSurfaces, filterSurfaces, surfaceContextFor, type Surface } from "../surface/discover.js";
import { affectsTest, changedFiles, renamedPaths } from "../verdict/diff.js";
import { loadEnvFile } from "../config/env.js";
import { claimHashFor, readIndexes, type FlowRecord, type IndexedChunk, type IndexedTest, type SurfaceIndex } from "../surface/index-file.js";
import { hashLockfiles } from "../verdict/lockfile.js";
import { asRecord, asStringArray, parseModelJson } from "../model/model-json.js";
import { recordSuggestion } from "../surface/pending.js";
import { mapPool } from "../util/pool.js";
import { normalizeRel } from "../util/paths.js";
import { createModelClient } from "../model/providers.js";
import { createRunProgress, type ProgressSink } from "../verdict/progress.js";
import { formatReport, writeReports, type ReportedTest } from "../verdict/reporter.js";
import { listSourceFiles } from "../closure/repo-files.js";
import { readTests } from "../surface/surface.js";
import type { Citation, DecisionAnswer, DecisionRequest, DecisionScope, ModelClient, ModelConfig, ModelSource, ModelUsage, TyxtestConfig, Verdict } from "../config/types.js";
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
  const startedAt = performance.now();
  const config = options.config ?? loadConfig(options.cwd);
  const env = loadEnvFile(options.cwd, options.env ?? process.env);
  const stdout = options.stdout ?? ((message: string) => process.stdout.write(message));
  const baseStderr = options.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  let progress: ReturnType<typeof createRunProgress> | null = null;
  const stderr = (message: string) => {
    if (progress) progress.note(message);
    else baseStderr(message);
  };
  const surfaces = discoverSurfaces(options.cwd, config.markdown);
  if (surfaces.length === 0) throw new Error("No tyxtest surfaces found.");
  const selected = filterSurfaces(surfaces, options.surfaces);
  if (selected.length === 0) throw new Error("No matching surfaces.");

  const indexes = readIndexes(options.cwd);
  const titles = new Map(surfaces.map((surface) => [surface.relativeDir, surface.name]));
  const semanticContexts = new Map(surfaces.map((surface) => [surface.relativeDir, surfaceContextFor(surface, surfaces, config.markdown)]));

  const diff = options.all || !config.ignoreUnchanged ? undefined : changedFiles(options.cwd, config.baseRef);
  const lockfileHash = hashLockfiles(options.cwd);
  const cacheFile = path.join(options.cwd, ".tyxtest", "verdict-cache.json");
  const cache = loadCache(cacheFile);
  let cacheDirty = false;
  const showCached = options.showCached === true || config.showCached;
  const jobs: Array<{ surface: string; id: string; text: string; notes?: string; cacheHit: boolean; run: () => Promise<ReportedTest> }> = [];
  const cacheHitFor = (
    test: { id: string; text: string; notes?: string },
    closureHash: string,
    chunkIds: string[],
    judgmentContext: string,
  ): boolean => {
    if (options.all) return false;
    const key = cacheKey({
      testId: test.id,
      testText: `${test.text}\n${test.notes ?? ""}`,
      closureHash,
      lockfileHash,
      optionOrder: VERDICT_OPTIONS,
      chunkIds,
      judgmentContext,
    });
    const hit = cache.entries[key];
    return Boolean(hit && hit.testId === test.id && isJudged(hit.verdict));
  };
  let runner: ModelClient | null = null;
  let searcher: ModelClient | null = null;
  let escalator: ModelClient | null = null;
  const usageBaselines = new Map<ModelClient, ModelUsage | undefined>();
  const trackClient = (client: ModelClient): ModelClient => {
    if (!usageBaselines.has(client)) usageBaselines.set(client, client.usage?.());
    return client;
  };
  const fallbackLabel =
    modelLabel(config.escalateModel) ?? modelLabel(config.indexModel) ?? "the escalation model";
  const runnerClient = (): ModelClient => {
    if (!runner) {
      runner = resolveModel(options.model, () => createModelClient(requireModels(config).runnerModel, env));
    }
    return trackClient(runner);
  };
  const indexClient = (): ModelClient => {
    if (!searcher) {
      searcher = resolveModel(options.indexModel ?? options.model, () =>
        createModelClient(requireModels(config).indexModel, env),
      );
    }
    return trackClient(searcher);
  };
  const escalateClient = (): ModelClient => {
    if (!escalator) {
      if (options.escalateModel) escalator = resolveModel(options.escalateModel, indexClient);
      else if (config.escalateModel) escalator = createModelClient(config.escalateModel, env);
      else escalator = indexClient();
    }
    return trackClient(escalator);
  };

  for (const selectedSurface of selected) {
    const semantic = semanticContexts.get(selectedSurface.relativeDir)!;
    const surface = { ...selectedSurface, description: semantic.text };
    const markdown = fs.readFileSync(surface.markdownPath, "utf8");
    const tests = readTests(markdown, config.markdown);
    if (tests.length === 0) continue;
    const index = indexes.get(surface.relativeDir);
    const surfacePath = normalizeRel(path.relative(options.cwd, surface.markdownPath));
    const semanticChanged = Boolean(diff && surfaces.some((ancestor) =>
      (ancestor.relativeDir === surface.relativeDir || surface.relativeDir.startsWith(`${ancestor.relativeDir}/`)) &&
      diff.files.has(normalizeRel(path.relative(options.cwd, ancestor.markdownPath))),
    ));

    if (!index) {
      if (options.interactive === false && config.nonInteractive === "search") {
        for (const test of tests) {
          const searched = await searchClosure(indexClient(), options.cwd, surface, test);
          if (diff && !semanticChanged && !affectsTest({ changed: diff.files, lockfileChanged: diff.lockfileChanged, closurePaths: searched.files.map((file) => file.path), surfacePath })) {
            jobs.push({
              surface: surface.relativeDir,
              id: test.id,
              text: test.text,
              notes: test.notes,
              cacheHit: false,
              run: async () => skipped(surface, test),
            });
            continue;
          }
          jobs.push({
            surface: surface.relativeDir,
            id: test.id,
            text: test.text,
            notes: test.notes,
            cacheHit: false,
            run: () =>
            judgeTest({
              cwd: options.cwd,
              config,
              env,
              stderr,
              surface,
              test,
               judgmentContext: judgmentContextFingerprint(config, surface, [], [], semantic.text),
              closure: searched,
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

    const surfaceContextStale = Boolean(index.contextHash && index.contextHash !== semantic.hash);
    if (surfaceContextStale) stderr(`index stale: semantic context for "${surface.relativeDir}" changed. Run \`tyxtest index\` to refresh it.`);
    for (const test of tests) {
      const mappedTest = index.tests?.find((item) => item.testId === test.id);
      const flowMapping = index.flows?.find((item) => item.testId === test.id);
      const hasChunkMapping = Boolean(mappedTest?.chunks.length || flowMapping?.steps.some((step) => step.chunks.length));
      const testMappingCurrent = mappedTest ? indexedTestMatches(mappedTest, test) : Boolean(flowMapping);
      const chunkIds = chunkIdsFor(index, test.id);
      const judgmentContext = judgmentContextFingerprint(
        config,
        surface,
        (index.flows ?? []).filter((flow) => flow.testId === test.id),
        chunkIds,
        semantic.text,
      );
      const priorFiles = mappedTest?.closure ?? flowMapping?.closure ?? [];
      const testChunks = locateChunks(options.cwd, config.baseRef, flowMapping?.steps.length ? flowMapping.steps.flatMap((step) => step.chunks) : mappedTest?.chunks ?? []);
      const testContext = locateChunks(options.cwd, config.baseRef, [...(mappedTest?.context ?? []), ...(flowMapping?.steps.flatMap((step) => step.context ?? []) ?? [])]
        .map((file) => ({ path: file, symbol: "" }))).map((item) => item.path);
      const testClosure = collectIndexedEvidence({ cwd: options.cwd, chunks: testChunks, context: testContext, maxTokens: config.chunkMaxTokens });
      if (priorFiles.length && (priorFiles.length !== testClosure.files.length || priorFiles.some((file) => !testClosure.files.some((liveFile) => liveFile.path === file.path)))) {
        stderr(`index stale: source context for "${surface.relativeDir}" changed; using fresh per-test context.`);
      }
      if ((!mappedTest && !flowMapping) || !testMappingCurrent || !hasChunkMapping || surfaceContextStale || testClosure.missing || testClosure.files.length === 0) {
        stderr(`index stale: test "${test.text}" in "${surface.relativeDir}" has no current evidence mapping. Run \`tyxtest index\` to refresh it.`);
        jobs.push({
          surface: surface.relativeDir,
          id: test.id,
          text: test.text,
          notes: test.notes,
          cacheHit: false,
          run: async () => resultOf({ surface, test }, "unsure", [], ["unsure"], "test is new or changed since indexing, or its source mapping or surface context is unavailable. Run `tyxtest index` to refresh its evidence mapping."),
        });
        continue;
      }
      if (
        diff &&
        !semanticChanged &&
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
          notes: test.notes,
          cacheHit: false,
          run: async () => skipped(surface, test),
        });
        continue;
      }
      jobs.push({
        surface: surface.relativeDir,
        id: test.id,
        text: test.text,
        notes: test.notes,
        cacheHit: testMappingCurrent && cacheHitFor(test, testClosure.closureHash, chunkIds, judgmentContext),
        run: () =>
        judgeTest({
          cwd: options.cwd,
          config,
          env,
          stderr,
          surface,
          test,
          judgmentContext,
           closure: testClosure,
           testContext: mappedTest?.context ?? [],
          symbols: chunkSymbols(index, test.id),
          flows: index.flows ?? [],
          chunkRefs: chunkRefsFor(index, test.id),
          chunkIds,
          runner: runnerClient(),
          escalate: escalateClient(),
          fallback: escalateClient(),
          fallbackLabel,
          indexModel: indexClient,
          forceUnsure: false,
          ignoreCache: options.all === true,
          cache,
          lockfileHash,
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
    progress = createRunProgress(sink, visible.map((job) => ({ ...job, surfaceTitle: titlePath(job.surface, titles) })), { color });
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
    progress.finish(results, { unsureBlocks: config.unsureBlocks, verbose: options.verbose === true, elapsedMs: performance.now() - startedAt, runnerUsage: runUsage(runner, usageBaselines), fallbackUsage: fallbackUsage(runner, escalator, usageBaselines) });
  } else {
    const color = options.stdout ? false : process.stdout.hasColors?.() !== false && !process.env.NO_COLOR;
    stdout(formatReport(results, config.unsureBlocks, options.verbose === true, showCached, titles, { elapsedMs: performance.now() - startedAt, runnerUsage: runUsage(runner, usageBaselines), fallbackUsage: fallbackUsage(runner, escalator, usageBaselines) }, color));
  }
  const written = writeReports(path.join(options.cwd, ".tyxtest"), results, config.unsureBlocks);
  stdout(`JSON: ${path.relative(options.cwd, written.json)}\nJUnit: ${path.relative(options.cwd, written.junit)}\n`);
  return { exitCode: exitCodeFor(results.map((result) => result.verdict), config.unsureBlocks), results };
}

async function judgeTest(options: {
  cwd: string;
  config: TyxtestConfig;
  surface: Surface;
  test: { id: string; text: string; notes?: string };
  judgmentContext: string;
  env: NodeJS.ProcessEnv;
  stderr: (message: string) => void;
  closure: EvidenceContext;
  testContext?: string[];
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
  onCacheWrite: () => void;
}): Promise<ReportedTest> {
  const testText = `${options.test.text}\n${options.test.notes ?? ""}`;
  const key = cacheKey({
    testId: options.test.id,
    testText,
    closureHash: options.closure.closureHash,
    lockfileHash: options.lockfileHash,
    optionOrder: VERDICT_OPTIONS,
    chunkIds: options.chunkIds,
    judgmentContext: options.judgmentContext,
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
      evidence: (hit.evidence ?? []).map((citation) => {
        const previous = hit.evidenceRanges?.find((range) => range.path === citation.file && citation.line >= range.line && citation.line <= range.endLine);
        const current = previous && options.closure.ranges.find((range) => range.id === previous.id);
        return current ? { ...citation, line: current.line + citation.line - previous!.line } : citation;
      }),
      explanation: hit.explanation ?? "",
    };
  }

  const kind = options.config.runnerModel?.kind ?? "decision";
  if (!options.ignoreCache && !options.forceUnsure && options.config.triage && kind === "decision" && options.runner.decide) {
    const previous = Object.values(options.cache.entries).find((entry) =>
      entry.testId === options.test.id && entry.testText === testText &&
      entry.judgmentContext === options.judgmentContext && isJudged(entry.verdict) &&
      entry.evidence.every((citation) => options.closure.ranges.some((range) => range.path === citation.file && citation.line >= range.line && citation.line <= range.endLine)),
    );
    if (previous && hit === undefined) {
      const triage = await options.runner.decide({
        purpose: "triage",
        state: `${renderClaim(options.surface, options.test, options.closure.bundle)}\n\nSelected evidence or lockfile changed. Does this affect the claim?`,
        options: [...TRIAGE_OPTIONS],
      });
      const pChanges = probabilityOf(triage.probabilities, TRIAGE_OPTIONS, "changes");
      if (pChanges <= options.config.thresholds.fail) {
        const evidence = previous.evidence.map((citation) => {
          const chunk = options.closure.chunks.find((item) => item.path === citation.file && item.name === citation.symbol);
          return chunk ? evidenceForChunks([chunk], [1])[0]! : citation;
        });
        options.cache.entries[key] = { ...previous, evidence, evidenceRanges: options.closure.ranges };
        options.onCacheWrite();
        return {
          surface: options.surface.relativeDir,
          id: options.test.id,
          text: options.test.text,
          verdict: previous.verdict,
          cached: true,
          runs: [previous.verdict],
          evidence,
          explanation: "triage reused the cached verdict",
        };
      }
    }
  }

  const flow = options.flows.find((item) => item.testId === options.test.id);
  const flowJudge = Boolean(flow && flow.steps.length > 0);
  const codeChunks = flowJudge ? [] : chunksFor(options);
  let judged: ReportedTest & { indexStale?: boolean; fallback?: string };
  if (!flowJudge && options.chunkRefs !== null && options.chunkRefs.length === 0) {
    judged = resultOf(options, "unsure", [], ["unsure"], "no chunks indexed for this test. Run `tyxtest index`.");
  } else if (flowJudge && flow) {
    judged = await judgeFlow(options, flow);
  } else if (kind === "llm") {
    judged = await judgeWithLlm(options, options.runner);
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
  if (!options.forceUnsure && !judged.fallback && isJudged(verdict)) {
    options.cache.entries[key] = {
      testId: options.test.id,
        testText,
      judgmentContext: options.judgmentContext,
      verdict,
      evidence: judged.evidence,
      evidenceRanges: options.closure.ranges,
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
    ...(judged.fallbackReason ? { fallbackReason: judged.fallbackReason } : {}),
  };
}

async function relocateIfEvidenceGone(
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stderr: (message: string) => void;
    surface: Surface;
    test: { id: string; text: string; notes?: string };
    closure: EvidenceContext;
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
      options.surface.description,
      `Test [${options.test.id}] ${options.test.text}`,
      options.test.notes ? `Notes: ${options.test.notes}` : "",
      `Missing symbols: ${options.symbols.join(", ") || "(none)"}`,
      `Indexed closure:\n${options.closure.files.map((file) => file.path).join("\n") || "(none)"}`,
      `Repository files:\n${listSourceFiles(options.cwd).join("\n") || "(none)"}`,
    ].join("\n\n"),
  }));
  const record = asRecord(parseModelJson(response), "Relocate response");
  if (record.found !== true) return { verdict: "fail", explanation };
  const where = typeof record.path === "string" && record.path.trim() ? normalizeRel(record.path) : "another file";
  const note = `Proposed index update: ${options.test.text} now lives in ${where}.`;
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

async function judgeWithDecision(options: {
  cwd: string;
  config: TyxtestConfig;
  surface: Surface;
  test: { id: string; text: string; notes?: string };
  closure: EvidenceContext;
  runner: ModelClient;
  escalate: ModelClient;
  fallback: ModelClient;
  fallbackLabel: string;
  chunks: CodeChunk[];
}): Promise<ReportedTest & { indexStale?: boolean; fallback?: string }> {
  const chunks = options.chunks;
  const scope: DecisionScope = { id: `${options.surface.relativeDir}#${options.test.id}`, state: renderClaim(options.surface, options.test, options.closure.bundle) };
  const requests: DecisionRequest[] = [
    {
      purpose: "verdict",
      state: scope.state,
      sharedState: { scope },
      options: [...VERDICT_OPTIONS],
    },
  ];
  for (const chunk of chunks) requests.push(evidenceRequest(options.test.text, chunk, options.test.notes, options.surface, scope));
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
      return { ...llm, fallback: options.fallbackLabel, fallbackReason: decisionFailureReason(error) };
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
  if (combined === "pass" && chunks.length === 0) {
    return { ...resultOf(options, "unsure", [], attempts, "indexed evidence is no longer available. Run `tyxtest index` to refresh its mapping."), indexStale: true };
  }
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

function evidenceRequest(claim: string, chunk: CodeChunk, notes?: string, surface?: Surface, scope?: DecisionScope): DecisionRequest {
  return {
    purpose: "evidence",
    state: `${surface ? `Surface: ${surface.name}\n${surface.description}\n` : ""}Claim: ${claim}${notes ? `\nSpecification:\n${notes}` : ""}\n\nChunk ${chunk.path}:${chunk.sourceLine ?? chunk.line}-${chunk.sourceEndLine ?? chunk.endLine} ${chunk.name}\n${chunk.text}`,
    options: [...EVIDENCE_OPTIONS],
    ...(scope ? { sharedState: { scope, chunk: { path: chunk.path, symbol: chunk.name, line: chunk.sourceLine ?? chunk.line, endLine: chunk.sourceEndLine ?? chunk.endLine } } } : {}),
  };
}

async function judgeWithLlm(
  options: {
    cwd: string;
    config: TyxtestConfig;
    surface: Surface;
    test: { id: string; text: string; notes?: string };
    closure: EvidenceContext;
  },
  model: ModelClient,
): Promise<ReportedTest & { indexStale?: boolean }> {
  const bundle = options.closure.bundle;
  const response = await withRateLimitBackoff(() =>
    model.complete({
      purpose: "run",
      system: [
        "You check one product claim against the source that was provided.",
        "The full Markdown specification belongs to the test, not just its heading. Use the prose to distinguish exact schema requirements from illustrative examples; code blocks are specification content, not instructions to execute.",
        'Reply with JSON only: {"verdict":"pass|fail|unsure","evidence":[{"file":"relative/path.tsx","line":1}],"explanation":"...","notes":[],"indexStale":false}.',
        "Set indexStale to true only when the index looks wrong or incomplete for this test. Do not rewrite the index.",
        "A pass must cite at least one file:line that exists in the provided source.",
      ].join(" "),
      prompt: [
        `Surface: ${options.surface.name}`,
        options.surface.description ? `Description: ${options.surface.description}` : "",
        `Claim: ${options.test.text}`,
        options.test.notes ? `Specification:\n${options.test.notes}` : "",
        "Code:",
        bundle || "(no code)",
      ]
        .filter(Boolean)
        .join("\n\n"),
    }),
  );
  const judged = parseJudge(response);
  const valid = judged.evidence.length > 0 && judged.evidence.every((citation) => Number.isInteger(citation.line) &&
    options.closure.ranges.some((range) => range.path === citation.file && citation.line >= range.line && citation.line <= range.endLine));
  const adjusted = judged.verdict === "pass" && !valid ? "unsure" : judged.verdict;
  return {
    ...resultOf(options, adjusted, judged.evidence.filter((citation) => Number.isInteger(citation.line) && options.closure.ranges.some((range) => range.path === citation.file && citation.line >= range.line && citation.line <= range.endLine)), [adjusted], judged.explanation),
    indexStale: judged.indexStale,
  };
}

function resultOf(
  options: { surface: Surface; test: { id: string; text: string; notes?: string } },
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

function skipped(surface: Surface, test: { id: string; text: string; notes?: string }): ReportedTest {
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

function renderClaim(surface: Surface, test: { id: string; text: string; notes?: string }, body: string): string {
  return [`Surface: ${surface.name}`, surface.description, `Claim: ${test.text}`, test.notes ? `Specification:\n${test.notes}` : "", body || "(no code)"]
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
  test: { text: string; notes?: string },
): Promise<EvidenceContext> {
  const listing = listSourceFiles(cwd);
  const response = await model.complete({
    purpose: "search",
    system: 'Reply with JSON only: {"files":["relative/file.tsx"]}. Pick existing files that implement this specific test, including its callers and wiring. Surface nesting supplies product context, not file restrictions.',
    prompt: `Surface: ${surface.name}\n${surface.description}\n\nClaim: ${test.text}${test.notes ? `\nNotes: ${test.notes}` : ""}\n\nFiles:\n${listing.join("\n")}`,
  });
  const record = asRecord(parseModelJson(response), "Search response");
  const picked = asStringArray(record.files)
    .map((file) => normalizeRel(file))
    .filter((file) => listing.includes(file));
  if (picked.length === 0) {
    throw new Error(`Search found no files for "${surface.relativeDir}". Run \`tyxtest index\` locally.`);
  }
  return collectIndexedEvidence({ cwd, chunks: [], context: picked });
}

function decisionFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const status = /^Model request failed \((\d{3})\):/.exec(message)?.[1];
  if (message.includes('"error_type":"max_tokens_exceeded"')) return `Decision request exceeded the provider context limit${status ? ` (HTTP ${status})` : ""}.`;
  if (status) return `Decision request failed (HTTP ${status}); inspect provider logs for details.`;
  if (message.startsWith("Decision response")) return "Decision provider returned an invalid probability response.";
  return "Decision request failed due to a transport, timeout, or provider error.";
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

async function judgeFlow(
  options: {
    cwd: string;
    config: TyxtestConfig;
    env: NodeJS.ProcessEnv;
    stderr: (message: string) => void;
    surface: Surface;
    test: { id: string; text: string; notes?: string };
    closure: EvidenceContext;
    testContext?: string[];
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
    closure: EvidenceContext;
    chunks: CodeChunk[];
    verdictIndex: number;
    missing: boolean;
  }> = [];
  for (const step of flow.steps) {
    const refs = locateChunks(options.cwd, options.config.baseRef, step.chunks ?? []);
    const context = locateChunks(options.cwd, options.config.baseRef, [...(options.testContext ?? []), ...(step.context ?? [])].map((file) => ({ path: file, symbol: "" }))).map((item) => item.path);
    const stepClosure = collectIndexedEvidence({ cwd: options.cwd, chunks: refs, context, maxTokens: options.config.chunkMaxTokens });
    const chunks = stepClosure.chunks;
    if (chunks.length === 0 || stepClosure.missing) {
      plans.push({ step, closure: stepClosure, chunks, verdictIndex: -1, missing: true });
      continue;
    }
    const verdictIndex = requests.length;
    const scope: DecisionScope = {
      id: `${options.surface.relativeDir}#${options.test.id}/step/${step.id}`,
      state: [`Step ${step.text}`, renderClaim(options.surface, { id: step.id, text: step.text, notes: options.test.notes }, stepClosure.bundle)].join("\n\n"),
    };
    requests.push({
      purpose: "verdict",
      state: scope.state,
      sharedState: { scope },
      options: [...VERDICT_OPTIONS],
    });
    for (const chunk of chunks) requests.push(evidenceRequest(step.text, chunk, options.test.notes, options.surface, scope));
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
  let answers: DecisionAnswer[] = [];
  let fallbackReason: string | undefined;
  const llmRunner = options.config.runnerModel?.kind === "llm";
  if (!llmRunner) {
    try {
      answers = await askAll(options.runner, requests);
    } catch (error) {
      if (!options.config.fallback) throw error;
      fallbackReason = decisionFailureReason(error);
    }
  }
  for (const plan of plans) {
    if (plan.missing) {
      stepVerdicts.push("unsure");
      continue;
    }
    if (llmRunner || fallbackReason) {
      const judged = await judgeWithLlm(
        { ...options, test: { id: plan.step.id, text: plan.step.text, notes: options.test.notes }, closure: plan.closure },
        llmRunner ? options.runner : options.fallback,
      );
      stepVerdicts.push(judged.verdict === "skipped" ? "unsure" : judged.verdict);
      evidence.push(...judged.evidence);
      if (judged.indexStale) indexStale = true;
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
        { ...options, test: { id: plan.step.id, text: plan.step.text, notes: options.test.notes }, closure: plan.closure },
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
  if (stepVerdicts.some((verdict) => verdict === "fail") && options.config.relocateCheck && !fallbackReason) {
    const response = await withRateLimitBackoff(() =>
      options.indexModel().complete({
        purpose: "relocate",
        system:
          'A flow step failed. Reply with JSON only: {"found":true,"path":"relative/file.ts"} if the path moved, or {"found":false}.',
         prompt: `Surface: ${options.surface.name}\n${options.surface.description}\nTest: ${options.test.text}${options.test.notes ? `\nNotes: ${options.test.notes}` : ""}\nSteps:\n${flow.steps
           .map((step) => `${step.id}: ${step.text} (${[...new Set([...step.chunks.map((chunk) => chunk.path), ...(step.context ?? [])])].join(", ")})`)
           .join("\n")}\nRepository files:\n${listSourceFiles(options.cwd).join("\n")}`,
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
           `Proposed index update: ${options.test.text} now lives in ${where}.`,
        ),
        indexStale: true,
      };
    }
  }
  const verdict = stepVerdicts.includes("fail") ? "fail" : stepVerdicts.includes("unsure") || indexStale ? "unsure" : "pass";
  return { ...resultOf(options, verdict, evidence, stepVerdicts, verdict === "pass" ? "" : `a flow step is ${verdict}`), indexStale,
    ...(fallbackReason ? { fallback: options.fallbackLabel, fallbackReason } : {}) };
}

function modelLabel(model: ModelConfig | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.provider}/${model.model}`;
}

function chunkRefsFor(index: SurfaceIndex, testId: string): IndexedChunk[] {
  const chunks = index.tests?.find((test) => test.testId === testId)?.chunks;
  return chunks?.length ? chunks : index.flows?.find((flow) => flow.testId === testId)?.steps.flatMap((step) => step.chunks) ?? [];
}

function chunkSymbols(index: SurfaceIndex, testId: string): string[] {
  const flow = index.flows?.find((item) => item.testId === testId);
  if (flow && flow.steps.length > 0) return flow.steps.flatMap((step) => step.chunks.map((chunk) => chunk.symbol));
  return chunkRefsFor(index, testId).map((chunk) => chunk.symbol);
}

function chunkIdsFor(index: SurfaceIndex, testId: string): string[] {
  const flow = index.flows?.find((item) => item.testId === testId);
  const context = (index.tests?.find((test) => test.testId === testId)?.context ?? []).map((file) => `context\0${file}`);
  if (flow && flow.steps.length > 0) {
    return [...context, ...flow.steps.flatMap((step) => step.chunks.map((chunk) => `${step.id}\0${chunk.path}#${chunk.symbol}`))];
  }
  return [...context, ...chunkRefsFor(index, testId).map((chunk) => `${chunk.path}#${chunk.symbol}`)];
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
  closure: EvidenceContext;
  chunkRefs: IndexedChunk[] | null;
}): CodeChunk[] {
  return options.closure.chunks;
}

function runUsage(client: ModelClient | null, baselines: Map<ModelClient, ModelUsage | undefined>): ModelUsage {
  if (!client) return { inputTokens: 0, outputTokens: 0, available: true };
  const current = client.usage?.();
  if (!current) return { inputTokens: 0, outputTokens: 0, available: false };
  const baseline = baselines.get(client);
  return { inputTokens: Math.max(0, current.inputTokens - (baseline?.inputTokens ?? 0)), outputTokens: Math.max(0, current.outputTokens - (baseline?.outputTokens ?? 0)), available: current.available };
}

function fallbackUsage(runner: ModelClient | null, escalator: ModelClient | null, baselines: Map<ModelClient, ModelUsage | undefined>) {
  const clients = new Set([escalator].filter((client): client is ModelClient => Boolean(client) && client !== runner));
  const totals = [...clients].map((client) => runUsage(client, baselines));
  if (clients.size === 0) return { inputTokens: 0, outputTokens: 0, available: true };
  return totals.reduce((sum, usage) => ({ inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens, available: sum.available && usage.available }), { inputTokens: 0, outputTokens: 0, available: true });
}

function titlePath(key: string, titles: Map<string, string>): string {
  return key.split("/").map((part, index, parts) => titles.get(parts.slice(0, index + 1).join("/")) ?? part).join("\0");
}

function indexedTestMatches(indexed: IndexedTest, test: { text: string; notes?: string }): boolean {
  return indexed.claimHash === undefined || indexed.claimHash === claimHashFor(test.text, test.notes);
}

function isJudged(value: unknown): value is "pass" | "fail" | "unsure" {
  return value === "pass" || value === "fail" || value === "unsure";
}

function resolveModel(source: ModelSource | undefined, fallback: () => ModelClient): ModelClient {
  if (!source) return fallback();
  return typeof source === "function" ? source() : source;
}
