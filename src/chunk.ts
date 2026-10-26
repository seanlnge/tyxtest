import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { hashContent } from "./hash.js";
import type { Citation } from "./types.js";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

export interface CodeChunk {
  path: string;
  name: string;
  /** Outermost function, component, or class this chunk belongs to. */
  symbol: string;
  kind: "function" | "component" | "class";
  line: number;
  endLine: number;
  text: string;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export function evidenceIdentity(filePath: string, symbol: string, text: string): { id: string; hash: string } {
  const hash = hashContent(text).slice(0, 8);
  return { hash, id: `${path.basename(filePath)}#${symbol}@${hash}` };
}

export function chunkClosure(cwd: string, files: Array<{ path: string }>, maxTokens = 4000): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  for (const file of files) {
    const absolute = path.join(cwd, file.path);
    if (!fs.existsSync(absolute)) continue;
    chunks.push(...chunkSource(file.path, fs.readFileSync(absolute, "utf8"), maxTokens));
  }
  return chunks;
}

/** Highest-scoring chunks. Identity is symbol + content hash. Line is display-only. */
export function evidenceForChunks(chunks: CodeChunk[], yesScores: number[]): Citation[] {
  if (chunks.length === 0) return [];
  let best = Number.NEGATIVE_INFINITY;
  for (const score of yesScores) best = Math.max(best, score);
  return chunks
    .filter((_, index) => yesScores[index] === best)
    .map((chunk) => {
      const identity = evidenceIdentity(chunk.path, chunk.name, chunk.text);
      return { file: chunk.path, line: chunk.line, symbol: chunk.name, hash: identity.hash, id: identity.id };
    });
}

export function chunkSource(filePath: string, text: string, maxTokens = 4000): CodeChunk[] {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const chunks: CodeChunk[] = [];
  for (const statement of source.statements) {
    const named = statementName(statement);
    if (!named) continue;
    chunks.push(...emitChunk(source, filePath, statement, named, named, maxTokens));
  }
  if (chunks.length === 0) {
    const lines = text.length === 0 ? 1 : text.split(/\r?\n/).length;
    chunks.push({
      path: filePath,
      name: path.basename(filePath),
      symbol: path.basename(filePath),
      kind: "function",
      line: 1,
      endLine: lines,
      text,
    });
  }
  return chunks;
}

function emitChunk(
  source: import("typescript").SourceFile,
  filePath: string,
  node: import("typescript").Node,
  name: string,
  symbol: string,
  maxTokens: number,
): CodeChunk[] {
  const chunk = toChunk(source, filePath, node, name, symbol);
  if (estimateTokens(chunk.text) <= maxTokens) return [chunk];
  let inner = innerNodes(node);
  if (inner.length <= 1 && inner[0]) {
    const deeper = innerNodes(inner[0]);
    if (deeper.length > 1) inner = deeper;
  }
  if (inner.length <= 1) return [chunk];
  const parts: CodeChunk[] = [];
  inner.forEach((child, index) => {
    const childName = statementName(child) ?? `${name}#${index + 1}`;
    parts.push(...emitChunk(source, filePath, child, childName, symbol, maxTokens));
  });
  return parts.length > 0 ? parts : [chunk];
}

function statementName(node: import("typescript").Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
        return declaration.name.text;
      }
    }
  }
  if (
    ts.isExportAssignment(node) &&
    (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))
  ) {
    return "default";
  }
  return undefined;
}

function innerNodes(node: import("typescript").Node): import("typescript").Node[] {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
    if (node.body && ts.isBlock(node.body)) return [...node.body.statements];
    return [];
  }
  if (ts.isVariableStatement(node)) {
    const names: import("typescript").Node[] = [];
    for (const declaration of node.declarationList.declarations) {
      if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        names.push(...innerNodes(declaration.initializer));
      }
    }
    return names;
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return [...node.members];
  if (ts.isBlock(node)) return [...node.statements];
  if (ts.isIfStatement(node)) return [node.thenStatement, node.elseStatement].filter((item): item is import("typescript").Statement => Boolean(item));
  if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    return [node.statement];
  }
  if (ts.isExportAssignment(node)) return innerNodes(node.expression);
  return [];
}

function toChunk(
  source: import("typescript").SourceFile,
  filePath: string,
  node: import("typescript").Node,
  name: string,
  symbol: string,
): CodeChunk {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source, false));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    path: filePath,
    name,
    symbol,
    kind: chunkKind(name, node),
    line: start.line + 1,
    endLine: end.line + 1,
    text: node.getText(source),
  };
}

function chunkKind(name: string, node: import("typescript").Node): CodeChunk["kind"] {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "class";
  if (isComponent(name, node)) return "component";
  return "function";
}

function isComponent(name: string, node: import("typescript").Node): boolean {
  return /^[A-Z]/.test(name) || hasJsx(node);
}

function hasJsx(node: import("typescript").Node): boolean {
  let found = false;
  const visit = (current: import("typescript").Node): void => {
    if (found) return;
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function scriptKind(filePath: string): import("typescript").ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
