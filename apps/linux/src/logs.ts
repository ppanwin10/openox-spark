import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warning" | "error";
export interface LogRow { seq: number; time: string; level: LogLevel; category: string; thread: string; location: string; message: string }

const levels: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
const capacity = 2_000;
const rotateBytes = 5 * 1024 * 1024;

export class Logger {
  private rows: LogRow[] = [];
  private seq = 0;
  private file: string;
  private writing: Promise<void> = Promise.resolve();
  private quiet: boolean;

  constructor(directory: string, quiet = false) {
    this.file = join(directory, "host.jsonl");
    this.quiet = quiet;
  }

  log(level: LogLevel, category: string, message: string) {
    const row: LogRow = { seq: ++this.seq, time: new Date().toISOString(), level, category, thread: "main", location: category, message };
    this.rows.push(row);
    if (this.rows.length > capacity) this.rows.splice(0, this.rows.length - capacity);
    if (!this.quiet) (level === "error" || level === "warning" ? process.stderr : process.stdout).write(`${row.time} ${level} ${category}: ${message}\n`);
    this.writing = this.writing.then(() => this.persist(row)).catch(() => {});
  }
  debug(category: string, message: string) { this.log("debug", category, message); }
  info(category: string, message: string) { this.log("info", category, message); }
  warning(category: string, message: string) { this.log("warning", category, message); }
  error(category: string, message: string) { this.log("error", category, message); }

  private async persist(row: LogRow) {
    const size = await stat(this.file).then(info => info.size, () => 0);
    if (size > rotateBytes) await rename(this.file, `${this.file}.1`).catch(() => {});
    await appendFile(this.file, JSON.stringify(row) + "\n", { mode: 0o600 });
  }

  page(options: { limit?: number | null; cursor?: string | null; level?: LogLevel | null; category?: string | null; query?: string | null; since?: string | null }) {
    const since = options.since ? Date.parse(options.since) : Number.NaN;
    const before = options.cursor ? Number(options.cursor) : Number.POSITIVE_INFINITY;
    const query = options.query?.toLowerCase();
    const matching = this.rows.filter(row => row.seq < before
      && (!options.level || levels[row.level] >= levels[options.level])
      && (!options.category || row.category === options.category)
      && (!query || row.message.toLowerCase().includes(query))
      && (Number.isNaN(since) || Date.parse(row.time) >= since));
    const limit = options.limit ?? 200;
    const page = matching.slice(-limit);
    const hasMore = matching.length > page.length;
    return { logs: page, ...(hasMore ? { nextCursor: String(page[0]!.seq), hasMore: true } : { hasMore: false }) };
  }

  async flush() { await this.writing; }
}
