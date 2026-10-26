import fs from "node:fs";
import path from "node:path";

export function loadEnvFile(cwd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  const file = path.join(cwd, ".env");
  if (!fs.existsSync(file)) return merged;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    let key = trimmed.slice(0, separator).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

export function isNonInteractive(env: NodeJS.ProcessEnv, stdinIsTTY: boolean): boolean {
  const ci = env.CI;
  if (typeof ci === "string" && ci !== "0" && ci !== "false" && ci !== "") return true;
  if (env.TYXTEST_NONINTERACTIVE === "1") return true;
  return !stdinIsTTY;
}
