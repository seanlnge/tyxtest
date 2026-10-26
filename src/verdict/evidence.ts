import { hashContent } from "../util/hash.js";
import { normalizeRel } from "../util/paths.js";
import type { Citation, Verdict } from "../config/types.js";

type JudgedVerdict = Exclude<Verdict, "skipped">;

export interface IndexedFile {
  path: string;
  hash: string;
}

export function applyEvidenceCheck(
  verdict: JudgedVerdict,
  evidence: Citation[],
  closure: IndexedFile[],
  files: Record<string, string>,
): JudgedVerdict {
  if (verdict !== "pass") return verdict;
  if (!evidenceValid(evidence, closure, files)) return "unsure";
  return "pass";
}

export function evidenceValid(evidence: Citation[], closure: IndexedFile[], files: Record<string, string>): boolean {
  if (evidence.length === 0) return false;
  const hashes = new Map(closure.map((file) => [normalizeRel(file.path), file.hash]));
  return evidence.every((citation) => citationMatches(citation, hashes, files));
}

function citationMatches(
  citation: Citation,
  hashes: Map<string, string>,
  files: Record<string, string>,
): boolean {
  if (!Number.isInteger(citation.line) || citation.line < 1) return false;
  const file = normalizeRel(citation.file);
  const expectedHash = hashes.get(file);
  if (!expectedHash) return false;
  const content = files[file];
  if (content === undefined) return false;
  if (hashContent(content) !== expectedHash) return false;
  return citation.line <= lineCount(content);
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split(/\r?\n/);
  if (content.endsWith("\n") || content.endsWith("\r\n")) parts.pop();
  return parts.length;
}
