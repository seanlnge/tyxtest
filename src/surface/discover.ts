import fs from "node:fs";
import path from "node:path";

import { normalizeRel, relativePosix } from "../util/paths.js";
import { hashContent } from "../util/hash.js";
import type { MarkdownConfig } from "../config/types.js";
import { DEFAULT_MARKDOWN_CONFIG, readFrontmatter, readSurfaceDescription, readSurfaceTitle, readTests } from "./surface.js";

export interface Surface {
  name: string;
  description: string;
  dir: string;
  relativeDir: string;
  parentRelativeDir: string | null;
  markdownPath: string;
}

export function discoverSurfaces(cwd: string, markdownOptions: MarkdownConfig = DEFAULT_MARKDOWN_CONFIG): Surface[] {
  const root = path.join(cwd, "tyxtest");
  if (!fs.existsSync(root)) return [];
  const found: Surface[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      const markdownPath = path.join(child, "surface.md");
      if (fs.existsSync(markdownPath)) {
        const markdown = fs.readFileSync(markdownPath, "utf8");
        const frontmatter = readFrontmatter(markdown);
        found.push({
          name: readSurfaceTitle(markdown) || frontmatter.surface || entry.name,
          description: readSurfaceDescription(markdown, markdownOptions) || frontmatter.description || "",
          dir: child,
          relativeDir: relativePosix(root, child),
          parentRelativeDir: null,
          markdownPath,
        });
      }
      walk(child);
    }
  };

  walk(root);
  for (const surface of found) {
    surface.parentRelativeDir = findParent(surface.relativeDir, found);
  }
  return found.sort((left, right) => {
    const depth = left.relativeDir.split("/").length - right.relativeDir.split("/").length;
    if (depth !== 0) return depth;
    return left.relativeDir.localeCompare(right.relativeDir);
  });
}

export function filterSurfaces(surfaces: Surface[], filters: string[] | undefined): Surface[] {
  if (!filters || filters.length === 0) return surfaces;
  const wanted = filters.map((filter) => normalizeRel(filter));
  return surfaces.filter((surface) =>
    wanted.some((filter) => surface.relativeDir === filter || surface.relativeDir.startsWith(`${filter}/`)),
  );
}

export function surfaceContextFor(surface: Surface, surfaces: Surface[], markdownOptions: MarkdownConfig = DEFAULT_MARKDOWN_CONFIG): { text: string; hash: string } {
  const byDir = new Map(surfaces.map((item) => [item.relativeDir, item]));
  const chain: Surface[] = [];
  let current: Surface | undefined = surface;
  while (current) {
    chain.unshift(current);
    current = current.parentRelativeDir ? byDir.get(current.parentRelativeDir) : undefined;
  }
  const text = chain.map((item, index) => [
    `${"#".repeat(index + 1)} ${item.name}`,
    `Surface path: ${item.relativeDir}/`,
    item.description,
    ...(index < chain.length - 1 ? readSurfaceClaims(item.markdownPath, markdownOptions) : []),
  ].filter(Boolean).join("\n")).join("\n\n");
  return { text, hash: hashContent(text) };
}

function readSurfaceClaims(file: string, markdownOptions: MarkdownConfig): string[] {
  const markdown = fs.readFileSync(file, "utf8");
  return readTests(markdown, markdownOptions).flatMap((item) => [item.text, ...(item.notes ? [item.notes] : [])]);
}

function findParent(relativeDir: string, surfaces: Surface[]): string | null {
  const parts = relativeDir.split("/");
  for (let length = parts.length - 1; length >= 1; length -= 1) {
    const candidate = parts.slice(0, length).join("/");
    if (surfaces.some((surface) => surface.relativeDir === candidate)) return candidate;
  }
  return null;
}
