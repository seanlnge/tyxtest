import fs from "node:fs";
import { fromMarkdown } from "mdast-util-from-markdown";

import type { MarkdownConfig } from "../config/types.js";
import { readText, writeText } from "../util/fs-util.js";
import { hashContent } from "../util/hash.js";

export interface TestCase {
  id: string;
  text: string;
  notes?: string;
}

export const DEFAULT_MARKDOWN_CONFIG: MarkdownConfig = { testDiscovery: { mode: "headings", headingLevel: 2, prefix: null } };

interface ParsedLine {
  text: string;
}

const WITH_ID = /^[-*+]\s+\[([A-Za-z0-9][A-Za-z0-9_-]*)\]\s*(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "test";
}

/** Stable id for a claim the user wrote without a bracket id. */
export function testIdFor(text: string): string {
  return hashContent(text.trim()).slice(0, 12);
}

export function backfillTestIds(markdown: string, options: MarkdownConfig = DEFAULT_MARKDOWN_CONFIG): { markdown: string; tests: TestCase[]; changed: boolean } {
  return { markdown, tests: readTests(markdown, options), changed: false };
}

export function backfillSurfaceFile(filePath: string, options: MarkdownConfig = DEFAULT_MARKDOWN_CONFIG): { changed: boolean; tests: TestCase[] } {
  const original = readText(filePath);
  const result = backfillTestIds(original, options);
  if (result.changed) fs.writeFileSync(filePath, result.markdown);
  return { changed: result.changed, tests: result.tests };
}

export function readTests(markdown: string, options: MarkdownConfig = DEFAULT_MARKDOWN_CONFIG): TestCase[] {
  const discovery = options.testDiscovery;
  return discovery.mode === "bullets" ? parseBulletTests(markdown, discovery.prefix) : parseHeadingTests(markdown, discovery.headingLevel, discovery.prefix);
}

function parseBulletTests(markdown: string, prefix: string | null): TestCase[] {
  const { body } = splitDocument(markdown);
  const lines = body.split(/\r?\n/);
  const tree = fromMarkdown(body);
  const topLevelItems = new Map<number, ParsedLine & { legacyId?: string }>();
  for (const node of tree.children) {
    if (node.type !== "list" || node.ordered) continue;
    for (const item of node.children) if (item.type === "listItem") topLevelItems.set(item.position!.start.line, bulletItem(item, prefix));
  }
  const parsed: Array<{ text: string; legacyId?: string; notes: string[] }> = [];
  let current: (typeof parsed)[number] | undefined;
  let noteFence: { character: string; length: number } | undefined;
  let documentFence: { character: string; length: number } | undefined;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    const continuation = indent.length > 0;
    const content = continuation ? line.slice(indent.startsWith("\t") ? 1 : Math.min(2, indent.length)) : line;
    const marker = /^(`{3,}|~{3,})/.exec(content)?.[1];
    if (documentFence) {
      if (marker && marker[0] === documentFence.character && marker.length >= documentFence.length && content.trim() === marker) documentFence = undefined;
      continue;
    }
    if (noteFence) {
      if (current) current.notes.push(content);
      if (marker && marker[0] === noteFence.character && marker.length >= noteFence.length && content.trim() === marker) noteFence = undefined;
      continue;
    }
    if (marker) {
      if (continuation && current) {
        current.notes.push(content);
        noteFence = { character: marker[0], length: marker.length };
      } else {
        current = undefined;
        documentFence = { character: marker[0], length: marker.length };
      }
      continue;
    }
    const candidate = continuation || !topLevelItems.has(lineIndex + 1) ? null
      : prefix === null ? parseTestLine(line) : topLevelItems.get(lineIndex + 1)!;
    const test = candidate ? filterPrefix(candidate, prefix, "bullet") : null;
    if (test) {
      current = { text: test.text, legacyId: test.legacyId, notes: [] };
      parsed.push(current);
    } else if (current && continuation) {
      current.notes.push(content);
    } else if (current && line === "" && current.notes.length > 0) {
      current.notes.push("");
    } else if (line.trim()) {
      current = undefined;
    }
  }
  const used = new Map<string, number>();
  return parsed.map(({ text, legacyId, notes }) => {
    while (notes.length && notes[notes.length - 1] === "") notes.pop();
    const noteText = notes.join("\n");
    const persistedLegacyId = legacyId && !noteText ? legacyId : undefined;
    const baseId = persistedLegacyId ?? testIdFor(noteText ? `${text.trim()}\n${noteText}` : text);
    const count = persistedLegacyId ? 1 : (used.get(baseId) ?? 0) + 1;
    if (!persistedLegacyId) used.set(baseId, count);
    return {
      id: count === 1 ? baseId : `${baseId}-${count}`,
      text,
      ...(noteText ? { notes: noteText } : {}),
    };
  });
}

export function readFrontmatter(markdown: string): Record<string, string> {
  const lines = frontmatterLines(markdown);
  const data: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    data[match[1]] = match[2].trim();
  }
  return data;
}

export function readSurfaceTitle(markdown: string): string | undefined {
  const { body } = splitDocument(markdown);
  const tree = fromMarkdown(body);
  for (const node of tree.children) {
    if (node.type === "heading" && node.depth === 1) return inlineText(node).replace(/\r?\n/g, " ").trim() || undefined;
  }
  return undefined;
}

export function readSurfaceDescription(markdown: string, options: MarkdownConfig = DEFAULT_MARKDOWN_CONFIG): string | undefined {
  const { body } = splitDocument(markdown);
  const tree = fromMarkdown(body);
  const titleIndex = tree.children.findIndex((node) => node.type === "heading" && node.depth === 1);
  if (titleIndex < 0) return undefined;
  const start = tree.children[titleIndex]!.position!.end.offset!;
  const discovery = options.testDiscovery;
  const subsequent = tree.children.slice(titleIndex + 1);
  const boundaryOffsets = subsequent.flatMap((node) => {
    if (node.type === "heading" && (node.depth === 1 || (discovery.mode === "headings" && node.depth === discovery.headingLevel && matchesPrefix(inlineText(node).replace(/\r?\n/g, " ").trim(), discovery.prefix)))) return [node.position!.start.offset!];
    if (discovery.mode === "bullets" && node.type === "list" && !node.ordered) {
      const item = node.children.find((child) => child.type === "listItem" && matchesPrefix(bulletItem(child, discovery.prefix).text, discovery.prefix));
      if (item) return [item.position!.start.offset!];
    }
    return [];
  });
  const end = boundaryOffsets.length ? Math.min(...boundaryOffsets) : body.length;
  return trimBlankLines(body.slice(start, end).replace(/\r\n/g, "\n")) || undefined;
}

function matchesPrefix(text: string, prefix: string | null): boolean {
  return prefix === null || text.startsWith(prefix) || text === prefix.trimEnd();
}

function bulletItem(item: { children?: unknown[] }, prefix: string | null): ParsedLine & { legacyId?: string } {
  const first = item.children?.[0] as { type?: string; children?: unknown[] } | undefined;
  const paragraph = first?.type === "paragraph" ? first : undefined;
  const text = paragraph ? inlineText(paragraph).split(/\r?\n/, 1)[0]!.trim() : "";
  if (prefix !== null && matchesPrefix(text, prefix)) return { text };
  const legacy = /^\[([A-Za-z0-9][A-Za-z0-9_-]*)\]\s*(.*)$/.exec(text);
  return legacy ? { legacyId: legacy[1], text: legacy[2] } : { text };
}

function parseHeadingTests(markdown: string, level: number, prefix: string | null): TestCase[] {
  const body = splitDocument(markdown).body.replace(/\r\n/g, "\n");
  const tree = fromMarkdown(body);
  const headings = tree.children.flatMap((node, index) => node.type === "heading" && node.depth === level ? [{ node, index }] : []);
  const used = new Map<string, number>();
  return headings.flatMap(({ node, index }) => {
    const start = node.position!.end.offset!;
    const boundary = tree.children.slice(index + 1).find((child) => child.type === "heading" && child.depth! <= level);
    const end = boundary?.position?.start.offset ?? body.length;
    const notes = trimBlankLines(body.slice(start, end));
    const candidate = { text: inlineText(node).replace(/\r?\n/g, " ").trim() };
    if (!matchesPrefix(candidate.text, prefix)) return [];
    if (!candidate.text) throw new Error("Test headings must contain readable text.");
    const text = prefix ? candidate.text.slice(prefix.length).trim() : candidate.text;
    if (!text) throw new Error("Selected test heading has an empty label after prefix removal.");
    const baseId = testIdFor(notes ? `${text}\n${notes}` : text);
    const count = (used.get(baseId) ?? 0) + 1;
    used.set(baseId, count);
    return [{ id: count === 1 ? baseId : `${baseId}-${count}`, text, ...(notes ? { notes } : {}) }];
  });
}

function filterPrefix<T extends ParsedLine>(item: T, prefix: string | null, kind: "bullet"): T | null {
  if (!prefix) return item;
  if (!matchesPrefix(item.text, prefix)) return null;
  const text = item.text.slice(prefix.length).trim();
  if (!text) throw new Error(`Selected test ${kind} has an empty label after prefix removal.`);
  return { ...item, text };
}

function trimBlankLines(value: string): string {
  return value.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
}

function inlineText(node: { children?: unknown[] }): string {
  return (node.children ?? []).map((child) => {
    if (!child || typeof child !== "object") return "";
    const item = child as { type?: string; value?: string; alt?: string; children?: unknown[] };
    if (item.type === "text" || item.type === "inlineCode") return item.value ?? "";
    if (item.type === "image") return item.alt ?? "";
    if (item.children) return inlineText(item);
    return "";
  }).join("");
}

export function setFrontmatterField(markdown: string, key: string, value: string): string {
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const hasFence = lines[0] === "---";
  const end = hasFence ? lines.indexOf("---", 1) : -1;
  if (!hasFence || end < 0) {
    const prefix = `---${newline}${key}: ${value}${newline}---${newline}${newline}`;
    return `${prefix}${markdown}`;
  }
  const keyPattern = new RegExp(`^${key}:\\s*(.*)$`);
  for (let index = 1; index < end; index += 1) {
    const match = keyPattern.exec(lines[index]);
    if (!match) continue;
    if (match[1].trim() === value) return markdown;
    lines[index] = `${key}: ${value}`;
    return lines.join(newline);
  }
  lines.splice(end, 0, `${key}: ${value}`);
  return lines.join(newline);
}

export function writeSurface(filePath: string, markdown: string): void {
  writeText(filePath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

function parseTestLine(line: string): (ParsedLine & { legacyId?: string }) | null {
  const withId = WITH_ID.exec(line);
  if (withId) return { legacyId: withId[1], text: withId[2] };
  const bullet = BULLET.exec(line);
  if (!bullet) return null;
  return { text: bullet[1] };
}

function splitDocument(markdown: string): { frontmatterRaw: string; body: string; newline: string } {
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") return { frontmatterRaw: "", body: markdown, newline };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { frontmatterRaw: "", body: markdown, newline };
  const frontmatterRaw = `${lines.slice(0, end + 1).join(newline)}${newline}`;
  const body = lines.slice(end + 1).join(newline);
  return { frontmatterRaw, body, newline };
}

function frontmatterLines(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") return [];
  const end = lines.indexOf("---", 1);
  if (end < 0) return [];
  return lines.slice(1, end);
}
