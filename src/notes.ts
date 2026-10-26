import fs from "node:fs";
import path from "node:path";

import { readText, writeText } from "./fs-util.js";
import { prettyJson } from "./json.js";

export function proposedNotesPath(cwd: string): string {
  return path.join(cwd, ".tyxtest", "proposed-notes.json");
}

export function readProposedNotes(cwd: string): Record<string, string[]> {
  const file = proposedNotesPath(cwd);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readText(file)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const notes: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      notes[key] = value.filter((item): item is string => typeof item === "string");
    }
    return notes;
  } catch {
    return {};
  }
}

export function addProposedNotes(cwd: string, surface: string, notes: string[]): void {
  if (notes.length === 0) return;
  const all = readProposedNotes(cwd);
  const merged = new Set([...(all[surface] ?? []), ...notes]);
  all[surface] = [...merged];
  writeText(proposedNotesPath(cwd), prettyJson(all));
}

export function takeProposedNotes(cwd: string, surface: string): string[] {
  const all = readProposedNotes(cwd);
  const notes = all[surface] ?? [];
  if (!(surface in all)) return notes;
  delete all[surface];
  writeText(proposedNotesPath(cwd), prettyJson(all));
  return notes;
}
