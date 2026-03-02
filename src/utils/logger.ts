type LogLevel = "info" | "warn" | "error" | "debug";

const COLORS: Record<LogLevel, string> = {
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  debug: "\x1b[90m",
};

const RESET = "\x1b[0m";

function log(level: LogLevel, context: string, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const color = COLORS[level];
  const prefix = `${color}[${timestamp}] [${level.toUpperCase()}] [${context}]${RESET}`;

  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  info: (ctx: string, msg: string, data?: unknown) => log("info", ctx, msg, data),
  warn: (ctx: string, msg: string, data?: unknown) => log("warn", ctx, msg, data),
  error: (ctx: string, msg: string, data?: unknown) => log("error", ctx, msg, data),
  debug: (ctx: string, msg: string, data?: unknown) => log("debug", ctx, msg, data),
};