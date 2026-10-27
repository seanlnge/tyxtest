import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import type { Citation } from "../config/types.js";
import { hashContent } from "../util/hash.js";
import { normalizeRel } from "../util/paths.js";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

export interface CodeChunk {
  path: string;
  name: string;
  /** Outermost function, component, or class this chunk belongs to. */
  symbol: string;
  kind: "function" | "component" | "class" | "constant";
  line: number;
  endLine: number;
  /** Source span rendered for a split focus chunk. */
  sourceLine?: number;
  sourceEndLine?: number;
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

/** Keeps chunks whose function, component, class, or constant is one of `refs`. */
export function selectChunks(chunks: CodeChunk[], refs: Array<{ path: string; symbol: string }>): CodeChunk[] {
  const wanted = new Set(refs.map((ref) => `${normalizeRel(ref.path)}#${ref.symbol}`));
  return chunks.filter(
    (chunk) =>
      wanted.has(`${normalizeRel(chunk.path)}#${chunk.name}`) || wanted.has(`${normalizeRel(chunk.path)}#${chunk.symbol}`),
  );
}

export function chunkClosure(cwd: string, files: Array<{ path: string }>, maxTokens = 4000): CodeChunk[] {
  const texts = new Map<string, string>();
  for (const file of files) {
    const absolute = path.join(cwd, file.path);
    if (!fs.existsSync(absolute)) continue;
    texts.set(normalizeRel(file.path), fs.readFileSync(absolute, "utf8"));
  }
  const chunks: CodeChunk[] = [];
  for (const [filePath, text] of texts) chunks.push(...chunkSource(filePath, text, maxTokens, texts));
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

export function chunkSource(
  filePath: string,
  text: string,
  maxTokens = 4000,
  files?: Map<string, string>,
  includeBindings = true,
): CodeChunk[] {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const bindings = includeBindings ? collectBindings(source, filePath, files) : new Map<string, string>();
  const chunks: CodeChunk[] = [];
  let needsFileContext = false;
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source);
        // Keep the complete declaration list, including its evaluation order.
        const parts = emitChunk(source, filePath, statement, name, name, maxTokens, bindings);
        if (statement.declarationList.declarations.length > 1) {
          for (const part of parts) {
            part.line = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
            part.endLine = source.getLineAndCharacterOfPosition(declaration.getEnd()).line + 1;
          }
        }
        chunks.push(...parts);
      }
      continue;
    }
    const named = statementName(statement);
    if (named) chunks.push(...emitChunk(source, filePath, statement, named, named, maxTokens, bindings));
    else if (
      !ts.isImportDeclaration(statement) &&
      !ts.isImportEqualsDeclaration(statement) &&
      !ts.isExportDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement)
    ) {
      needsFileContext = true;
    }
  }
  // Module-level effects can depend on declarations and on one another's order.
  if (needsFileContext || chunks.length === 0) {
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
  bindings: Map<string, string>,
): CodeChunk[] {
  const chunk = toChunk(source, filePath, node, name, symbol, bindings);
  if (estimateTokens(chunk.text) <= maxTokens) return [chunk];
  if (ts.isVariableStatement(node) && node.declarationList.declarations.length > 1) return [chunk];
  const inner = innerNodes(node);
  if (inner.length <= 1) return [chunk];
  // These are focus slices, not independently executable fragments. Removing
  // siblings or wrappers can change guards, early returns, bindings, or class
  // initialization. Retain the full context even when it exceeds the size cap.
  return inner.map((child, index) => {
    const childName = statementName(child) ?? `${name}#${index + 1}`;
    return { ...toChunk(source, filePath, child, childName, symbol, bindings), kind: chunk.kind, text: chunk.text, sourceLine: chunk.line, sourceEndLine: chunk.endLine };
  });
}

/** Exact selectable declarations and legacy focus aliases, without inferred dependencies. */
export function indexableSymbols(filePath: string, text: string, maxTokens = 4000): Array<{ symbol: string; chars: number; line: number; endLine: number; fileContext: boolean }> {
  const symbols = new Map<string, { symbol: string; chars: number; line: number; endLine: number; fileContext: boolean }>();
  for (const chunk of [...chunkSource(filePath, text, Infinity, undefined, false), ...chunkSource(filePath, text, maxTokens, undefined, false)]) {
    if (!chunk.text.trim() || symbols.has(chunk.name)) continue;
    symbols.set(chunk.name, { symbol: chunk.name, chars: chunk.text.length, line: chunk.sourceLine ?? chunk.line,
      endLine: chunk.sourceEndLine ?? chunk.endLine, fileContext: chunk.name === path.basename(filePath) });
  }
  return [...symbols.values()];
}

function statementName(node: import("typescript").Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  ) {
    return "default";
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
  if (ts.isExportAssignment(node)) return innerNodes(node.expression);
  return [];
}

function toChunk(
  source: import("typescript").SourceFile,
  filePath: string,
  node: import("typescript").Node,
  name: string,
  symbol: string,
  bindings: Map<string, string>,
): CodeChunk {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source, false));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  const own =
    ts.isVariableDeclaration(node) && bindings.has(name) ? (bindings.get(name) ?? node.getText(source)) : node.getText(source);
  const constants = constantsFor(node, bindings).filter((declaration) => declaration !== own);
  return {
    path: filePath,
    name,
    symbol,
    kind: chunkKind(name, node),
    line: start.line + 1,
    endLine: end.line + 1,
    text: constants.length > 0 ? `${own}\n\n${constants.join("\n")}` : own,
  };
}

function chunkKind(name: string, node: import("typescript").Node): CodeChunk["kind"] {
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations.find((item) => item.name.getText() === name);
    if (declaration) return chunkKind(name, declaration);
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "class";
  if (ts.isVariableDeclaration(node) && (!node.initializer || !isFunctionInit(node.initializer))) return "constant";
  if (isComponent(name, node)) return "component";
  return "function";
}

function isFunctionInit(node: import("typescript").Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
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

function collectBindings(
  source: import("typescript").SourceFile,
  filePath: string,
  files: Map<string, string> | undefined,
): Map<string, string> {
  const bindings = new Map<string, string>();
  if (files) {
    for (const [local, declaration] of importedConstants(source, filePath, files)) bindings.set(local, declaration);
  }
  for (const record of constantRecords(source)) bindings.set(record.name, record.text);
  return bindings;
}

function constantRecords(source: import("typescript").SourceFile): Array<{ name: string; text: string; exported: boolean }> {
  const records: Array<{ name: string; text: string; exported: boolean }> = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const keyword =
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
        ? "const"
        : (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
          ? "let"
          : "var";
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || isFunctionInit(declaration.initializer)) continue;
      const text =
        statement.declarationList.declarations.length === 1 ? statement.getText(source) : `${keyword} ${declaration.getText(source)}`;
      records.push({ name: declaration.name.text, text, exported });
    }
  }
  return records;
}

function importedConstants(
  source: import("typescript").SourceFile,
  filePath: string,
  files: Map<string, string>,
): Map<string, string> {
  const imported = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    const resolved = resolveModule(filePath, specifier, files);
    if (!resolved) continue;
    const exported = exportedConstants(resolved, files, new Set());
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) {
      const declaration = exported.get("default");
      if (declaration) imported.set(clause.name.text, declaration);
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const spec of clause.namedBindings.elements) {
        const importedName = (spec.propertyName ?? spec.name).text;
        const declaration = exported.get(importedName);
        if (declaration) imported.set(spec.name.text, declaration);
      }
    }
  }
  return imported;
}

function exportedConstants(filePath: string, files: Map<string, string>, seen: Set<string>): Map<string, string> {
  const key = normalizeRel(filePath);
  if (seen.has(key)) return new Map();
  seen.add(key);
  const text = files.get(key);
  if (text === undefined) return new Map();
  const source = ts.createSourceFile(key, text, ts.ScriptTarget.Latest, true, scriptKind(key));
  const exported = new Map<string, string>();
  for (const record of constantRecords(source)) {
    if (record.exported) exported.set(record.name, record.text);
  }
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    const resolved = resolveModule(key, statement.moduleSpecifier.text, files);
    if (!resolved) continue;
    const inner = exportedConstants(resolved, files, seen);
    for (const spec of statement.exportClause.elements) {
      const importedName = (spec.propertyName ?? spec.name).text;
      const declaration = inner.get(importedName);
      if (declaration) exported.set(spec.name.text, declaration);
    }
  }
  return exported;
}

function resolveModule(fromFile: string, specifier: string, files: Map<string, string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile.replaceAll("\\", "/")), specifier));
  const stem = base.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`, `${stem}.mjs`, `${stem}/index.ts`, `${stem}/index.tsx`, `${stem}/index.js`];
  return candidates.find((candidate) => files.has(normalizeRel(candidate)));
}

function constantsFor(node: import("typescript").Node, bindings: Map<string, string>): string[] {
  const declared = declaredNames(node);
  const needed = new Set<string>();
  const visit = (current: import("typescript").Node): void => {
    if (ts.isIdentifier(current) && isValueReference(current) && bindings.has(current.text) && !declared.has(current.text)) {
      needed.add(current.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  const included = new Set<string>();
  const texts: string[] = [];
  const queue = [...needed];
  while (queue.length > 0) {
    const name = queue.pop();
    if (!name || included.has(name)) continue;
    const declaration = bindings.get(name);
    if (!declaration) continue;
    included.add(name);
    texts.push(declaration);
    for (const reference of identifierNames(declaration)) {
      if (reference !== name && bindings.has(reference) && !included.has(reference)) queue.push(reference);
    }
  }
  return texts;
}

function identifierNames(text: string): string[] {
  const source = ts.createSourceFile("constant.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const visit = (current: import("typescript").Node): void => {
    if (ts.isIdentifier(current) && isValueReference(current)) names.push(current.text);
    ts.forEachChild(current, visit);
  };
  visit(source);
  return names;
}

function declaredNames(node: import("typescript").Node): Set<string> {
  const names = new Set<string>();
  const visit = (current: import("typescript").Node): void => {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) names.add(current.name.text);
    if (ts.isParameter(current) && ts.isIdentifier(current.name)) names.add(current.name.text);
    if (
      (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      names.add(current.name.text);
    }
    if (ts.isBindingElement(current) && ts.isIdentifier(current.name)) names.add(current.name.text);
    if (ts.isCatchClause(current) && current.variableDeclaration && ts.isIdentifier(current.variableDeclaration.name)) {
      names.add(current.variableDeclaration.name.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

function isValueReference(node: import("typescript").Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isMethodDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return true;
}

function scriptKind(filePath: string): import("typescript").ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
