import fs from "node:fs";
import path from "node:path";

import { hashContent } from "../util/hash.js";

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

export function hashLockfiles(cwd: string): string {
  const parts: string[] = [];
  for (const name of LOCKFILES) {
    const file = path.join(cwd, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    parts.push(`${name}\0${hashContent(fs.readFileSync(file))}`);
  }
  return hashContent(parts.join("\n"));
}
