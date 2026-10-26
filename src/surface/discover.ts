import fs from "node:fs";
import path from "node:path";

import { normalizeRel, relativePosix } from "../util/paths.js";
import { readFrontmatter } from "./surface.js";

export interface Surface {
  name: string;
  description: string;
  entry?: string;
  dir: string;
  relativeDir: string;
  parentRelativeDir: string | null;
  markdownPath: string;
}

export function discoverSurfaces(cwd: string): Surface[] {
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
        const frontmatter = readFrontmatter(fs.readFileSync(markdownPath, "utf8"));
        found.push({
          name: frontmatter.surface || entry.name,
          description: frontmatter.description || "",
          entry: frontmatter.entry,
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

function findParent(relativeDir: string, surfaces: Surface[]): string | null {
  const parts = relativeDir.split("/");
  for (let length = parts.length - 1; length >= 1; length -= 1) {
    const candidate = parts.slice(0, length).join("/");
    if (surfaces.some((surface) => surface.relativeDir === candidate)) return candidate;
  }
  return null;
}
