import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "./time";

export class Logger {
  constructor(private readonly logPath: string) {
    mkdirSync(dirname(logPath), { recursive: true });
  }

  info(message: string, context?: unknown): void {
    this.write("INFO", message, context);
  }

  warn(message: string, context?: unknown): void {
    this.write("WARN", message, context);
  }

  error(message: string, context?: unknown): void {
    this.write("ERROR", message, context);
  }

  private write(level: string, message: string, context?: unknown): void {
    const line = `${nowIso()} ${level} ${message}${context ? ` ${safeStringify(context)}` : ""}\n`;
    if (!existsSync(this.logPath)) {
      mkdirSync(dirname(this.logPath), { recursive: true });
    }
    appendFileSync(this.logPath, line, "utf8");
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

