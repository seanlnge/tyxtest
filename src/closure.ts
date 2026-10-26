import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { hashContent } from "./hash.js";
import { isInsideNodeModules, normalizeRel, relativePosix } from "./paths.js";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

export interface ClosureFile {
  path: string;
  hash: string;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

export function hashClosure(files: ClosureFile[]): string {
  const lines = files.map((file) => `${normalizeRel(file.path)} ${file.hash}`).sort();
  return hashContent(lines.join("\n"));
}

export function collectClosure(options: {
  cwd: string;
  entries: string[];
  depth: number | null;
}): { files: ClosureFile[]; closureHash: string } {
  const compilerOptions = loadCompilerOptions(options.cwd);
  const seen = new Set<string>();
  const files: ClosureFile[] = [];

  const walk = (absolutePath: string, hopsLeft: number | null): void => {
    const resolvedPath = path.resolve(absolutePath);
    if (seen.has(resolvedPath)) return;
    if (isInsideNodeModules(resolvedPath)) return;
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) return;
    const extension = path.extname(resolvedPath);
    if (!SOURCE_EXTENSIONS.has(extension)) return;
    seen.add(resolvedPath);

    const bytes = fs.readFileSync(resolvedPath);
    files.push({ path: relativePosix(options.cwd, resolvedPath), hash: hashContent(bytes) });
    if (hopsLeft === 0) return;

    const nextHops = hopsLeft === null ? null : hopsLeft - 1;
    const info = ts.preProcessFile(bytes.toString("utf8"), true, true);
    for (const imported of info.importedFiles) {
      const resolution = ts.resolveModuleName(imported.fileName, resolvedPath, compilerOptions, ts.sys);
      const resolved = resolution.resolvedModule;
      if (!resolved) continue;
      if (resolved.isExternalLibraryImport) continue;
      if (isInsideNodeModules(resolved.resolvedFileName)) continue;
      walk(resolved.resolvedFileName, nextHops);
    }
  };

  for (const entry of options.entries) {
    const absolute = path.isAbsolute(entry) ? entry : path.join(options.cwd, entry);
    if (!fs.existsSync(absolute)) {
      throw new Error(`Entry file not found: ${normalizeRel(entry)}`);
    }
    walk(absolute, options.depth);
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, closureHash: hashClosure(files) };
}

export function computeSurfaceClosure(options: {
  cwd: string;
  entry: string;
  depth: number | null;
  parentClosure: Array<{ path: string }> | null;
}): { files: ClosureFile[]; closureHash: string } {
  const collected = collectClosure({
    cwd: options.cwd,
    entries: [options.entry],
    depth: options.depth,
  });
  if (!options.parentClosure) return collected;

  const allowed = new Set(options.parentClosure.map((file) => normalizeRel(file.path)));
  const entry = normalizeRel(options.entry);
  if (!allowed.has(entry)) {
    throw new Error(`Entry ${entry} is outside the parent surface closure.`);
  }
  const files = collected.files.filter((file) => allowed.has(file.path));
  return { files, closureHash: hashClosure(files) };
}

export function exportedSymbols(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const names = new Set<string>();
  const visit = (node: import("typescript").Node): void => {
    if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression)) names.add(node.expression.text);
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) names.add(element.name.text);
      }
    } else if (hasExportModifier(node)) {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)) &&
        node.name
      ) {
        names.add(node.name.text);
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...names].sort();
}

function hasExportModifier(node: import("typescript").Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function scriptKind(filePath: string): import("typescript").ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function loadCompilerOptions(cwd: string): import("typescript").CompilerOptions {
  const defaults: import("typescript").CompilerOptions = {
    allowJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    esModuleInterop: true,
  };
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) return defaults;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return defaults;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  return { ...defaults, ...parsed.options };
}
