import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import type { Citation } from "./types.js";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

export interface CodeChunk {
  path: string;
  name: string;
  kind: "function" | "component";
  line: number;
  endLine: number;
  text: string;
}

export function chunkClosure(cwd: string, files: Array<{ path: string }>): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  for (const file of files) {
    const absolute = path.join(cwd, file.path);
    if (!fs.existsSync(absolute)) continue;
    chunks.push(...chunkSource(file.path, fs.readFileSync(absolute, "utf8")));
  }
  return chunks;
}

/** Highest-scoring chunks. Locations are the chunker's file and start line. */
export function evidenceForChunks(chunks: CodeChunk[], yesScores: number[]): Citation[] {
  if (chunks.length === 0) return [];
  let best = Number.NEGATIVE_INFINITY;
  for (const score of yesScores) best = Math.max(best, score);
  return chunks
    .filter((_, index) => yesScores[index] === best)
    .map((chunk) => ({ file: chunk.path, line: chunk.line }));
}

export function chunkSource(filePath: string, text: string): CodeChunk[] {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const chunks: CodeChunk[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      chunks.push(toChunk(source, filePath, statement, statement.name.text));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
          chunks.push(toChunk(source, filePath, declaration, declaration.name.text));
        }
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      chunks.push(toChunk(source, filePath, statement, statement.name.text));
    } else if (
      ts.isExportAssignment(statement) &&
      (ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression))
    ) {
      chunks.push(toChunk(source, filePath, statement, "default"));
    }
  }
  if (chunks.length === 0) {
    const lines = text.length === 0 ? 1 : text.split(/\r?\n/).length;
    chunks.push({
      path: filePath,
      name: path.basename(filePath),
      kind: "function",
      line: 1,
      endLine: lines,
      text,
    });
  }
  return chunks;
}

function toChunk(
  source: import("typescript").SourceFile,
  filePath: string,
  node: import("typescript").Node,
  name: string,
): CodeChunk {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source, false));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  const kind = isComponent(name, node) ? "component" : "function";
  return {
    path: filePath,
    name,
    kind,
    line: start.line + 1,
    endLine: end.line + 1,
    text: node.getText(source),
  };
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
