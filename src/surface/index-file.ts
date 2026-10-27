import fs from "node:fs";
import path from "node:path";

import { readText, writeText } from "../util/fs-util.js";
import { hashContent } from "../util/hash.js";
import { normalizeRel } from "../util/paths.js";

export interface IndexSymbolFile { hash: string; path: string; symbols: string[] }
export interface IndexedChunk { path: string; symbol: string }
export interface IndexedTest { testId: string; chunks: IndexedChunk[]; context?: string[]; closure?: Array<{ hash: string; path: string }>; closureHash?: string; claimHash?: string }
export interface FlowStep { id: string; text: string; entry?: string; chunks: IndexedChunk[]; context?: string[] }
export interface FlowRecord { testId: string; steps: FlowStep[]; closure?: Array<{ hash: string; path: string }> }
export interface SurfaceIndex {
  closure?: Array<{ hash: string; path: string }>;
  closureHash?: string;
  entry?: string[];
  files: IndexSymbolFile[];
  notes: string[];
  contextHash?: string;
  tests?: IndexedTest[];
  flows?: FlowRecord[];
}

export function claimHashFor(text: string, notes?: string): string {
  return hashContent(`${text}\0${notes ?? ""}`);
}

interface StoredRecord { surface: string; kind: string; [key: string]: unknown }
const CENTRAL_NAME = ".index.json";

/** Read all indexes, preferring the consolidated store and importing legacy files as needed. */
export function readIndexes(cwd: string): Map<string, SurfaceIndex> {
  const central = path.join(cwd, "tyxtest", CENTRAL_NAME);
  const indexes = fs.existsSync(central) ? decodeCentral(readText(central), central) : new Map<string, SurfaceIndex>();
  const root = path.join(cwd, "tyxtest");
  if (!fs.existsSync(root)) return indexes;
  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith(".")) continue;
      const child = path.join(dir, item.name);
      const legacy = path.join(child, CENTRAL_NAME);
      if (fs.existsSync(legacy)) {
        const key = normalizeRel(path.relative(root, child));
        if (!indexes.has(key)) indexes.set(key, readLegacyIndex(legacy));
      }
      walk(child);
    }
  };
  walk(root);
  return indexes;
}

/** Compatibility API: the former per-surface path now addresses that surface in the shared store. */
export function writeIndex(file: string, index: SurfaceIndex): void {
  const { root, key } = surfaceLocation(file);
  const all = readIndexes(root);
  all.set(key, normalizeIndex(index));
  writeIndexes(root, all);
}

export function writeIndexes(cwd: string, indexes: Map<string, SurfaceIndex>): void {
  writeText(path.join(cwd, "tyxtest", CENTRAL_NAME), encodeCentral(indexes));
  removeLegacyIndexes(path.join(cwd, "tyxtest"));
}

export function readIndex(file: string): SurfaceIndex {
  if (path.basename(path.dirname(file)) === "tyxtest") {
    const parsed = decodeCentral(readText(file), file);
    const first = parsed.values().next().value as SurfaceIndex | undefined;
    if (!first) throw new Error(`Invalid index file: ${file}`);
    return first;
  }
  const { root, key } = surfaceLocation(file);
  const all = readIndexes(root);
  const index = all.get(key);
  if (!index) throw new Error(`Index file not found: ${file}`);
  return index;
}

export function indexExists(file: string): boolean {
  if (fs.existsSync(file)) return true;
  try {
    const { root, key } = surfaceLocation(file);
    return readIndexes(root).has(key);
  } catch { return false; }
}

function surfaceLocation(file: string): { root: string; key: string } {
  const absolute = path.resolve(file);
  let dir = path.dirname(absolute);
  while (path.basename(dir) !== "tyxtest" && path.dirname(dir) !== dir) dir = path.dirname(dir);
  if (path.basename(dir) !== "tyxtest" || dir === path.dirname(dir)) throw new Error(`Not a tyxtest surface index path: ${file}`);
  return { root: path.dirname(dir), key: normalizeRel(path.relative(dir, path.dirname(absolute))) };
}

function normalizeIndex(index: SurfaceIndex): SurfaceIndex {
  const closure = (items: Array<{ hash: string; path: string }> | undefined) => (items ?? [])
    .map((item) => ({ hash: String(item.hash), path: normalizeRel(String(item.path)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const result: SurfaceIndex = {
    files: index.files.map((item) => ({ hash: item.hash, path: normalizeRel(item.path), symbols: [...new Set(item.symbols)].sort() }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    notes: [...new Set(index.notes.map((note) => note.trim()).filter(Boolean))].sort(),
  };
  if (index.closure) result.closure = closure(index.closure);
  if (index.closureHash) result.closureHash = index.closureHash;
  if (index.entry) result.entry = [...new Set(index.entry.map(normalizeRel))].sort();
  if (index.contextHash) result.contextHash = index.contextHash;
  const tests = normalizeTests(index.tests).map((test) => ({
    ...test,
    ...(test.closure || index.closure ? { closure: test.closure ?? closure(index.closure) } : {}),
    ...(test.closureHash || index.closureHash ? { closureHash: test.closureHash ?? index.closureHash } : {}),
  }));
  const flows = normalizeFlows(index.flows);
  if (tests.length) result.tests = tests;
  if (flows.length) result.flows = flows;
  return result;
}

function normalizeChunks(chunks: IndexedChunk[] | undefined): IndexedChunk[] {
  if (!Array.isArray(chunks)) return [];
  const unique = new Map<string, IndexedChunk>();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.path !== "string" || typeof chunk.symbol !== "string") continue;
    const item = { path: normalizeRel(chunk.path), symbol: chunk.symbol.trim() };
    if (item.path && item.symbol) unique.set(`${item.path}#${item.symbol}`, item);
  }
  return [...unique.values()].sort((a, b) => `${a.path}#${a.symbol}`.localeCompare(`${b.path}#${b.symbol}`));
}

function normalizeTests(tests: IndexedTest[] | undefined): IndexedTest[] {
  return (Array.isArray(tests) ? tests : []).filter((test) => test && typeof test.testId === "string" && test.testId.trim())
    .map((test) => ({ testId: test.testId, chunks: normalizeChunks(test.chunks), ...(test.context ? { context: [...new Set(test.context.map(normalizeRel))].sort() } : {}), ...(test.closure ? { closure: test.closure.map((item) => ({ hash: String(item.hash), path: normalizeRel(String(item.path)) })).sort((a, b) => a.path.localeCompare(b.path)) } : {}), ...(test.closureHash ? { closureHash: test.closureHash } : {}), ...(test.claimHash ? { claimHash: test.claimHash } : {}) }))
    .sort((a, b) => a.testId.localeCompare(b.testId));
}

function normalizeFlows(flows: FlowRecord[] | undefined): FlowRecord[] {
  return (Array.isArray(flows) ? flows : []).filter((flow) => flow && typeof flow.testId === "string" && Array.isArray(flow.steps))
    .map((flow) => ({
      testId: flow.testId,
      steps: flow.steps.filter((step) => step && typeof step.id === "string" && typeof step.text === "string")
        .map((step) => ({ ...step, ...(step.entry ? { entry: normalizeRel(step.entry) } : {}), chunks: normalizeChunks(step.chunks), ...(step.context ? { context: [...new Set(step.context.map(normalizeRel))].sort() } : {}) })),
      ...(flow.closure ? { closure: flow.closure.map((item) => ({ hash: String(item.hash), path: normalizeRel(String(item.path)) })).sort((a, b) => a.path.localeCompare(b.path)) } : {}),
    })).filter((flow) => flow.steps.length > 0).sort((a, b) => a.testId.localeCompare(b.testId));
}

function encodeCentral(indexes: Map<string, SurfaceIndex>): string {
  const records: StoredRecord[] = [];
  for (const [surface, raw] of [...indexes].sort(([a], [b]) => a.localeCompare(b))) {
    const index = normalizeIndex(raw);
    records.push({ surface, kind: "meta", notes: index.notes, ...(index.contextHash ? { contextHash: index.contextHash } : {}) });
    for (const item of index.tests ?? []) records.push({ surface, kind: "test", ...item });
    for (const item of index.flows ?? []) records.push({
      surface,
      kind: "flow",
      testId: item.testId,
      steps: item.steps,
      ...(item.closure ? { closure: item.closure } : {}),
    });
  }
  return `{
  "version": 2,
  "records": [
${records.map((record) => `    ${stableStringify(record)}`).join(",\n")}
  ]
}\n`;
}

function stableStringify(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
  };
  return JSON.stringify(sort(value));
}

function removeLegacyIndexes(root: string): void {
  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith(".")) continue;
      const child = path.join(dir, item.name);
      const legacy = path.join(child, CENTRAL_NAME);
      if (fs.existsSync(legacy)) fs.rmSync(legacy);
      walk(child);
    }
  };
  if (fs.existsSync(root)) walk(root);
}

function decodeCentral(text: string, file: string): Map<string, SurfaceIndex> {
  let parsed: { version?: number; records?: unknown };
  try { parsed = JSON.parse(text) as typeof parsed; } catch { throw new Error(`Invalid index file: ${file}`); }
  if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.records)) throw new Error(`Invalid index file: ${file}`);
  const grouped = new Map<string, StoredRecord[]>();
  for (const value of parsed.records) {
    if (!value || typeof value !== "object") continue;
    const record = value as StoredRecord;
    if (typeof record.surface !== "string" || typeof record.kind !== "string") continue;
    const list = grouped.get(normalizeRel(record.surface)) ?? [];
    list.push(record); grouped.set(normalizeRel(record.surface), list);
  }
  const output = new Map<string, SurfaceIndex>();
  for (const [surface, records] of grouped) {
    const meta = records.find((record) => record.kind === "meta");
    if (!meta) continue;
    const closure = records.filter((r) => r.kind === "closure").map((r) => ({ hash: String(r.hash), path: normalizeRel(String(r.path)) }));
    const files = records.filter((r) => r.kind === "source").map((r) => ({ hash: String(r.hash), path: normalizeRel(String(r.path)), symbols: Array.isArray(r.symbols) ? r.symbols.map(String) : [] }));
    const tests = records.filter((r) => r.kind === "test").map((r) => ({ testId: String(r.testId),
      chunks: normalizeChunks(r.chunks as IndexedChunk[]), ...(Array.isArray(r.context) ? { context: r.context.map(String) } : {}),
      ...(Array.isArray(r.closure) ? { closure: r.closure as Array<{ path: string; hash: string }> } : {}),
      ...(typeof r.closureHash === "string" ? { closureHash: r.closureHash } : {}), ...(typeof r.claimHash === "string" ? { claimHash: r.claimHash } : {}) }));
    const flows = records.filter((r) => r.kind === "flow").map((r) => r as unknown as FlowRecord);
    const normalizedTests = normalizeTests(tests).map((test) => parsed.version === 1 && !test.closure ? { ...test, closure, closureHash: typeof meta.closureHash === "string" ? meta.closureHash : undefined } : test);
    output.set(surface, normalizeIndex({ ...(typeof meta.closureHash === "string" ? { closureHash: meta.closureHash } : {}),
      ...(closure.length ? { closure } : {}), ...(Array.isArray(meta.entry) ? { entry: meta.entry.map(String) } : {}),
      contextHash: typeof meta.contextHash === "string" ? meta.contextHash : undefined,
      files, notes: Array.isArray(meta.notes) ? meta.notes.map(String) : [], tests: normalizedTests, flows }));
  }
  return output;
}

function readLegacyIndex(file: string): SurfaceIndex {
  let parsed: Partial<SurfaceIndex>;
  try { parsed = JSON.parse(readText(file)) as Partial<SurfaceIndex>; } catch { throw new Error(`Invalid index file: ${file}`); }
  if (!Array.isArray(parsed.closure) || typeof parsed.closureHash !== "string") throw new Error(`Invalid index file: ${file}`);
  const legacyClosure = parsed.closure as NonNullable<SurfaceIndex["closure"]>;
  const tests = (parsed.tests ?? []).map((test) => ({ ...test, closure: test.closure ?? legacyClosure, closureHash: test.closureHash ?? parsed.closureHash }));
  return normalizeIndex({ closure: legacyClosure, closureHash: parsed.closureHash,
    entry: Array.isArray(parsed.entry) ? parsed.entry.map(String) : [], files: Array.isArray(parsed.files) ? parsed.files as IndexSymbolFile[] : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [], tests: tests as IndexedTest[], flows: parsed.flows as FlowRecord[] });
}
