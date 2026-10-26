import fs from "node:fs";

import { readText, writeText } from "../util/fs-util.js";
import { prettyJson } from "../util/json.js";
import { normalizeRel } from "../util/paths.js";

export interface IndexSymbolFile {
  hash: string;
  path: string;
  symbols: string[];
}

export interface FlowStep {
  id: string;
  text: string;
  entry: string;
}

export interface FlowRecord {
  testId: string;
  steps: FlowStep[];
  closure: Array<{ hash: string; path: string }>;
}

export interface SurfaceIndex {
  closure: Array<{ hash: string; path: string }>;
  closureHash: string;
  entry: string[];
  files: IndexSymbolFile[];
  notes: string[];
  flows?: FlowRecord[];
}

export function writeIndex(file: string, index: SurfaceIndex): void {
  const normalized: SurfaceIndex = {
    closure: index.closure
      .map((item) => ({ hash: item.hash, path: normalizeRel(item.path) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    closureHash: index.closureHash,
    entry: [...index.entry].map((item) => normalizeRel(item)).sort(),
    files: index.files
      .map((item) => ({
        hash: item.hash,
        path: normalizeRel(item.path),
        symbols: [...new Set(item.symbols)].sort(),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    notes: [...new Set(index.notes.map((note) => note.trim()).filter(Boolean))].sort(),
  };
  const flows = normalizeFlows(index.flows);
  if (flows.length > 0) normalized.flows = flows;
  writeText(file, prettyJson(normalized));
}

export function readIndex(file: string): SurfaceIndex {
  const parsed = JSON.parse(readText(file)) as Partial<SurfaceIndex>;
  if (!parsed || !Array.isArray(parsed.closure) || typeof parsed.closureHash !== "string") {
    throw new Error(`Invalid index file: ${file}`);
  }
  return {
    closure: parsed.closure.map((item) => ({
      hash: String(item.hash),
      path: normalizeRel(String(item.path)),
    })),
    closureHash: parsed.closureHash,
    entry: Array.isArray(parsed.entry) ? parsed.entry.map((item) => normalizeRel(String(item))) : [],
    files: Array.isArray(parsed.files)
      ? parsed.files.map((item) => ({
          hash: String(item.hash),
          path: normalizeRel(String(item.path)),
          symbols: Array.isArray(item.symbols) ? item.symbols.map((symbol) => String(symbol)) : [],
        }))
      : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes.map((note) => String(note)) : [],
    flows: normalizeFlows(parsed.flows),
  };
}

function normalizeFlows(flows: FlowRecord[] | undefined): FlowRecord[] {
  if (!Array.isArray(flows)) return [];
  return flows
    .flatMap((flow) => {
      if (!flow || typeof flow.testId !== "string" || !Array.isArray(flow.steps)) return [];
      const steps = flow.steps.flatMap((step) => {
        if (!step || typeof step.id !== "string" || typeof step.text !== "string" || typeof step.entry !== "string") {
          return [];
        }
        return [{ id: step.id, text: step.text, entry: normalizeRel(step.entry) }];
      });
      if (steps.length === 0) return [];
      const closure = Array.isArray(flow.closure)
        ? flow.closure
            .map((item) => ({ hash: String(item.hash), path: normalizeRel(String(item.path)) }))
            .sort((left, right) => left.path.localeCompare(right.path))
        : [];
      return [{ testId: flow.testId, steps, closure }];
    })
    .sort((left, right) => left.testId.localeCompare(right.testId));
}

export function indexExists(file: string): boolean {
  return fs.existsSync(file);
}
