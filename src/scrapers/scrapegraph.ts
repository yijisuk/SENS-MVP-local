import { z } from "zod";
import { smartScraper } from "scrapegraph-js";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";

// ─── ScrapeGraphAI SmartScraper ───
//
// Uses the scrapegraph-js SDK to scrape pages via ScrapeGraphAI.
// Polymarket is a React SPA → numberOfScrolls is used to load
// dynamically rendered content.
//
// SDK: https://www.npmjs.com/package/scrapegraph-js
// Signature: smartScraper(apiKey, url, prompt, schema?, numberOfScrolls?,
//            totalPages?, cookies?, options?, plain_text?, renderHeavyJs?)

export interface ScrapeRequest {
  /** Target URL to scrape */
  url: string;
  /** Natural-language extraction prompt */
  prompt: string;
  /** Zod schema for structured output validation */
  schema: z.ZodTypeAny;
  /** Number of scrolls for infinite-scroll pages (0–100) */
  numberOfScrolls?: number;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

export interface ScrapeResponse<T = unknown> {
  /** Whether the scrape succeeded */
  success: boolean;
  /** Parsed and validated data (null on failure) */
  data: T | null;
  /** Error message if success is false */
  error?: string;
}

let disabled = false;
let disabledReason = "";
let disabledAt = 0;

/** Auto-reset cooldown: re-enable scraping after 5 minutes so one user's
 *  credit error does not permanently disable scraping for all users
 *  sharing the same Worker isolate. */
const DISABLE_COOLDOWN_MS = 5 * 60 * 1000;

function isCreditError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("insufficient") ||
    msg.includes("credit") ||
    msg.includes("quota") ||
    msg.includes("payment required") ||
    msg.includes("402") ||
    msg.includes("429") ||
    msg.includes("rate limit")
  );
}

/**
 * Check if ScrapeGraphAI is available (API key set and not disabled).
 */
export function isScrapingAvailable(): boolean {
  if (disabled) {
    // Auto-reset after cooldown so other users are not permanently blocked
    if (Date.now() - disabledAt > DISABLE_COOLDOWN_MS) {
      disabled = false;
      disabledReason = "";
      logger.info("scrapegraph", "Auto-reset: re-enabled after cooldown");
    } else {
      logger.info("scrapegraph", `Skipping — disabled: ${disabledReason}`);
      return false;
    }
  }
  if (!config.SCRAPEGRAPH_API_KEY) {
    return false;
  }
  return true;
}

/**
 * Disable ScrapeGraphAI for the current session (e.g. on credit exhaustion).
 */
export function disableScraping(reason: string): void {
  if (!disabled) {
    disabled = true;
    disabledReason = reason;
    disabledAt = Date.now();
    logger.warn(
      "scrapegraph",
      `ScrapeGraphAI DISABLED for this session: ${reason}`
    );
  }
}

/**
 * Scrape a URL using ScrapeGraphAI SmartScraper via scrapegraph-js.
 *
 * The SDK accepts Zod schemas directly (converts to JSON Schema internally).
 * Returns structured data validated against the provided schema.
 */
export async function scrape<T>(
  request: ScrapeRequest
): Promise<ScrapeResponse<T>> {
  if (!isScrapingAvailable()) {
    return {
      success: false,
      data: null,
      error: disabled
        ? `ScrapeGraphAI disabled: ${disabledReason}`
        : "SCRAPEGRAPH_API_KEY not set",
    };
  }

  const {
    url,
    prompt,
    schema,
    numberOfScrolls = 1,
    timeoutMs = 180_000,
  } = request;

  logger.info("scrapegraph", `SmartScraper: ${url}`);

  try {
    // Race the SDK call against a timeout
    const result = await Promise.race([
      smartScraper(
        config.SCRAPEGRAPH_API_KEY,
        url,
        prompt,
        schema,                // Zod schema — SDK converts to JSON Schema internally
        numberOfScrolls,       // Scroll for dynamic content (Polymarket is React SPA)
        null,                  // totalPages
        null,                  // cookies
        {},                    // options
        false,                 // plain_text
        true                   // renderHeavyJs — always true for SPAs
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);

    if (!result || !result.result) {
      logger.warn("scrapegraph", `No result returned for ${url}`);
      return {
        success: false,
        data: null,
        error: "No result in response",
      };
    }

    // Validate against the Zod schema (belt-and-suspenders — SDK should
    // already return conforming data, but we validate to be safe)
    const parsed = schema.safeParse(result.result);
    if (!parsed.success) {
      logger.warn(
        "scrapegraph",
        `Schema validation failed: ${parsed.error.message}`
      );
      return {
        success: false,
        data: null,
        error: `Schema validation: ${parsed.error.message}`,
      };
    }

    logger.info("scrapegraph", `SmartScraper success for ${url}`);
    return {
      success: true,
      data: parsed.data as T,
    };
  } catch (err: any) {
    const errMsg = String(err);

    // Detect credit/rate-limit exhaustion → disable for session
    if (isCreditError(err)) {
      disableScraping(errMsg.slice(0, 200));
    }

    // Timeout
    if (errMsg.includes("Timeout after")) {
      logger.warn("scrapegraph", `${errMsg} for ${url}`);
      return {
        success: false,
        data: null,
        error: errMsg,
      };
    }

    logger.error("scrapegraph", `SmartScraper failed for ${url}: ${errMsg}`);
    return {
      success: false,
      data: null,
      error: errMsg,
    };
  }
}
