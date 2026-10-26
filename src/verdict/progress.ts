import { aggregateFindings, fallbackLines, summaryLines, type ReportedTest } from "./reporter.js";
import type { Verdict } from "../config/types.js";

const ELLIPSIS = "\u2026";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const VERDICT_COLOR: Record<Exclude<Verdict, "skipped">, string> = {
  pass: "32",
  unsure: "33",
  fail: "31",
};

export interface ProgressSink {
  write(chunk: string): void;
  columns?: number;
}

export interface ProgressRow {
  surface: string;
  id: string;
  text: string;
}

interface PaintedRow extends ProgressRow {
  verdict?: Verdict;
  cached?: boolean;
  durationMs?: number;
}

export interface RunProgress {
  complete(result: ReportedTest, durationMs: number): void;
  note(message: string): void;
  finish(results: ReportedTest[], options: { unsureBlocks: boolean; verbose: boolean }): void;
  dispose(): void;
}

export function formatDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function createRunProgress(
  sink: ProgressSink,
  rows: ProgressRow[],
  options: { color?: boolean; timer?: boolean } = {},
): RunProgress {
  const color = options.color !== false;
  const painted: PaintedRow[] = rows.map((row) => ({ ...row }));
  let frame = 0;
  let drawn = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const columns = sink.columns && sink.columns > 0 ? sink.columns : 80;

  const paint = (final: { results: ReportedTest[]; unsureBlocks: boolean; verbose: boolean } | null): void => {
    const lines = renderLines(painted, {
      frame: SPINNER[frame % SPINNER.length] ?? "⠋",
      color,
      columns,
      final,
    });
    if (drawn > 0) sink.write(`\x1b[${drawn}A`);
    for (const line of lines) sink.write(`\x1b[2K${line}\n`);
    if (lines.length < drawn) {
      for (let extra = lines.length; extra < drawn; extra += 1) sink.write("\x1b[2K\n");
      sink.write(`\x1b[${drawn - lines.length}A`);
    }
    drawn = lines.length;
  };

  sink.write("\x1b[?25l");
  paint(null);
  if (options.timer !== false) {
    timer = setInterval(() => {
      if (stopped) return;
      frame += 1;
      paint(null);
    }, 80);
    timer.unref?.();
  }

  return {
    complete(result: ReportedTest, durationMs: number): void {
      const row = painted.find((item) => item.surface === result.surface && item.id === result.id);
      if (!row || stopped) return;
      row.verdict = result.verdict;
      row.cached = result.cached;
      row.durationMs = durationMs;
      paint(null);
    },
    note(message: string): void {
      if (stopped) {
        sink.write(`${message}\n`);
        return;
      }
      clearDrawn(sink, drawn);
      drawn = 0;
      sink.write(`${message}\n`);
      paint(null);
    },
    finish(results: ReportedTest[], finishOptions: { unsureBlocks: boolean; verbose: boolean }): void {
      if (stopped) return;
      if (timer) clearInterval(timer);
      timer = undefined;
      try {
        for (const row of painted) {
          if (row.verdict) continue;
          const result = results.find((item) => item.surface === row.surface && item.id === row.id);
          if (!result) continue;
          row.verdict = result.verdict;
          row.cached = result.cached;
          row.durationMs = 0;
        }
        paint({ results, unsureBlocks: finishOptions.unsureBlocks, verbose: finishOptions.verbose });
      } finally {
        this.dispose();
      }
    },
    dispose(): void {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      sink.write("\x1b[?25h");
    },
  };
}

function renderLines(
  rows: PaintedRow[],
  options: {
    frame: string;
    color: boolean;
    columns: number;
    final: { results: ReportedTest[]; unsureBlocks: boolean; verbose: boolean } | null;
  },
): string[] {
  const lines: string[] = [];
  let surface = "";
  for (const row of rows) {
    if (row.surface !== surface) {
      if (lines.length > 0) lines.push("");
      lines.push(fit(row.surface, "", "", options.columns));
      surface = row.surface;
    }
    const tail =
      row.verdict === undefined
        ? `  ${options.frame}`
        : `  ${paintVerdict(row.verdict, options.color)}${row.cached ? " (cached)" : ""}  ${paintTime(row.durationMs ?? 0, options.color)}`;
    lines.push(fit(`  [${row.id}] `, row.text, tail, options.columns));
  }
  if (options.final) {
    if (lines.length > 0) lines.push("");
    lines.push(...summaryLines(options.final.results, options.final.unsureBlocks));
    const findings = aggregateFindings(options.final.results, options.final.verbose);
    if (findings.length > 0) {
      lines.push("");
      lines.push(...findings);
    }
    const fallback = fallbackLines(options.final.results);
    if (fallback.length > 0) {
      lines.push("");
      lines.push(...fallback);
    }
  }
  return lines;
}

function paintVerdict(verdict: Verdict, color: boolean): string {
  if (!color || verdict === "skipped") return verdict === "skipped" ? "skipped" : verdict;
  return `\x1b[${VERDICT_COLOR[verdict]}m${verdict}\x1b[0m`;
}

function paintTime(durationMs: number, color: boolean): string {
  const text = `[${formatDuration(durationMs)}]`;
  return color ? `\x1b[34m${text}\x1b[0m` : text;
}

function fit(head: string, text: string, tail: string, columns: number): string {
  const room = columns - visibleLength(head) - visibleLength(tail);
  if (room >= visibleLength(text)) return `${head}${text}${tail}`;
  if (room <= 1) return `${head}${tail}`;
  return `${head}${text.slice(0, room - 1)}${ELLIPSIS}${tail}`;
}

function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function clearDrawn(sink: ProgressSink, drawn: number): void {
  if (drawn === 0) return;
  sink.write(`\x1b[${drawn}A`);
  for (let line = 0; line < drawn; line += 1) sink.write("\x1b[2K\n");
  sink.write(`\x1b[${drawn}A`);
}
