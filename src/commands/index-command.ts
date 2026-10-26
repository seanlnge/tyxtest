import fs from "node:fs";
import path from "node:path";

import { loadConfig, requireModels } from "../config/config.js";
import { computeSurfaceClosure, exportedSymbols, hashClosure } from "../closure/closure.js";
import { createModelClient } from "../model/providers.js";
import { discoverSurfaces, filterSurfaces, type Surface } from "../surface/discover.js";
import { loadEnvFile } from "../config/env.js";
import { readText } from "../util/fs-util.js";
import { readIndex, writeIndex, type FlowRecord, type IndexedChunk, type IndexedTest, type SurfaceIndex } from "../surface/index-file.js";
import { asRecord, asStringArray, parseModelJson } from "../model/model-json.js";
import { clearPendingSurface, readPending } from "../surface/pending.js";
import { normalizeRel } from "../util/paths.js";
import type { Prompter } from "./prompter.js";
import { listSourceFiles, readFileBundle } from "../closure/repo-files.js";
import { backfillSurfaceFile, readFrontmatter, readTests, setFrontmatterField } from "../surface/surface.js";
import type { ModelClient, ModelSource, TyxtestConfig } from "../config/types.js";

export async function indexCommand(options: {
  cwd: string;
  prompter: Prompter;
  interactive: boolean;
  surfaces?: string[];
  pending?: boolean;
  fix?: boolean;
  env?: NodeJS.ProcessEnv;
  config?: TyxtestConfig;
  model?: ModelSource;
}): Promise<void> {
  const config = options.config ?? loadConfig(options.cwd);
  const env = loadEnvFile(options.cwd, options.env ?? process.env);
  const model = resolveModel(options.model, () => createModelClient(requireModels(config).indexModel, env));
  const surfaces = discoverSurfaces(options.cwd);
  if (surfaces.length === 0) throw new Error("No tyxtest surfaces found.");
  if (options.fix && options.pending) throw new Error("Use either --fix or --pending, not both.");
  const selected = new Set(
    (options.fix ? surfaces : filterSurfaces(surfaces, options.surfaces)).map((surface) => surface.relativeDir),
  );
  if (options.pending) {
    const pending = readPending(options.cwd);
    if (pending.length === 0) {
      options.prompter.log("No pending index suggestions.");
      return;
    }
    const flagged = new Set(pending.map((item) => item.surface));
    for (const dir of [...selected]) {
      if (!flagged.has(dir)) selected.delete(dir);
    }
  }
  if (selected.size === 0) throw new Error("No matching surfaces.");

  const indexes = new Map<string, SurfaceIndex>();
  for (const surface of surfaces) {
    const file = path.join(surface.dir, ".index.json");
    if (fs.existsSync(file)) indexes.set(surface.relativeDir, readIndex(file));
  }

  for (const surface of surfaces) {
    if (!selected.has(surface.relativeDir)) continue;
    const index = await indexSurface({
      cwd: options.cwd,
      surface,
      config,
      model,
      prompter: options.prompter,
      interactive: options.interactive,
      parentClosure: parentClosure(surface, indexes),
    });
    indexes.set(surface.relativeDir, index);
    clearPendingSurface(options.cwd, surface.relativeDir);
  }
}

async function indexSurface(options: {
  cwd: string;
  surface: Surface;
  config: TyxtestConfig;
  model: ModelClient;
  prompter: Prompter;
  interactive: boolean;
  parentClosure: Array<{ path: string }> | null;
}): Promise<SurfaceIndex> {
  backfillSurfaceFile(options.surface.markdownPath);
  let markdown = readText(options.surface.markdownPath);
  let entry = readFrontmatter(markdown).entry;
  if (!entry) {
    entry = await resolveEntry(options, markdown);
    markdown = setFrontmatterField(readText(options.surface.markdownPath), "entry", entry);
    fs.writeFileSync(options.surface.markdownPath, markdown);
  }

  const closure = computeSurfaceClosure({
    cwd: options.cwd,
    entry,
    depth: options.config.closureDepth,
    parentClosure: options.parentClosure,
  });
  const bundle = readFileBundle(
    options.cwd,
    closure.files.map((file) => file.path),
    120_000,
  );
  const cases = readTests(markdown);
  const response = await options.model.complete({
    purpose: "index",
    system: [
      "You map each test to the functions, components, or classes that implement that claim.",
      'Reply with JSON only: {"tests":[{"testId":"","chunks":[{"path":"","symbol":""}]}],"files":[{"path":"","symbols":[""]}],"notes":[""],"flows":[{"testId":"","steps":[{"id":"","text":"","entry":"","chunks":[{"path":"","symbol":""}]}]}]}',
      "A chunk is one symbol: a function, component, class, or constant. Give each test only the symbols that implement that claim. Do not assign the surface closure to every test.",
      "Copy testId from the provided ids. Do not invent a slug.",
      "Stay inside the provided files.",
      "If a test is a multi-step path, store it as a flow. Each step lists its own chunks. Stop at external boundaries such as a redirect to Stripe. Do not describe what the external service renders. Record the steps and do not count them.",
    ].join(" "),
    prompt: [
      `Surface: ${options.surface.name}`,
      options.surface.description ? `Description: ${options.surface.description}` : "",
      `Entry: ${entry}`,
      options.parentClosure ? "Only files inside the parent surface closure are in scope." : "",
      pendingPrompt(options.cwd, options.surface.relativeDir),
      "Test ids:",
      cases.map((test) => `- [${test.id}] ${test.text}`).join("\n") || "(no tests)",
      "surface.md:",
      markdown,
      "Code:",
      bundle || "(no files)",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const parsed = parseIndexResponse(response);
  const allowed = new Map(closure.files.map((file) => [file.path, file.hash]));
  const indexedTests = parsed.tests
    .map((test) => ({
      testId: test.testId,
      chunks: test.chunks.filter((chunk) => allowed.has(chunk.path)),
    }))
    .filter((test) => test.testId.length > 0);
  const fromTests = new Map<string, string[]>();
  for (const test of indexedTests) {
    for (const chunk of test.chunks) {
      const symbols = fromTests.get(chunk.path) ?? [];
      symbols.push(chunk.symbol);
      fromTests.set(chunk.path, symbols);
    }
  }
  const chosen = parsed.files
    .map((file) => ({ path: normalizeRel(file.path), symbols: file.symbols }))
    .filter((file) => allowed.has(file.path));
  for (const [pathName, symbols] of fromTests) {
    const existing = chosen.find((file) => file.path === pathName);
    if (existing) existing.symbols.push(...symbols);
    else chosen.push({ path: pathName, symbols });
  }
  const fileEntries =
    chosen.length > 0
      ? chosen
      : closure.files.filter((file) => file.path === normalizeRel(entry)).map((file) => ({ path: file.path, symbols: [] }));
  const files = fileEntries.map((file) => ({
    path: file.path,
    hash: allowed.get(file.path) ?? "",
    symbols: file.symbols.length > 0 ? file.symbols : exportedSymbols(path.join(options.cwd, file.path)),
  }));
  const notes = parsed.notes;
  const flows = buildFlows(options.cwd, options.config.closureDepth, options.parentClosure, parsed.flows);
  const index: SurfaceIndex = {
    closure: closure.files,
    closureHash: closure.closureHash,
    entry: [normalizeRel(entry)],
    files,
    notes,
    tests: indexedTests,
    flows,
  };
  writeIndex(path.join(options.surface.dir, ".index.json"), index);
  options.prompter.log(`indexed ${options.surface.relativeDir}`);
  return index;
}

async function resolveEntry(
  options: {
    cwd: string;
    surface: Surface;
    config: TyxtestConfig;
    model: ModelClient;
    prompter: Prompter;
    interactive: boolean;
  },
  markdown: string,
): Promise<string> {
  const label = options.surface.relativeDir;
  if (options.config.entryMode === "required") {
    throw new Error(`Surface "${label}" is missing entry:. entryMode is required.`);
  }
  if (!options.interactive && options.config.nonInteractive !== "search") {
    throw new Error(`Surface "${label}" has no entry. Run \`tyxtest index\` locally.`);
  }

  let entry: string;
  if (!options.interactive && options.config.nonInteractive === "search") {
    entry = await askModelForEntry(options.model, options.cwd, options.surface, markdown, "");
  } else if (options.config.entryMode === "ask-entry") {
    entry = normalizeRel(await options.prompter.ask(`Entry file for ${options.surface.name}:`));
  } else {
    const answer = await options.prompter.ask(`Where does ${options.surface.name} live?`);
    entry = await askModelForEntry(options.model, options.cwd, options.surface, markdown, answer);
  }
  if (!entry || !fs.existsSync(path.join(options.cwd, entry))) {
    throw new Error(`Entry file not found: ${entry || "(empty)"}`);
  }
  const updated = setFrontmatterField(readText(options.surface.markdownPath), "entry", entry);
  fs.writeFileSync(options.surface.markdownPath, updated);
  return entry;
}

async function askModelForEntry(
  model: ModelClient,
  cwd: string,
  surface: Surface,
  markdown: string,
  answer: string,
): Promise<string> {
  const listing = listSourceFiles(cwd).slice(0, 400).join("\n");
  const response = await model.complete({
    purpose: "resolve-entry",
    system: 'Reply with JSON only: {"entry":"relative/file.tsx"}. Pick one existing source file.',
    prompt: [`Surface: ${surface.name}`, markdown, answer ? `Answer: ${answer}` : "Find the entry file.", "Files:", listing].join(
      "\n\n",
    ),
  });
  const record = asRecord(parseModelJson(response), "Entry response");
  const entry = record.entry ?? record.path ?? record.file;
  if (typeof entry !== "string" || entry.trim() === "") throw new Error("Model did not return an entry path.");
  return normalizeRel(entry.trim());
}

function parentClosure(surface: Surface, indexes: Map<string, SurfaceIndex>): Array<{ path: string }> | null {
  if (!surface.parentRelativeDir) return null;
  const parent = indexes.get(surface.parentRelativeDir);
  if (!parent) {
    throw new Error(`Parent surface "${surface.parentRelativeDir}" is not indexed. Run \`tyxtest index\` locally.`);
  }
  return parent.closure;
}

function pendingPrompt(cwd: string, surface: string): string {
  const pending = readPending(cwd).filter((item) => item.surface === surface);
  if (pending.length === 0) return "";
  return `Pending suggestions:\n${pending.map((item) => `${item.testId}: ${item.detail || item.reason}`).join("\n")}`;
}

function buildFlows(
  cwd: string,
  depth: number | null,
  parentClosure: Array<{ path: string }> | null,
  flows: Array<{ testId: string; steps: Array<{ id: string; text: string; entry: string; chunks: IndexedChunk[] }> }>,
): FlowRecord[] {
  return flows.flatMap((flow) => {
    const parts = [];
    for (const step of flow.steps) {
      if (!fs.existsSync(path.join(cwd, step.entry))) continue;
      try {
        parts.push(computeSurfaceClosure({ cwd, entry: step.entry, depth, parentClosure }));
      } catch {
        continue;
      }
    }
    const byPath = new Map<string, { hash: string; path: string }>();
    for (const part of parts) {
      for (const file of part.files) byPath.set(file.path, file);
    }
    const closure = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
    return [{ testId: flow.testId, steps: flow.steps, closure, closureHash: hashClosure(closure) }].map((item) => ({
      testId: item.testId,
      steps: item.steps,
      closure: item.closure,
    }));
  });
}

function parseChunks(value: unknown): IndexedChunk[] {
  if (!Array.isArray(value)) return [];
  const chunks: IndexedChunk[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const chunk = item as Record<string, unknown>;
    if (typeof chunk.path !== "string" || typeof chunk.symbol !== "string") continue;
    const pathName = normalizeRel(chunk.path);
    const symbol = chunk.symbol.trim();
    if (!pathName || !symbol) continue;
    chunks.push({ path: pathName, symbol });
  }
  return chunks;
}

function parseIndexResponse(text: string): {
  tests: IndexedTest[];
  files: Array<{ path: string; symbols: string[] }>;
  notes: string[];
  flows: Array<{ testId: string; steps: Array<{ id: string; text: string; entry: string; chunks: IndexedChunk[] }> }>;
} {
  const record = asRecord(parseModelJson(text), "Index response");
  const tests: IndexedTest[] = [];
  if (Array.isArray(record.tests)) {
    for (const item of record.tests) {
      if (!item || typeof item !== "object") continue;
      const test = item as Record<string, unknown>;
      if (typeof test.testId !== "string" || test.testId.trim() === "") continue;
      tests.push({ testId: test.testId, chunks: parseChunks(test.chunks) });
    }
  }
  const files: Array<{ path: string; symbols: string[] }> = [];
  if (Array.isArray(record.files)) {
    for (const item of record.files) {
      if (!item || typeof item !== "object") continue;
      const file = item as Record<string, unknown>;
      if (typeof file.path !== "string") continue;
      files.push({ path: file.path, symbols: asStringArray(file.symbols) });
    }
  }
  const flows: Array<{ testId: string; steps: Array<{ id: string; text: string; entry: string; chunks: IndexedChunk[] }> }> = [];
  if (Array.isArray(record.flows)) {
    for (const item of record.flows) {
      if (!item || typeof item !== "object") continue;
      const flow = item as Record<string, unknown>;
      if (typeof flow.testId !== "string" || !Array.isArray(flow.steps)) continue;
      const steps = flow.steps.flatMap((step) => {
        if (!step || typeof step !== "object") return [];
        const recordStep = step as Record<string, unknown>;
        if (typeof recordStep.id !== "string" || typeof recordStep.text !== "string" || typeof recordStep.entry !== "string") {
          return [];
        }
        return [
          {
            id: recordStep.id,
            text: recordStep.text,
            entry: normalizeRel(recordStep.entry),
            chunks: parseChunks(recordStep.chunks),
          },
        ];
      });
      if (steps.length === 0) continue;
      flows.push({ testId: flow.testId, steps });
    }
  }
  return { tests, files, notes: asStringArray(record.notes), flows };
}

function resolveModel(source: ModelSource | undefined, fallback: () => ModelClient): ModelClient {
  if (!source) return fallback();
  return typeof source === "function" ? source() : source;
}
