import fs from "node:fs";
import path from "node:path";

export const PENDING_GITIGNORE = "tyxtest/.pending.json";

export function ensureEnvGitignore(cwd: string): void {
  ensureLines(path.join(cwd, ".gitignore"), [".env", ".tyxtest/", PENDING_GITIGNORE]);
}

export function ensureIndexMergeAttributes(cwd: string): void {
  const file = path.join(cwd, ".gitattributes");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = existing.split(/\r?\n/).flatMap((line) => {
    if (line.trim() === "# tyxtest index files merge like a lockfile") return [];
    const rule = /^([ \t]*(?:"[^"]+"|\S+))[ \t]+(.*)$/.exec(line);
    if (!rule) return [line];
    const pattern = rule[1]!.trim().replace(/^"(.*)"$/, "$1");
    if (!/^\/?tyxtest\/(?:\*\*\/)?\.index\.json$/.test(pattern)) return [line];
    const attributes = rule[2]!.split(/[ \t]+/).filter(Boolean);
    if (!attributes.includes("merge=ours")) return [line];
    const remaining = attributes.filter((attribute) => attribute !== "merge=ours");
    return remaining.length ? [`${rule[1]} ${remaining.join(" ")}`] : [];
  });
  const next = lines.join("\n").replace(/\n*$/, "\n");
  if (next !== (existing ? existing.replace(/\r\n/g, "\n").replace(/\n*$/, "\n") : "")) {
    if (!next.trim()) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, next);
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
