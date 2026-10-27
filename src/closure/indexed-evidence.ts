import fs from "node:fs";
import path from "node:path";

import { chunkSource, selectChunks, type CodeChunk } from "./chunk.js";
import { collectTestContext, type ClosureFile } from "./closure.js";
import { hashContent } from "../util/hash.js";

export interface EvidenceContext {
  files: ClosureFile[];
  closureHash: string;
  chunks: CodeChunk[];
  bundle: string;
  ranges: Array<{ path: string; line: number; endLine: number; id: string }>;
  missing: boolean;
}

/** One fresh selection shared by prompts, hashing and citation validation. */
export function collectIndexedEvidence(options: {
  cwd: string;
  chunks: Array<{ path: string; symbol: string }>;
  context?: string[];
  maxTokens?: number;
}): EvidenceContext {
  const snapshot = collectTestContext(options);
  const contents = new Map(snapshot.files.map((file) => [file.path, fs.readFileSync(path.join(options.cwd, file.path), "utf8")]));
  // A selected outer symbol is one faithful declaration, not N duplicated focus slices.
  const declarations = [...contents].flatMap(([file, text]) => chunkSource(file, text, Number.POSITIVE_INFINITY, undefined, false));
  const chunks = selectChunks(declarations, options.chunks);
  const focusRefs = options.chunks.filter((ref) => !chunks.some((chunk) => chunk.path === ref.path && (chunk.name === ref.symbol || chunk.symbol === ref.symbol)));
  if (focusRefs.length) chunks.push(...selectChunks([...contents].flatMap(([file, text]) => chunkSource(file, text, options.maxTokens, undefined, false)), focusRefs));
  const ranges = chunks.map((chunk) => ({ path: chunk.path, line: chunk.sourceLine ?? chunk.line, endLine: chunk.sourceEndLine ?? chunk.endLine,
    id: hashContent(`${chunk.path}\0${chunk.name}\0${chunk.text}`) }));
  const parts = chunks.map((chunk) => `===== ${chunk.path}:${chunk.sourceLine ?? chunk.line}-${chunk.sourceEndLine ?? chunk.endLine} ${chunk.name} =====\n${chunk.text}`);
  const identities = chunks.map((chunk) => `${chunk.path}\0${chunk.name}\0${chunk.symbol}\0${chunk.text}`);
  for (const file of [...new Set(options.context ?? [])].sort()) {
    const text = contents.get(file);
    if (text === undefined) continue;
    const endLine = text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
    ranges.push({ path: file, line: 1, endLine, id: hashContent(`${file}\0${text}`) });
    identities.push(`${file}\0explicit context\0${text}`);
    parts.push(`===== ${file}:1-${endLine} (explicit context) =====\n${text}`);
  }
  const bundle = parts.join("\n\n");
  const missing = options.chunks.some((ref) => !chunks.some((chunk) => chunk.path === ref.path && (chunk.name === ref.symbol || chunk.symbol === ref.symbol))) ||
    (options.context ?? []).some((file) => !contents.has(file));
  return { files: snapshot.files, closureHash: hashContent(JSON.stringify(identities)), chunks, bundle, ranges, missing };
}
