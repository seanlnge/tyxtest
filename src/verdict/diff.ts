import { execFileSync } from "node:child_process";

import { normalizeRel } from "../util/paths.js";

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

export function changedFiles(cwd: string, baseRef: string): { files: Set<string>; lockfileChanged: boolean } {
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "--name-only", "--relative", baseRef], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      `ignoreUnchanged could not diff against ${baseRef}. Set baseRef to a ref that exists, or set ignoreUnchanged to false.`,
    );
  }
  let untracked = "";
  try {
    untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    untracked = "";
  }
  const files = new Set(
    `${diff}\n${untracked}`
      .split(/\r?\n/)
      .map((line) => normalizeRel(line.trim()))
      .filter((line) => line.length > 0),
  );
  return { files, lockfileChanged: LOCKFILES.some((name) => files.has(name)) };
}

/** Unified diff of the named paths against baseRef. Empty when git cannot produce one. */
export function diffPatch(cwd: string, baseRef: string, paths: string[]): string {
  if (paths.length === 0) return "";
  try {
    const patch = execFileSync("git", ["diff", "--relative", "--unified=3", baseRef, "--", ...paths], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1_000_000,
    });
    return patch.length > 20_000 ? `${patch.slice(0, 20_000)}\n…` : patch;
  } catch {
    return "";
  }
}

/** Old path to new path for renames reported by `git diff -M`. */
export function renamedPaths(cwd: string, baseRef: string): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const args of [
    ["diff", "-M", "--name-status", "--relative", baseRef],
    ["diff", "-M", "--name-status", "--relative", "HEAD"],
  ]) {
    let text = "";
    try {
      text = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line);
      if (!match) continue;
      renamed.set(normalizeRel(unquoteGitPath(match[1])), normalizeRel(unquoteGitPath(match[2])));
    }
  }
  return renamed;
}

function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export function affectsTest(input: {
  changed: Set<string>;
  lockfileChanged: boolean;
  closurePaths: string[];
  surfacePath: string;
}): boolean {
  if (input.lockfileChanged) return true;
  if (input.changed.has(normalizeRel(input.surfacePath))) return true;
  return input.closurePaths.some((file) => input.changed.has(normalizeRel(file)));
}
