import path from "node:path";

import { loadConfig, requireModels } from "../config/config.js";
import { collectTestContext } from "../closure/closure.js";
import { estimateTokens, indexableSymbols } from "../closure/chunk.js";
import { createImportedChunkResolver } from "../closure/symbol-reference.js";
import { createModelClient } from "../model/providers.js";
import { discoverSurfaces, filterSurfaces, surfaceContextFor, type Surface } from "../surface/discover.js";
import { loadEnvFile } from "../config/env.js";
import { readText } from "../util/fs-util.js";
import { claimHashFor, readIndexes, writeIndexes, type IndexedChunk, type IndexedTest, type SurfaceIndex } from "../surface/index-file.js";
import { asRecord, asStringArray, parseModelJson } from "../model/model-json.js";
import { clearPendingSurface, readPending } from "../surface/pending.js";
import { normalizeRel } from "../util/paths.js";
import type { Prompter } from "./prompter.js";
import { listSourceFiles, readFileBundle } from "../closure/repo-files.js";
import { readTests } from "../surface/surface.js";
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
  /** Internal run preflight: exact surface keys and authored claim IDs needing refresh. */
  incremental?: ReadonlyMap<string, readonly string[]>;
}): Promise<void> {
  const config = options.config ?? loadConfig(options.cwd);
  const env = loadEnvFile(options.cwd, options.env ?? process.env);
  let model: ModelClient | undefined;
  const indexClient = () => model ??= resolveModel(options.model, () => createModelClient(requireModels(config).indexModel, env));
  const surfaces = discoverSurfaces(options.cwd, config.markdown);
  if (surfaces.length === 0) {
    if (!options.incremental && readIndexes(options.cwd).size > 0) writeIndexes(options.cwd, new Map());
    throw new Error("No tyxtest surfaces found.");
  }
  if (options.fix && options.pending) throw new Error("Use either --fix or --pending, not both.");
  if (options.incremental && (options.fix || options.pending)) throw new Error("Incremental indexing cannot use --fix or --pending.");
  const selected = new Set(
    (options.incremental ? surfaces.filter((surface) => options.incremental!.has(surface.relativeDir)) : options.fix ? surfaces : filterSurfaces(surfaces, options.surfaces)).map((surface) => surface.relativeDir),
  );
  if (options.pending) {
    const pending = readPending(options.cwd);
    if (pending.length === 0) {
      const existing = readIndexes(options.cwd);
      const live = new Set(surfaces.map((surface) => surface.relativeDir));
      let pruned = false;
      for (const key of existing.keys()) {
        if (live.has(key)) continue;
        existing.delete(key);
        pruned = true;
      }
      if (pruned) writeIndexes(options.cwd, existing);
      options.prompter.log("No pending index suggestions.");
      return;
    }
    const flagged = new Set(pending.map((item) => item.surface));
    for (const dir of [...selected]) {
      if (!flagged.has(dir)) selected.delete(dir);
    }
  }
  if (selected.size === 0) throw new Error("No matching surfaces.");

  const indexes = readIndexes(options.cwd);
  const knownSurfaces = new Set(surfaces.map((surface) => surface.relativeDir));
  for (const key of indexes.keys()) {
    if (!options.incremental && !knownSurfaces.has(key)) indexes.delete(key);
  }
  const cleared = new Map<string, Set<string>>();

  for (const surface of surfaces) {
    if (!selected.has(surface.relativeDir)) continue;
    const index = await indexSurface({
      cwd: options.cwd,
      surface,
      model: indexClient,
      prompter: options.prompter,
      surfaces,
      markdown: config.markdown,
      chunkMaxTokens: config.chunkMaxTokens,
      ...(options.incremental ? { testIds: options.incremental.get(surface.relativeDir), existing: indexes.get(surface.relativeDir) } : {}),
    });
    if (options.incremental) {
      const live = new Set([...(index.tests ?? []), ...(index.flows ?? [])].map((item) => item.testId));
      const previous = indexes.get(surface.relativeDir);
      const removed = [...(previous?.tests ?? []), ...(previous?.flows ?? [])].filter((item) => !live.has(item.testId)).map((item) => item.testId);
      cleared.set(surface.relativeDir, new Set([...(options.incremental.get(surface.relativeDir) ?? []), ...removed]));
    }
    indexes.set(surface.relativeDir, index);
  }
  writeIndexes(options.cwd, indexes);
  for (const surface of selected) clearPendingSurface(options.cwd, surface, options.incremental ? cleared.get(surface) : undefined);
}

async function indexSurface(options: {
  cwd: string;
  surface: Surface;
  model: ModelSource;
  prompter: Prompter;
  surfaces: Surface[];
  markdown: TyxtestConfig["markdown"];
  chunkMaxTokens: number;
  testIds?: readonly string[];
  existing?: SurfaceIndex;
}): Promise<SurfaceIndex> {
  const markdown = readText(options.surface.markdownPath);
  const semantic = surfaceContextFor(options.surface, options.surfaces, options.markdown);
  const allCases = readTests(markdown, options.markdown);
  const liveIds = new Set(allCases.map((test) => test.id));
  const cases = options.testIds ? allCases.filter((test) => options.testIds!.includes(test.id)) : allCases;
  if (cases.length === 0) {
    options.prompter.log(`indexed ${options.surface.relativeDir}`);
    return { files: [], notes: [], ...options.existing, contextHash: semantic.hash,
      tests: (options.existing?.tests ?? []).filter((test) => liveIds.has(test.testId)),
      flows: (options.existing?.flows ?? []).filter((flow) => liveIds.has(flow.testId)) };
  }
  const model = resolveModel(options.model, () => { throw new Error("An index model is required to map authored claims."); });
  const sourceFiles = listSourceFiles(options.cwd);
  const bundle = readFileBundle(options.cwd, sourceFiles, Infinity);
  const sourceTexts = new Map(sourceFiles.map((file) => [file, readText(path.join(options.cwd, file))]));
  const inventory = new Map(sourceFiles.map((file) => [file, indexableSymbols(file, sourceTexts.get(file)!, options.chunkMaxTokens)]));
  const resolveImported = createImportedChunkResolver(options.cwd, sourceTexts, inventory);
  const currentTestIds = new Set(cases.map((test) => test.id));
  const promptPrefix = [
    "Exact declaration inventory (path#symbol, rendered character/token estimates; whole-file entries are costly):",
    [...inventory].flatMap(([file, symbols]) => symbols.map((symbol) => `${file}#${symbol.symbol} ${symbol.chars} chars ~${Math.ceil(symbol.chars / 4)} tokens${symbol.fileContext ? " WHOLE FILE" : ""}`)).join("\n") || "(no selectable source)",
    "Code:",
    bundle || "(no files)",
    `Surface: ${options.surface.name}`,
    semantic.text,
    ...(options.testIds ? ["Surface claims (context only, not mapping targets; map only the Test ids below):",
      allCases.map((test) => `## ${test.text}${test.notes ? `\n\n${test.notes}` : ""}`).join("\n\n")] : []),
    pendingPrompt(options.cwd, options.surface.relativeDir),
  ].filter(Boolean).join("\n\n");
  const testPrompt = (ids: Set<string>) => cases.filter((test) => ids.has(test.id))
    .map((test) => `- [${test.id}] ${test.text}${test.notes ? `\n  Notes: ${test.notes}` : ""}`).join("\n");
  const request = {
    purpose: "index",
    system: [
      "You map each test to the functions, components, or classes that implement that claim.",
      'Reply with JSON only: {"tests":[{"testId":"","chunks":[{"path":"","symbol":""}],"context":[]}],"notes":[""],"flows":[{"testId":"","steps":[{"id":"","text":"","chunks":[{"path":"","symbol":""}],"context":[]}]}]}. Account for EVERY provided testId with nonempty chunks or a nonempty flow. If no implementation is discoverable, use {"testId":"","chunks":[],"unmappable":"specific reason"} instead of inventing symbols or silently omitting the test.',
      "A chunk is one symbol: a function, component, class, or constant. Use default for anonymous default functions or classes. For module-level execution such as route registration, use the source filename (for example routes.ts) as the symbol to select its file-context chunk. Verdicts receive ONLY selected fresh chunks and explicit context, never automatic callers, imports, dependencies or snapshots. Select caller and wiring symbols explicitly when relevant; prefer chunks over full-file context.",
      "Select relevant caller, routing, registration, and wiring symbols as chunks. Use context only when the entire file is necessary: each context path authorizes full-file model input. A flow step receives only its own chunks/context plus explicit test-wide context; do not promote step-local context to test-wide context. An isolated implementation does not prove it is connected to the product. Test fixtures and mocks do not establish production behavior.",
      "Copy exact path and symbol pairs from the declaration inventory. Imports/re-exports are not definitions: map the defining file. Removed or nonexistent names are invalid. Prefer a concise sufficient set of functions/helpers/constants and context:[] (a few chunks, roughly 5k tokens when feasible, not a hard limit). Never replace individually selectable declarations with a whole file to paper over missing evidence; file-context chunks also cost the entire file.",
      "If an explicitly selected name is an actual imported binding in the given file, tyxtest can normalize that same selection through exact local import/export provenance to its declaration and logs the normalized reference. This never selects additional dependencies or guesses by matching names elsewhere.",
      'Any test or step selecting nonempty context or a WHOLE FILE inventory chunk must include wholeFileReason:"why individually selectable declarations cannot establish this behavior". Without this justification the mapping is rejected for repair. Keep this field absent for normal precise chunk selections.',
      "Before answering, trace each claimed behavior through its required helpers, literal/schema constants, caller arguments/default role selections, and decision/LLM/flow branches. Select every declaration needed to establish those semantics, not merely the outer orchestrator. If a necessary dependency cannot be mapped, include missingDependencies:[\"specific unresolved dependency\"] on that test or step for repair; do not claim coverage by omission. Do not automatically select unrelated dependencies. An unmappable reason is for genuinely undiscoverable implementation, not a shortcut for a difficult claim.",
      "Copy testId from the provided ids. Do not invent a slug.",
      "Map chunks across any repository source file. Surface folders provide semantic context only and are not file boundaries.",
      "A test includes its full Markdown body: paragraphs, lists, examples, and code or schema blocks are part of the specification, not separate tests. Follow the prose to distinguish exact schema requirements from illustrative examples.",
      "If a test is a multi-step path, store it as a flow. Each step lists its own chunks. Stop at external boundaries such as a redirect to Stripe. Do not describe what the external service renders. Record the steps and do not count them.",
    ].join(" "),
    prompt: `${promptPrefix}\n\nTest ids:\n\n${testPrompt(currentTestIds)}`,
  } satisfies Parameters<ModelClient["complete"]>[0];
  let parsed: ReturnType<typeof parseIndexResponse> | undefined;
  let problems: string[] = [];
  let repairIds = new Set(currentTestIds);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await model.complete(attempt === 0 ? request : { ...request, prompt: `${promptPrefix}\n\nTest ids:\n\n${testPrompt(repairIds)}\n\nREPAIR REQUIRED (one final attempt):\n${problems.map((problem) => `- ${problem}`).join("\n")}\nReturn mappings ONLY for the requested testIds above. Already-valid claims are retained and cannot be overwritten. Account for EVERY requested testId. Use only exact inventory symbols, explicitly select necessary helpers/callers/constants, and keep context empty unless the whole file is truly required. Do not silently drop invalid references. Mark genuinely undiscoverable claims unmappable with a reason.` });
    try {
      const incoming = parseIndexResponse(response);
      const requestedIds = attempt === 0 ? currentTestIds : repairIds;
      const normalizeSelection = (label: string, selection: ParsedSelection) => {
        selection.chunks = selection.chunks.map((ref) => {
          const resolved = resolveImported(ref);
          if (!resolved || resolved.path === ref.path && resolved.symbol === ref.symbol) return ref;
          options.prompter.log(`index ${options.surface.relativeDir} ${label}: normalized imported reference ${ref.path}#${ref.symbol} -> ${resolved.path}#${resolved.symbol}`);
          return resolved;
        });
      };
      for (const test of incoming.tests) if (requestedIds.has(test.testId)) normalizeSelection(`[${test.testId}]`, test);
      for (const flow of incoming.flows) if (requestedIds.has(flow.testId)) for (const step of flow.steps) normalizeSelection(`[${flow.testId}] step ${step.id}`, step);
      // Replace both record kinds only for requested claims; good first-pass maps are immutable.
      parsed = attempt === 1 && parsed ? {
        tests: [...parsed.tests.filter((test) => !repairIds.has(test.testId)), ...incoming.tests.filter((test) => repairIds.has(test.testId))],
        flows: [...parsed.flows.filter((flow) => !repairIds.has(flow.testId)), ...incoming.flows.filter((flow) => repairIds.has(flow.testId))],
        notes: [...new Set([...parsed.notes, ...incoming.notes])],
      } : incoming;
      problems = validateMapping(parsed, cases.map((test) => test.id), inventory);
      if (attempt === 0 && problems.length) {
        const firstPass = parsed;
        repairIds = new Set(cases.filter((test) => validateMapping(firstPass, [test.id], inventory).length > 0).map((test) => test.id));
        if (!repairIds.size) repairIds = new Set(currentTestIds);
      }
    } catch (error) {
      problems = [error instanceof Error ? error.message : "Invalid index response"];
      if (attempt === 0) { parsed = undefined; repairIds = new Set(currentTestIds); }
    }
    if (problems.length === 0) break;
    if (attempt === 0) options.prompter.warn(`index ${options.surface.relativeDir}: repairing invalid or incomplete mapping: ${problems.join("; ")}`);
  }
  if (!parsed || problems.length) throw new Error(`Index mapping for "${options.surface.relativeDir}" is invalid after one repair; nothing was persisted:\n${problems.join("\n")}`);
  const chunksByTestId = new Map(parsed.tests.map((test) => [test.testId, test]));
  const indexedTests: IndexedTest[] = cases.map((test) => ({
    testId: test.id,
    claimHash: claimHashFor(test.text, test.notes),
    chunks: chunksByTestId.get(test.id)?.chunks ?? [],
    context: chunksByTestId.get(test.id)?.context ?? [],
  }));
  const notes = [...parsed.notes];
  for (const test of cases) {
    const reason = chunksByTestId.get(test.id)?.unmappable;
    if (!reason) continue;
    const diagnostic = `Unmappable test [${test.id}] ${test.text}: ${reason}. Run will judge with no related code chunks; no implementation mapping was invented.`;
    notes.push(diagnostic);
    options.prompter.warn(diagnostic);
  }
  const flows: NonNullable<SurfaceIndex["flows"]> = parsed.flows.filter((flow) => currentTestIds.has(flow.testId)).map((flow) => ({
    testId: flow.testId,
    steps: flow.steps.map((step) => {
      const chunks = step.chunks;
      const context = step.context;
      return { id: step.id, text: step.text, chunks, context };
    }),
  }));
  for (const test of indexedTests) {
    const steps = flows.find((flow) => flow.testId === test.testId)?.steps ?? [];
    const context = [...new Set([...(test.context ?? []), ...steps.flatMap((step) => step.context ?? [])])];
    for (const file of context) {
      const text = sourceTexts.get(file)!;
      options.prompter.warn(`index ${options.surface.relativeDir} [${test.testId}]: explicit whole-file context ${file} costs ${text.length} chars (~${estimateTokens(text)} tokens). Prefer its exact declaration chunks when sufficient.`);
    }
    const chunks = [...test.chunks, ...steps.flatMap((step) => step.chunks)];
    for (const ref of chunks) if (inventory.get(ref.path)?.find((symbol) => symbol.symbol === ref.symbol)?.fileContext) {
      const text = sourceTexts.get(ref.path)!;
      options.prompter.warn(`index ${options.surface.relativeDir} [${test.testId}]: ${ref.path}#${ref.symbol} selects a whole-file execution chunk costing ${text.length} chars (~${estimateTokens(text)} tokens), not a small declaration.`);
    }
  }
  const testsWithContext = indexedTests.map((test) => {
    const steps = flows.find((flow) => flow.testId === test.testId)?.steps ?? [];
    const explicitContext = [...new Set([...(test.context ?? []), ...steps.flatMap((step) => step.context ?? [])])];
    const chunks = [...test.chunks, ...steps.flatMap((step) => step.chunks)];
    const collected = collectTestContext({ cwd: options.cwd, chunks, context: explicitContext });
    return { ...test, closure: collected.files, closureHash: collected.closureHash };
  });
  // Stored unchanged maps are trusted records, not new responses needing justification.
  const index: SurfaceIndex = {
    files: [],
    ...options.existing,
    notes: [...new Set([...(options.existing?.notes ?? []), ...notes])],
    contextHash: semantic.hash,
    tests: [...(options.existing?.tests ?? []).filter((test) => liveIds.has(test.testId) && !currentTestIds.has(test.testId)), ...testsWithContext],
    flows: [...(options.existing?.flows ?? []).filter((flow) => liveIds.has(flow.testId) && !currentTestIds.has(flow.testId)), ...flows],
  };
  const unmappableCount = cases.filter((test) => chunksByTestId.get(test.id)?.unmappable).length;
  options.prompter.log(`coverage ${options.surface.relativeDir}: ${cases.length - unmappableCount} mapped, ${unmappableCount} explicitly unmappable of ${cases.length} tests`);
  options.prompter.log(`indexed ${options.surface.relativeDir}`);
  return index;
}

function pendingPrompt(cwd: string, surface: string): string {
  const pending = readPending(cwd).filter((item) => item.surface === surface);
  if (pending.length === 0) return "";
  return `Pending suggestions:\n${pending.map((item) => `${item.testId}: ${item.detail || item.reason}`).join("\n")}`;
}

function parseChunks(value: unknown, issues: string[]): IndexedChunk[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { issues.push("chunks must be an array"); return []; }
  const chunks: IndexedChunk[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") { issues.push("invalid chunk reference"); continue; }
    const chunk = item as Record<string, unknown>;
    if (typeof chunk.path !== "string" || typeof chunk.symbol !== "string") { issues.push("chunk needs a path and symbol"); continue; }
    const pathName = normalizeRel(chunk.path);
    const symbol = chunk.symbol.trim();
    if (!pathName || !symbol || symbol.length > 256 || /[\u0000-\u001f\u007f]/.test(symbol)) { issues.push("invalid chunk path or symbol"); continue; }
    chunks.push({ path: pathName, symbol });
  }
  return chunks;
}

interface ParsedSelection {
  chunks: IndexedChunk[];
  context: string[];
  issues: string[];
  unmappable?: string;
  wholeFileReason?: string;
}

interface ParsedIndex {
  tests: Array<ParsedSelection & { testId: string }>;
  notes: string[];
  flows: Array<{ testId: string; issues: string[]; steps: Array<ParsedSelection & { id: string; text: string }> }>;
}

function parseSelection(record: Record<string, unknown>): ParsedSelection {
  const issues: string[] = [];
  const chunks = parseChunks(record.chunks, issues);
  if (record.context !== undefined && (!Array.isArray(record.context) || record.context.some((item) => typeof item !== "string" || !item.trim()))) issues.push("context must contain source paths");
  if (record.unmappable !== undefined && (typeof record.unmappable !== "string" || !record.unmappable.trim())) issues.push("unmappable needs a specific reason");
  if (record.missingDependencies !== undefined) {
    if (!Array.isArray(record.missingDependencies)) issues.push("missingDependencies must be an array");
    else if (record.missingDependencies.length) issues.push(`necessary dependencies are not mapped: ${record.missingDependencies.map(String).join(", ")}`);
  }
  return { chunks, context: asStringArray(record.context).map(normalizeRel), issues,
    ...(typeof record.wholeFileReason === "string" && record.wholeFileReason.trim() ? { wholeFileReason: record.wholeFileReason.trim() } : {}),
    ...(typeof record.unmappable === "string" && record.unmappable.trim() ? { unmappable: record.unmappable.trim() } : {}) };
}

function parseIndexResponse(text: string): ParsedIndex {
  const record = asRecord(parseModelJson(text), "Index response");
  const tests: ParsedIndex["tests"] = [];
  if (Array.isArray(record.tests)) {
    for (const item of record.tests) {
      if (!item || typeof item !== "object") continue;
      const test = item as Record<string, unknown>;
      if (typeof test.testId !== "string" || test.testId.trim() === "") continue;
      tests.push({ testId: test.testId, ...parseSelection(test) });
    }
  }
  const flows: ParsedIndex["flows"] = [];
  if (Array.isArray(record.flows)) {
    for (const item of record.flows) {
      if (!item || typeof item !== "object") continue;
      const flow = item as Record<string, unknown>;
      if (typeof flow.testId !== "string") continue;
      const issues: string[] = [];
      if (!Array.isArray(flow.steps)) issues.push("flow steps must be an array");
      const steps = (Array.isArray(flow.steps) ? flow.steps : []).flatMap((step) => {
        if (!step || typeof step !== "object") { issues.push("invalid flow step"); return []; }
        const recordStep = step as Record<string, unknown>;
        if (typeof recordStep.id !== "string" || typeof recordStep.text !== "string") {
          issues.push("flow step needs an id and text");
          return [];
        }
        return [
          {
            id: recordStep.id,
            text: recordStep.text,
            ...parseSelection(recordStep),
          },
        ];
      });
      flows.push({ testId: flow.testId, steps, issues });
    }
  }
  return { tests, notes: asStringArray(record.notes), flows };
}

function validateMapping(parsed: ParsedIndex, testIds: string[], inventory: Map<string, ReturnType<typeof indexableSymbols>>): string[] {
  const problems: string[] = [];
  const validate = (label: string, selection: ParsedSelection) => {
    problems.push(...selection.issues.map((issue) => `${label}: ${issue}`));
    for (const ref of selection.chunks) if (!inventory.get(ref.path)?.some((item) => item.symbol === ref.symbol)) {
      const alternatives = [...inventory].filter(([, symbols]) => symbols.some((item) => item.symbol === ref.symbol)).map(([file]) => `${file}#${ref.symbol}`);
      problems.push(`${label}: ${ref.path}#${ref.symbol} is not a declared selectable symbol${alternatives.length ? `; declaration exists at ${alternatives.join(", ")}` : "; choose an actual declaration from the inventory"}. Imports are not definitions.`);
    }
    for (const file of selection.context) if (!inventory.has(file)) problems.push(`${label}: context file ${file} is not in the source inventory`);
    const wholeFiles = [...selection.context, ...selection.chunks.filter((ref) => inventory.get(ref.path)?.some((item) => item.symbol === ref.symbol && item.fileContext)).map((ref) => ref.path)];
    if (wholeFiles.length && !selection.wholeFileReason) problems.push(`${label}: whole-file input (${[...new Set(wholeFiles)].join(", ")}) needs wholeFileReason explaining why exact declaration chunks are insufficient; prefer precise chunks instead`);
  };
  for (const testId of testIds) {
    const tests = parsed.tests.filter((test) => test.testId === testId);
    const flows = parsed.flows.filter((flow) => flow.testId === testId);
    if (tests.length > 1 || flows.length > 1) problems.push(`[${testId}]: duplicate test or flow mapping`);
    const test = tests[0];
    const flow = flows[0];
    if (test) validate(`[${testId}]`, test);
    if (test?.unmappable) {
      if (test.chunks.length || test.context.length || flow) problems.push(`[${testId}]: unmappable must not include source mappings or a flow`);
      continue;
    }
    if (!test?.chunks.length && !flow?.steps.length) problems.push(`[${testId}]: missing evidence mapping; select actual chunks/a nonempty flow or explicitly mark an undiscoverable implementation unmappable with a reason`);
    if (!flow) continue;
    if (!flow.steps.length) problems.push(`[${testId}] flow: steps must not be empty`);
    problems.push(...flow.issues.map((issue) => `[${testId}] flow: ${issue}`));
    const stepIds = new Set<string>();
    for (const step of flow.steps) {
      const label = `[${testId}] step ${step.id}`;
      if (!step.id.trim() || !step.text.trim() || stepIds.has(step.id)) problems.push(`${label}: step id and text must be nonempty and ids unique`);
      stepIds.add(step.id);
      validate(label, step);
      if (!step.chunks.length || step.unmappable) problems.push(`${label}: missing step evidence; select actual chunks or mark the whole undiscoverable claim unmappable`);
    }
  }
  return problems;
}

function resolveModel(source: ModelSource | undefined, fallback: () => ModelClient): ModelClient {
  if (!source) return fallback();
  return typeof source === "function" ? source() : source;
}
