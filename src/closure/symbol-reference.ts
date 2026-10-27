import { createRequire } from "node:module";
import path from "node:path";

import type { IndexedChunk } from "../surface/index-file.js";
import { normalizeRel } from "../util/paths.js";
import type { indexableSymbols } from "./chunk.js";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

/** Undefined is unsafe/ambiguous; null is absent (including a completed export cycle). */
type Resolution = IndexedChunk | null | undefined;

/** Resolve only the provenance of an explicitly selected binding, never its dependencies. */
export function createImportedChunkResolver(
  cwd: string,
  texts: Map<string, string>,
  inventory: Map<string, ReturnType<typeof indexableSymbols>>,
): (ref: IndexedChunk) => IndexedChunk | null {
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
  const compilerOptions = configPath
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, path.dirname(configPath)).options
    : { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
  const sources = new Map<string, import("typescript").SourceFile>();
  const sourceFor = (file: string) => {
    let source = sources.get(file);
    if (!source && texts.has(file)) {
      source = ts.createSourceFile(file, texts.get(file)!, ts.ScriptTarget.Latest, true);
      sources.set(file, source);
    }
    return source;
  };
  const selectable = (file: string, symbol: string): IndexedChunk | undefined =>
    inventory.get(file)?.some((item) => item.symbol === symbol && !item.fileContext) ? { path: file, symbol } : undefined;
  const moduleFile = (file: string, specifier: string): string | undefined => {
    const resolved = ts.resolveModuleName(specifier, path.resolve(cwd, file), compilerOptions, ts.sys).resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport) return undefined;
    const relative = normalizeRel(path.relative(cwd, resolved.resolvedFileName));
    return texts.has(relative) && inventory.has(relative) ? relative : undefined;
  };
  const unique = (items: Resolution[]): Resolution => {
    if (items.some((item) => item === undefined)) return undefined;
    const refs = new Map(items.filter((item): item is IndexedChunk => Boolean(item)).map((item) => [`${item.path}\0${item.symbol}`, item]));
    return refs.size > 1 ? undefined : refs.values().next().value ?? null;
  };
  const bindingNames = (name: import("typescript").BindingName): string[] => ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));

  const imported = (file: string, name: string, seen: Set<string>): Resolution => {
    const source = sourceFor(file);
    if (!source) return undefined;
    const matches: Resolution[] = [];
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
      const clause = statement.importClause;
      const bindings = clause.namedBindings;
      const specifiers = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => item.name.text === name) : [];
      const isDefault = clause.name?.text === name;
      if (!isDefault && !specifiers.length) continue;
      const target = moduleFile(file, statement.moduleSpecifier.text);
      if (!target || clause.isTypeOnly) { matches.push(undefined); continue; }
      if (isDefault) matches.push(exported(target, "default", seen));
      for (const specifier of specifiers) matches.push(specifier.isTypeOnly ? undefined : exported(target, (specifier.propertyName ?? specifier.name).text, seen));
    }
    return matches.length > 1 ? undefined : matches[0] ?? (matches.length ? undefined : null);
  };

  const local = (file: string, name: string, seen: Set<string>): Resolution => {
    const source = sourceFor(file);
    if (!source || source.isDeclarationFile) return undefined;
    const declarations: Resolution[] = [];
    for (const statement of source.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
        if (ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) { declarations.push(undefined); continue; }
        if (ts.isFunctionDeclaration(statement) && !statement.body) continue;
        declarations.push(selectable(file, name));
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) if (bindingNames(declaration.name).includes(name)) {
          declarations.push(declaration.initializer ? selectable(file, declaration.name.getText(source)) : undefined);
        }
      } else if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name.text === name) {
        declarations.push(undefined);
      }
    }
    return declarations.length ? unique(declarations) : imported(file, name, seen);
  };

  const exported = (file: string, name: string, seen: Set<string>): Resolution => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return null;
    const nextSeen = new Set([...seen, key]);
    const source = sourceFor(file);
    if (!source || source.isDeclarationFile) return undefined;
    const direct: Resolution[] = [];
    const stars: Resolution[] = [];
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? moduleFile(file, statement.moduleSpecifier.text) : undefined;
        if (!statement.exportClause) {
          if (name !== "default" && !statement.isTypeOnly) stars.push(target ? exported(target, name, nextSeen) : undefined);
        } else if (ts.isNamedExports(statement.exportClause)) {
          for (const specifier of statement.exportClause.elements) if (specifier.name.text === name) {
            const original = (specifier.propertyName ?? specifier.name).text;
            direct.push(statement.isTypeOnly || specifier.isTypeOnly ? undefined : statement.moduleSpecifier
              ? target ? exported(target, original, nextSeen) : undefined
              : local(file, original, nextSeen));
          }
        } else if (statement.exportClause.name.text === name) direct.push(undefined);
        continue;
      }
      if (name === "default" && ts.isExportAssignment(statement) && !statement.isExportEquals) {
        direct.push(ts.isIdentifier(statement.expression) ? local(file, statement.expression.text, nextSeen)
          : ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression) ? selectable(file, "default") : undefined);
        continue;
      }
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (isDefault) {
        if (name === "default") direct.push((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
          ? statement.name ? local(file, statement.name.text, nextSeen) : selectable(file, "default") : undefined);
      } else if (ts.isVariableStatement(statement)) {
        if (statement.declarationList.declarations.some((declaration) => bindingNames(declaration.name).includes(name))) direct.push(local(file, name, nextSeen));
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name?.text === name) {
        direct.push(local(file, name, nextSeen));
      }
    }
    if (direct.length) return direct.some((ref) => ref === null) ? undefined : unique(direct);
    return unique(stars);
  };

  return (ref) => {
    if (!texts.has(ref.path) || !inventory.has(ref.path)) return null;
    if (inventory.get(ref.path)!.some((item) => item.symbol === ref.symbol)) return ref;
    const resolved = imported(ref.path, ref.symbol, new Set());
    return (resolved === null ? exported(ref.path, ref.symbol, new Set()) : resolved) ?? null;
  };
}
