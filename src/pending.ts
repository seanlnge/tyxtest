import fs from "node:fs";
import path from "node:path";

import { isCi } from "./env.js";
import { readText, writeText } from "./fs-util.js";
import { prettyJson } from "./json.js";

export interface PendingSuggestion {
  surface: string;
  testId: string;
  reason: string;
  detail?: string;
}

export function pendingPath(cwd: string): string {
  return path.join(cwd, "tyxtest", ".pending.json");
}

export function pendingWarning(surface: string, testId: string): string {
  return `${surface}/${testId}: index may be stale; run \`tyxtest index --pending\`.`;
}

export function readPending(cwd: string): PendingSuggestion[] {
  const file = pendingPath(cwd);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readText(file)) as { suggestions?: unknown };
    if (!parsed || !Array.isArray(parsed.suggestions)) return [];
    return parsed.suggestions.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.surface !== "string" || typeof record.testId !== "string") return [];
      const suggestion: PendingSuggestion = {
        surface: record.surface,
        testId: record.testId,
        reason: typeof record.reason === "string" ? record.reason : "index may be stale",
      };
      if (typeof record.detail === "string" && record.detail.trim()) suggestion.detail = record.detail;
      return [suggestion];
    });
  } catch {
    return [];
  }
}

export function addPending(cwd: string, suggestion: PendingSuggestion): void {
  const all = readPending(cwd).filter(
    (item) => !(item.surface === suggestion.surface && item.testId === suggestion.testId && item.reason === suggestion.reason),
  );
  all.push(suggestion);
  all.sort((left, right) => `${left.surface}/${left.testId}`.localeCompare(`${right.surface}/${right.testId}`));
  writeText(pendingPath(cwd), prettyJson({ suggestions: all }));
}

export function clearPendingSurface(cwd: string, surface: string): void {
  const remaining = readPending(cwd).filter((item) => item.surface !== surface);
  const file = pendingPath(cwd);
  if (remaining.length === 0) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  writeText(file, prettyJson({ suggestions: remaining }));
}

/** Local runs record a suggestion. CI only warns, because a run never writes committed files. */
export function recordSuggestion(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stderr: (message: string) => void;
  surface: string;
  testId: string;
  reason: string;
  detail?: string;
}): void {
  options.stderr(pendingWarning(options.surface, options.testId));
  if (isCi(options.env)) return;
  addPending(options.cwd, {
    surface: options.surface,
    testId: options.testId,
    reason: options.reason,
    detail: options.detail,
  });
}
