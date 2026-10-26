import fs from "node:fs";

import { readText, writeText } from "./fs-util.js";
import { prettyJson } from "./json.js";
import { normalizeRel } from "./paths.js";

export interface IndexSymbolFile {
  hash: string;
  path: string;
  symbols: string[];
}

export interface SurfaceIndex {
  closure: Array<{ hash: string; path: string }>;
  closureHash: string;
  entry: string[];
  files: IndexSymbolFile[];
  notes: string[];
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
  };
}

export function indexExists(file: string): boolean {
  return fs.existsSync(file);
}
