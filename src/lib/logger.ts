/**
 * logger.ts
 *
 * A tiny structured logger. Real projects reach for pino or similar; this keeps
 * the dependency footprint at zero while still emitting parseable, levelled,
 * timestamped lines instead of bare console.log calls scattered across modules.
 *
 * Level is controlled by LOG_LEVEL (debug | info | warn | error), default info.
 */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

function emit(level: Level, scope: string, msg: string, fields?: object) {
  if (ORDER[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(fields ?? {}),
  };
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(JSON.stringify(line));
}

/** Create a logger bound to a scope, e.g. log("bridge"). */
export function log(scope: string) {
  return {
    debug: (msg: string, fields?: object) => emit("debug", scope, msg, fields),
    info: (msg: string, fields?: object) => emit("info", scope, msg, fields),
    warn: (msg: string, fields?: object) => emit("warn", scope, msg, fields),
    error: (msg: string, fields?: object) => emit("error", scope, msg, fields),
  };
}

export type Logger = ReturnType<typeof log>;
