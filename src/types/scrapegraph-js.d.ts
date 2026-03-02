/**
 * Type declarations for scrapegraph-js.
 *
 * The scrapegraph-js package does not ship its own TypeScript declarations.
 * This ambient module declaration provides minimal types for the functions
 * used in this project.
 */
declare module "scrapegraph-js" {
  import type { ZodTypeAny } from "zod";

  interface SmartScraperResult {
    result: unknown;
    [key: string]: unknown;
  }

  export function smartScraper(
    apiKey: string,
    url: string,
    prompt: string,
    schema?: ZodTypeAny | null,
    numberOfScrolls?: number | null,
    totalPages?: number | null,
    cookies?: Record<string, string> | null,
    options?: Record<string, unknown> | null,
    plain_text?: boolean | null,
    renderHeavyJs?: boolean | null,
  ): Promise<SmartScraperResult>;
}
