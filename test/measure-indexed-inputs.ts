// Offline diagnostic: injected models only; reports/cache are written in a disposable copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

import { collectIndexedEvidence } from "../src/closure/indexed-evidence.js";
import { listSourceFiles } from "../src/closure/repo-files.js";
import { runCommand } from "../src/commands/run.js";
import { loadConfig } from "../src/config/config.js";
import { createModelClient } from "../src/model/providers.js";
import type { DecisionRequest } from "../src/config/types.js";
import { discoverSurfaces, surfaceContextFor } from "../src/surface/discover.js";
import { readIndexes } from "../src/surface/index-file.js";
import { readTests } from "../src/surface/surface.js";

const cwd = process.cwd();
const config = loadConfig(cwd);
const files = listSourceFiles(cwd);
const texts = new Map(files.map((file) => [file, fs.readFileSync(path.join(cwd, file), "utf8")]));
const indexes = readIndexes(cwd);
const surfaces = discoverSurfaces(cwd, config.markdown);
const dependencies = new Map<string, string[]>();
const importers = new Map<string, string[]>();
const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
const compilerOptions = configPath ? ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, path.dirname(configPath)).options : {};
for (const [file, text] of texts) {
  const targets = ts.preProcessFile(text, true, true).importedFiles.flatMap((item) => {
    const resolved = ts.resolveModuleName(item.fileName, path.join(cwd, file), compilerOptions, ts.sys).resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport) return [];
    const relative = path.relative(cwd, resolved.resolvedFileName).replaceAll("\\", "/");
    return texts.has(relative) ? [relative] : [];
  });
  dependencies.set(file, targets);
  for (const target of targets) importers.set(target, [...(importers.get(target) ?? []), file]);
}
const oldSizes: number[] = [];
const oldCounts: number[] = [];
const chunkSizes: number[] = [];
const contextSizes: number[] = [];
const contextCounts: number[] = [];
const selectedSizes: number[] = [];
const reconstructedStates: number[] = [];
const missingSelections: Array<{ surface: string; claim: string; missing: string[] }> = [];
let mapped = 0;
for (const surface of surfaces) {
  const index = indexes.get(surface.relativeDir);
  if (!index) continue;
  const semantic = surfaceContextFor(surface, surfaces, config.markdown);
  for (const test of readTests(fs.readFileSync(surface.markdownPath, "utf8"), config.markdown)) {
    const mapping = index.tests?.find((item) => item.testId === test.id);
    const flow = index.flows?.find((item) => item.testId === test.id);
    if (!mapping && !flow) continue;
    mapped += 1;
    const chunks = [...(mapping?.chunks ?? []), ...(flow?.steps.flatMap((step) => step.chunks) ?? [])];
    const context = [...new Set([...(mapping?.context ?? []), ...(flow?.steps.flatMap((step) => step.context ?? []) ?? [])])];
    const selected = collectIndexedEvidence({ cwd, chunks, context, maxTokens: config.chunkMaxTokens });
    if (selected.missing || !chunks.length) missingSelections.push({ surface: surface.relativeDir, claim: test.text,
      missing: chunks.filter((ref) => !selected.chunks.some((chunk) => chunk.path === ref.path && (chunk.name === ref.symbol || chunk.symbol === ref.symbol))).map((ref) => `${ref.path}#${ref.symbol}`) });
    chunkSizes.push(collectIndexedEvidence({ cwd, chunks, maxTokens: config.chunkMaxTokens }).bundle.length);
    contextCounts.push(context.length);
    contextSizes.push(context.reduce((sum, file) => sum + (texts.get(file)?.length ?? 0), 0));
    selectedSizes.push(selected.bundle.length);
    const roots = [...new Set([...chunks.map((chunk) => chunk.path), ...context])].filter((file) => texts.has(file));
    const old = new Set([...roots, ...(mapping?.closure ?? flow?.closure ?? []).map((file) => file.path).filter((file) => texts.has(file))]);
    const reverse = [...roots];
    const seen = new Set<string>();
    for (let i = 0; i < reverse.length; i += 1) {
      const file = reverse[i]!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const caller of importers.get(file) ?? []) { old.add(caller); if (!seen.has(caller)) reverse.push(caller); }
    }
    const forward = [...old];
    for (let i = 0; i < forward.length; i += 1) for (const dependency of dependencies.get(forward[i]!) ?? []) {
      if (!old.has(dependency)) { old.add(dependency); forward.push(dependency); }
    }
    const body = [...old].sort().map((file) => `===== ${file} =====\n${texts.get(file)}`).join("\n\n");
    oldCounts.push(old.size);
    oldSizes.push([...old].reduce((sum, file) => sum + texts.get(file)!.length, 0));
    reconstructedStates.push([`Surface: ${surface.name}`, semantic.text, `Claim: ${test.text}`, test.notes ? `Specification:\n${test.notes}` : "", body].filter(Boolean).join("\n\n").length);
  }
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tyxtest-offline-size-"));
const requests: DecisionRequest[] = [];
const batches: number[] = [];
const legacySerializedStateChars: number[] = [];
const wireStateChars: number[] = [];
const wireBodyChars: number[] = [];
const originalFetch = globalThis.fetch;
// No network path exists: actual provider serialization ends at this offline fetch boundary.
globalThis.fetch = (async (input, init) => {
  if (String(input) !== "https://offline.invalid/v1/systemone") throw new Error("Unexpected offline diagnostic URL");
  const serialized = String(init?.body);
  const body = JSON.parse(serialized) as { state: unknown; questions: Record<string, { criteria: Record<string, string> }> };
  wireStateChars.push(JSON.stringify(body.state).length);
  wireBodyChars.push(serialized.length);
  return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
    { probabilities: Object.fromEntries(Object.keys(question.criteria).map((option, index) => [option, index === 0 ? 1 : 0])) },
  ])) }), { status: 200 });
}) as typeof fetch;
const wireClient = createModelClient({ provider: "typesafe", model: "jev", kind: "decision" }, { TYPESAFE_API_KEY: "offline-fake-key", TYPESAFE_BASE_URL: "https://offline.invalid" });
try {
  for (const file of files) {
    const target = path.join(scratch, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(cwd, file), target);
  }
  for (const surface of surfaces) {
    const target = path.join(scratch, path.relative(cwd, surface.markdownPath));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(surface.markdownPath, target);
  }
  fs.copyFileSync(path.join(cwd, "tyxtest/.index.json"), path.join(scratch, "tyxtest/.index.json"));
  const outcome = await runCommand({ cwd: scratch, config: { ...config, runnerModel: { ...config.runnerModel!, kind: "decision" }, relocateCheck: false }, all: true,
    env: {}, stdout: () => {}, stderr: () => {}, model: {
      async complete() { throw new Error("Offline measurement must not need an LLM"); },
      async decideMany(batch) {
        requests.push(...batch);
        batches.push(batch.reduce((sum, request) => sum + request.state.length, 0));
        legacySerializedStateChars.push(JSON.stringify(Object.fromEntries(batch.map((request, index) => [`q${index}`, request.state]))).length);
        return wireClient.decideMany!(batch);
      },
    } });
  const summary = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, min: sorted[0] ?? 0, median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted.at(-1) ?? 0 };
  };
  console.log(JSON.stringify({ offlineOnly: true, mappedTests: mapped, staleWithoutCalls: outcome.results.filter((result) => result.verdict === "unsure").length,
    missingSelections,
    reconstructedPreviousAutomaticFileCounts: summary(oldCounts), reconstructedPreviousAutomaticCodeChars: summary(oldSizes), reconstructedPreviousVerdictStateChars: summary(reconstructedStates),
    selectedChunkBundleChars: summary(chunkSizes), explicitContextFileCounts: summary(contextCounts), explicitContextRawChars: summary(contextSizes), selectedBundleWithExplicitContextChars: summary(selectedSizes),
    capturedActualVerdictStateChars: summary(requests.filter((request) => request.purpose === "verdict").map((request) => request.state.length)), capturedLogicalRepeatedBatchStateChars: summary(batches),
    reconstructedLegacySerializedBatchStateChars: summary(legacySerializedStateChars), capturedActualTypeSafeSerializedStateChars: summary(wireStateChars), capturedActualTypeSafeSerializedBodyChars: summary(wireBodyChars),
    caveat: "Automatic expansion baseline is reconstructed on current source, not historical bytes. Legacy repeated wire state is reconstructed from current complete logical requests. New wire is captured at the actual provider fetch boundary, with no network calls. Sizes are characters, not provider token counts. Source selections are preserved; results/cache exist only in a disposable copy." }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(scratch, { recursive: true, force: true });
}
