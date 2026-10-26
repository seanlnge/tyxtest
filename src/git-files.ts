import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const INDEX_MERGE_RULE = "tyxtest/**/.index.json merge=ours";

export function ensureEnvGitignore(cwd: string): void {
  ensureLines(path.join(cwd, ".gitignore"), [".env", ".tyxtest/"]);
}

export function ensureIndexMergeAttributes(cwd: string): void {
  const file = path.join(cwd, ".gitattributes");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const already = existing.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === INDEX_MERGE_RULE || (trimmed.includes(".index.json") && trimmed.includes("merge=ours"));
  });
  if (already) return;
  const block = `# tyxtest index files merge like a lockfile\n${INDEX_MERGE_RULE}\n`;
  if (existing.length === 0) {
    fs.writeFileSync(file, block);
    return;
  }
  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  fs.writeFileSync(file, `${prefix}${block}`);
}

export function ensureOursMergeDriver(cwd: string): void {
  if (!fs.existsSync(path.join(cwd, ".git"))) return;
  try {
    execFileSync("git", ["config", "--local", "merge.ours.driver", "true"], { cwd, stdio: "ignore" });
  } catch {
    // The attributes rule is still written when git config is unavailable.
  }
}

function ensureLines(file: string, lines: string[]): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) return;
  let next = existing;
  if (next.length > 0 && !next.endsWith("\n")) next += "\n";
  next += `${missing.join("\n")}\n`;
  fs.writeFileSync(file, next);
}
