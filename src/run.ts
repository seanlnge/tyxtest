import fs from "node:fs";
import path from "node:path";

import { cacheKey, loadCache, saveCache, type CacheHit } from "./cache.js";
import { loadConfig, requireModels } from "./config.js";
import { collectClosure, computeSurfaceClosure, type ClosureFile } from "./closure.js";
import { discoverSurfaces, filterSurfaces, type Surface } from "./discover.js";
import { loadEnvFile } from "./env.js";
import { applyEvidenceCheck } from "./evidence.js";
import { readIndex, type SurfaceIndex } from "./index-file.js";
import { hashLockfiles } from "./lockfile.js";
import { asRecord, asStringArray, parseModelJson } from "./model-json.js";
import { addProposedNotes } from "./notes.js";
import { normalizeRel } from "./paths.js";
import { createModelClient } from "./providers.js";
import { formatReport, writeReports, type ReportedTest } from "./reporter.js";
import { listSourceFiles } from "./repo-files.js";
import { readTests } from "./surface.js";
import type { Citation, ModelClient, ModelSource, TyxtestConfig, Verdict } from "./types.js";
import { aggregateVerdicts, exitCodeFor } from "./verdict.js";

const VERDICT_RANK: Record<Verdict, number> = { pass: 0, unsure: 1, fail: 2 };

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
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
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

  const lockfileHash = hashLockfiles(options.cwd);
  const cacheFile = path.join(options.cwd, ".tyxtest", "verdict-cache.json");
  const cache = loadCache(cacheFile);
  let cacheDirty = false;
  const results: ReportedTest[] = [];
  let runner: ModelClient | null = null;
  let searcher: ModelClient | null = null;
  const runnerClient = (): ModelClient => {
    if (!runner) {
      runner = resolveModel(options.model, () => createModelClient(requireModels(config).runnerModel, env));
    }
    return runner;
  };
  const indexClient = (): ModelClient => {
    if (!searcher) {
      searcher = resolveModel(
        options.indexModel ?? options.model,
        () => createModelClient(requireModels(config).indexModel, env),
      );
    }
    return searcher;
  };

  for (const surface of selected) {
    const markdown = fs.readFileSync(surface.markdownPath, "utf8");
    const tests = readTests(markdown);
    const index = indexes.get(surface.relativeDir);
    if (!index) {
      if (options.interactive === false && config.nonInteractive === "search") {
        const searched = await searchClosure(indexClient(), options.cwd, surface, markdown);
        for (const test of tests) {
          results.push(
            await judgeTest({
              cwd: options.cwd,
              config,
              surface,
              test,
              closure: searched,
              hashSource: searched.files,
              model: runnerClient(),
              fresh: false,
              forceUnsure: true,
              cache,
              lockfileHash,
            }),
          );
        }
        continue;
      }
      throw new Error(`Surface "${surface.relativeDir}" is not indexed. Run \`tyxtest index\` locally.`);
    }

    const entry = index.entry[0] ?? surface.entry;
    if (!entry) {
      throw new Error(`Surface "${surface.relativeDir}" is not indexed. Run \`tyxtest index\` locally.`);
    }
    const live = computeSurfaceClosure({
      cwd: options.cwd,
      entry,
      depth: config.closureDepth,
      parentClosure: parentClosure(surface, indexes),
    });
    const fresh = live.closureHash === index.closureHash;
    if (!fresh) {
      stderr(
        `Index for "${surface.relativeDir}" does not match the current code. Run \`tyxtest index\` to refresh it.`,
      );
    }
    for (const test of tests) {
      const judged = await judgeTest({
        cwd: options.cwd,
        config,
        surface,
        test,
        closure: live,
        hashSource: index.closure,
        model: runnerClient(),
        fresh,
        forceUnsure: false,
        cache,
        lockfileHash,
      });
      if (judged.cached === false && fresh) cacheDirty = true;
      results.push(judged);
    }
  }

  if (cacheDirty) saveCache(cacheFile, cache);
  const report = formatReport(results, config.unsureBlocks);
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
  closure: { files: ClosureFile[]; closureHash: string };
  hashSource: Array<{ path: string; hash: string }>;
  model: ModelClient;
  fresh: boolean;
  forceUnsure: boolean;
  cache: { entries: Record<string, CacheHit> };
  lockfileHash: string;
}): Promise<ReportedTest> {
  const key = cacheKey({
    testId: options.test.id,
    testText: options.test.text,
    closureHash: options.closure.closureHash,
    lockfileHash: options.lockfileHash,
  });
  if (options.fresh && !options.forceUnsure) {
    const hit = options.cache.entries[key];
    if (hit && hit.testId === options.test.id && isVerdict(hit.verdict)) {
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
  }

  const contents = readClosureContents(options.cwd, options.closure.files);
  const bundle = options.closure.files
    .map((file) => `===== ${file.path} =====\n${contents[file.path] ?? ""}`)
    .join("\n");
  const attempts: Verdict[] = [];
  let evidence: Citation[] = [];
  let explanation = "";
  let worst: Verdict = "pass";
  const notes: string[] = [];
  const total = 1 + options.config.reruns;
  for (let attempt = 0; attempt < total; attempt += 1) {
    const response = await options.model.complete({
      purpose: "run",
      system: [
        "You check one product claim against the source that was provided.",
        'Reply with JSON only: {"verdict":"pass|fail|unsure","evidence":[{"file":"relative/path.tsx","line":1}],"explanation":"...","notes":[]}.',
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
    });
    const judged = parseJudge(response);
    const adjusted = applyEvidenceCheck(judged.verdict, judged.evidence, options.hashSource, contents);
    attempts.push(adjusted);
    notes.push(...judged.notes);
    if (VERDICT_RANK[adjusted] >= VERDICT_RANK[worst] || attempt === 0) {
      worst = adjusted;
      evidence = judged.evidence;
      explanation = judged.explanation;
    }
    if (attempt === 0 && adjusted === "pass") break;
  }

  let verdict = aggregateVerdicts(attempts, options.config.verdictRule);
  if (options.forceUnsure) verdict = "unsure";
  if (notes.length > 0) addProposedNotes(options.cwd, options.surface.relativeDir, notes);
  if (options.fresh && !options.forceUnsure) {
    options.cache.entries[key] = {
      testId: options.test.id,
      verdict,
      evidence,
      explanation,
    };
  }
  return {
    surface: options.surface.relativeDir,
    id: options.test.id,
    text: options.test.text,
    verdict,
    cached: false,
    runs: attempts,
    evidence,
    explanation,
  };
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

function parseJudge(text: string): { verdict: Verdict; evidence: Citation[]; explanation: string; notes: string[] } {
  const record = asRecord(parseModelJson(text), "Verdict");
  const verdict = isVerdict(record.verdict) ? record.verdict : "unsure";
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
  };
}

function isVerdict(value: unknown): value is Verdict {
  return value === "pass" || value === "fail" || value === "unsure";
}

function resolveModel(source: ModelSource | undefined, fallback: () => ModelClient): ModelClient {
  if (!source) return fallback();
  return typeof source === "function" ? source() : source;
}
