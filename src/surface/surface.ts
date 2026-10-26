import fs from "node:fs";

import { readText, writeText } from "../util/fs-util.js";
import { hashContent } from "../util/hash.js";

export interface TestCase {
  id: string;
  text: string;
}

interface ParsedLine {
  id: string | null;
  text: string;
}

const WITH_ID = /^\s*[-*]\s+\[([A-Za-z0-9][A-Za-z0-9_-]*)\]\s*(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;

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

export function backfillTestIds(markdown: string): { markdown: string; tests: TestCase[]; changed: boolean } {
  const { body, frontmatterRaw, newline } = splitDocument(markdown);
  const lines = body.split(/\r?\n/);
  const used = new Set<string>();
  for (const line of lines) {
    const parsed = parseTestLine(line);
    if (parsed?.id) used.add(parsed.id);
  }

  const tests: TestCase[] = [];
  let changed = false;
  const updatedLines = lines.map((line) => {
    const parsed = parseTestLine(line);
    if (!parsed) return line;
    if (parsed.id) {
      tests.push({ id: parsed.id, text: parsed.text });
      return line;
    }
    const id = uniqueHash(parsed.text, used);
    used.add(id);
    tests.push({ id, text: parsed.text });
    changed = true;
    const bullet = /^([ \t]*[-*][ \t]+)(.*)$/.exec(line);
    return bullet ? `${bullet[1]}[${id}] ${parsed.text}` : line;
  });
  const updatedBody = updatedLines.join(newline);
  return { markdown: changed ? `${frontmatterRaw}${updatedBody}` : markdown, tests, changed };
}

export function backfillSurfaceFile(filePath: string): { changed: boolean; tests: TestCase[] } {
  const original = readText(filePath);
  const result = backfillTestIds(original);
  if (result.changed) fs.writeFileSync(filePath, result.markdown);
  return { changed: result.changed, tests: result.tests };
}

export function readTests(markdown: string): TestCase[] {
  return backfillTestIds(markdown).tests;
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

function uniqueHash(text: string, used: Set<string>): string {
  const base = testIdFor(text);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function parseTestLine(line: string): ParsedLine | null {
  const withId = WITH_ID.exec(line);
  if (withId) return { id: withId[1], text: withId[2] };
  const bullet = BULLET.exec(line);
  if (!bullet) return null;
  return { id: null, text: bullet[1] };
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
