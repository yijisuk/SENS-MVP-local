import { logger } from "./logger.js";

/**
 * Wraps a promise with a timeout. If the promise does not settle
 * within `ms` milliseconds, it resolves to `fallback` instead of
 * rejecting — keeping the rest of the workflow alive.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label?: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      logger.warn("timeout", `Timeout after ${ms}ms${label ? ` [${label}]` : ""}, using fallback`);
      resolve(fallback);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
