import path from "node:path";

export function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
}

export function relativePosix(root: string, file: string): string {
  return normalizeRel(path.relative(root, file));
}

export function isInsideNodeModules(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").includes("node_modules");
}
