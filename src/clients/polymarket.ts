import { z } from "zod";
import { logger } from "../utils/logger.js";
import { scrape, isScrapingAvailable } from "../scrapers/index.js";
import type { PolymarketMarket, PolymarketResult } from "../types/index.js";

// ─── Polymarket Client ───
//
// Scrapes Polymarket prediction pages for structured market data
// via ScrapeGraphAI SmartScraper. All ranking/filtering logic is
// scraper-agnostic and operates on the validated Zod output.

// ─── Zod Schema ───

export const polymarketSchema = z.object({
  polymarket_markets: z.array(
    z.object({
      title: z.string().describe("Title of the betting market"),
      title_citation: z.string().describe("Source URL for title").optional(),
      total_trading_volume: z
        .number()
        .describe("Total trading volume for the entire market"),
      total_trading_volume_citation: z
        .string()
        .describe("Source URL for total_trading_volume")
        .optional(),
      poll_end_date: z.string().describe("Poll end date"),
      poll_end_date_citation: z
        .string()
        .describe("Source URL for poll_end_date")
        .optional(),
      predictions: z
        .array(
          z.object({
            option: z
              .string()
              .describe("The specific outcome or option (e.g., '25 bps')"),
            option_citation: z
              .string()
              .describe("Source URL for option")
              .optional(),
            percentage: z
              .number()
              .describe("The current percentage odds for this option"),
            percentage_citation: z
              .string()
              .describe("Source URL for percentage")
              .optional(),
            volume: z
              .number()
              .describe("The trading volume for this specific option"),
            volume_citation: z
              .string()
              .describe("Source URL for volume")
              .optional(),
          })
        )
        .describe("List of specific betting options within the market"),
    })
  ),
});

type RawMarket = z.infer<typeof polymarketSchema>["polymarket_markets"][number];

const polymarketMarketDetailSchema = z.object({
  market_title: z.string(),
  volume: z.number(),
  options: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
});

type RawMarketDetail = z.infer<typeof polymarketMarketDetailSchema>;

// ─── Constants ───

const HORIZON_MIN_DAYS = 14;
const HORIZON_MAX_DAYS = 60;
const BUFFER_DAYS = 7;
const MAX_MARKETS_PER_TOPIC = 3;
const MIN_VOLUME_USD = 10_000;

// ─── Prompt Templates ───

function buildGeneralPrompt(topic: string, url: string): string {
  return (
    `Extract all open prediction betting markets related to "${topic}" from ${url}. ` +
    `For each market, capture the market title, the market URL, total trading volume ` +
    `for the entire market, and the poll end date. ` +
    `Additionally, for each market, extract all available prediction options. ` +
    `For each option, capture the option name, its specific percentage odds, ` +
    `and its individual trading volume. ` +
    `Only include markets that are still open (not resolved/closed).`
  );
}

function buildPriceForecastPrompt(ticker: string, url: string): string {
  return (
    `Find all prediction markets related to the stock price of ${ticker} at ${url}. ` +
    `Look for markets about price targets, price levels, or stock performance ` +
    `(e.g. "Will ${ticker} be above $X by [date]?", "${ticker} stock price on [date]"). ` +
    `For each market, capture the market title, the market URL, total trading volume, ` +
    `poll end date, and all prediction options with their percentage odds and ` +
    `individual trading volume. Only include markets that are still open.`
  );
}

function buildMarketDetailPrompt(url: string): string {
  return (
    `From the given prediction market (${url}), deliver the market title, volume, and ` +
    `respective options followed by assigned probabilities. ` +
    `Return JSON with market_title, volume, options. ` +
    `For options, include available keys such as option/price, volume, yes_probability, no_probability.`
  );
}

// ─── Core Scrape Function ───

/**
 * Scrape a single Polymarket predictions page via ScrapeGraphAI.
 */
async function scrapePolymarketPage(
  url: string,
  prompt: string,
  label: string,
  timeoutMs: number = 90_000
): Promise<RawMarket[]> {
  if (!isScrapingAvailable()) {
    logger.info("polymarket", `Scraping unavailable, skipping ${label}`);
    return [];
  }

  logger.info("polymarket", `Scraping ${url} (${label})`);

  const result = await scrape<z.infer<typeof polymarketSchema>>({
    url,
    prompt,
    schema: polymarketSchema,
    numberOfScrolls: 5, // Polymarket loads markets dynamically
    timeoutMs,
  });

  if (!result.success || !result.data) {
    logger.warn(
      "polymarket",
      `Scrape failed for ${label}: ${result.error}`
    );
    return [];
  }

  const raw = result.data.polymarket_markets;
  logger.info("polymarket", `${raw.length} raw markets from ${label}`);

  return raw;
}

async function scrapeMarketDetails(url: string): Promise<RawMarketDetail | null> {
  if (!isScrapingAvailable()) return null;

  const result = await scrape<RawMarketDetail>({
    url,
    prompt: buildMarketDetailPrompt(url),
    schema: polymarketMarketDetailSchema,
    numberOfScrolls: 4,
    timeoutMs: 90_000,
  });

  if (!result.success || !result.data) {
    logger.warn("polymarket", `Detail scrape failed for ${url}: ${result.error}`);
    return null;
  }

  return result.data;
}

function scoreMarketSentiment(
  options: Array<Record<string, string | number | boolean | null>>
): { sentiment: "bullish" | "bearish" | "neutral"; confidence: number } {
  const probs: number[] = [];

  for (const o of options) {
    const yes = o["yes_probability"];
    const no = o["no_probability"];
    const p = o["probability"];

    if (typeof yes === "number" && isFinite(yes)) probs.push(yes);
    else if (typeof no === "number" && isFinite(no)) probs.push(1 - no);
    else if (typeof p === "number" && isFinite(p)) probs.push(p);
  }

  if (probs.length === 0) return { sentiment: "neutral", confidence: 0 };

  const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
  if (avg >= 0.6) return { sentiment: "bullish", confidence: Number(avg.toFixed(2)) };
  if (avg <= 0.4) return { sentiment: "bearish", confidence: Number((1 - avg).toFixed(2)) };
  return { sentiment: "neutral", confidence: Number((1 - Math.abs(0.5 - avg) * 2).toFixed(2)) };
}

// ─── Public API ───

/**
 * Scrape a single Polymarket predictions page.
 */
export async function scrapePolymarket(
  topic: string,
  context: string
): Promise<PolymarketResult> {
  const slug = topicToSlug(topic);
  const url = `https://polymarket.com/predictions/${slug}`;
  const prompt = buildGeneralPrompt(topic, url);

  const raw = await scrapePolymarketPage(url, prompt, `${context}:${topic}`);
  const ranked = rankAndFilter(raw);

  const detailed = await Promise.all(
    ranked.map(async (market) => {
      const detail = await scrapeMarketDetails(market.url);
      if (!detail) return market;

      const sentiment = scoreMarketSentiment(detail.options);
      logger.info(
        "polymarket",
        `Market sentiment ${sentiment.sentiment} (${sentiment.confidence}) for ${detail.market_title}`
      );

      return {
        ...market,
        title: detail.market_title || market.title,
        totalVolume: detail.volume || market.totalVolume,
        optionDetails: detail.options,
      };
    })
  );

  logger.info(
    "polymarket",
    `After ranking + details: ${detailed.length} markets (${context})`
  );
  return { markets: detailed, searchTopic: topic };
}

/**
 * Scrape multiple Polymarket topics in parallel, deduplicate results.
 */
export async function scrapePolymarketMulti(
  topics: string[],
  context: string
): Promise<PolymarketResult[]> {
  if (!isScrapingAvailable()) {
    return topics.map((t) => ({ markets: [], searchTopic: t }));
  }

  const uniqueTopics = [...new Set(topics)];
  logger.info(
    "polymarket",
    `Scraping ${uniqueTopics.length} topics: ${uniqueTopics.join(", ")} (${context})`
  );

  const results = await Promise.allSettled(
    uniqueTopics.map((t) => scrapePolymarket(t, context))
  );

  const out: PolymarketResult[] = [];
  const seenTitles = new Set<string>();

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const deduped: PolymarketMarket[] = [];
    for (const m of r.value.markets) {
      const key = m.title.toLowerCase().trim();
      if (!seenTitles.has(key)) {
        seenTitles.add(key);
        deduped.push(m);
      }
    }
    out.push({ ...r.value, markets: deduped });
  }

  return out;
}

// ─── Targeted URL Scraping (Supabase-driven) ───

/**
 * Scrape detailed data from specific market URLs discovered via Supabase.
 *
 * Unlike scrapePolymarket/scrapePolymarketMulti which discover markets by
 * scraping listing pages, this function takes already-known market URLs
 * and fetches their current state (title, volume, option probabilities).
 */
export async function scrapeMarketUrls(
  markets: { title: string; url: string }[],
  context: string,
): Promise<PolymarketResult> {
  if (!isScrapingAvailable() || markets.length === 0) {
    return { markets: [], searchTopic: context };
  }

  logger.info(
    "polymarket",
    `Scraping ${markets.length} specific market URLs (${context})`,
  );

  const detailed = await Promise.allSettled(
    markets.map(async (m) => {
      const detail = await scrapeMarketDetails(m.url);
      if (!detail) return null;

      const sentiment = scoreMarketSentiment(detail.options);
      logger.info(
        "polymarket",
        `URL scrape sentiment ${sentiment.sentiment} (${sentiment.confidence}) for ${detail.market_title}`,
      );

      return {
        title: detail.market_title || m.title,
        url: m.url,
        totalVolume: detail.volume || 0,
        pollEndDate: "",
        daysUntilClose: 999,
        relevanceScore: 1,
        predictions: detail.options.map((o) => ({
          option: String(o["option"] ?? o["price"] ?? "Unknown"),
          percentage:
            typeof o["yes_probability"] === "number"
              ? o["yes_probability"] * 100
              : typeof o["probability"] === "number"
                ? o["probability"] * 100
                : 0,
          volume: typeof o["volume"] === "number" ? o["volume"] : 0,
        })),
        optionDetails: detail.options,
      } as PolymarketMarket;
    }),
  );

  const resultMarkets = detailed
    .filter(
      (r): r is PromiseFulfilledResult<PolymarketMarket | null> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value)
    .filter((m): m is PolymarketMarket => m !== null);

  logger.info(
    "polymarket",
    `Scraped ${resultMarkets.length}/${markets.length} market URLs (${context})`,
  );

  return { markets: resultMarkets, searchTopic: context };
}

// ─── Equity Price Forecast Scanning ───

/**
 * Dedicated Polymarket scan for stock price prediction markets.
 *
 * Polymarket equity predictions follow the format:
 *   polymarket.com/predictions/TICKER (e.g. polymarket.com/predictions/NVDA)
 */
export async function scrapePolymarketPriceForecasts(
  ticker: string,
  companyName: string
): Promise<PolymarketResult[]> {
  if (!isScrapingAvailable()) {
    return [{ markets: [], searchTopic: `${ticker}-price-forecast` }];
  }

  const slugs = [
    ticker.toUpperCase(),
    ticker.toLowerCase(),
    `${companyName.toLowerCase().replace(/\s+/g, "-")}-stock`,
  ];

  const uniqueSlugs = [...new Set(slugs)];

  logger.info(
    "polymarket",
    `Scanning price forecasts for ${ticker}: ${uniqueSlugs.join(", ")}`
  );

  const results = await Promise.allSettled(
    uniqueSlugs.map((slug) => {
      const url = `https://polymarket.com/predictions/${slug}`;
      const prompt = buildPriceForecastPrompt(ticker, url);
      return scrapePolymarketPage(url, prompt, `price:${ticker}:${slug}`, 90_000);
    })
  );

  const out: PolymarketResult[] = [];
  const seenTitles = new Set<string>();

  for (const r of results) {
    if (r.status !== "fulfilled" || r.value.length === 0) continue;
    const ranked = rankAndFilterPriceForecasts(r.value);
    const deduped = ranked.filter((m) => {
      const key = m.title.toLowerCase().trim();
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });
    if (deduped.length > 0) {
      out.push({ markets: deduped, searchTopic: `${ticker}-price-forecast` });
    }
  }

  const totalMarkets = out.reduce((sum, r) => sum + r.markets.length, 0);
  logger.info(
    "polymarket",
    `Price forecasts for ${ticker}: ${totalMarkets} markets found`
  );

  return out;
}

// ─── Ranking & Filtering ───
//
// These functions are scraper-agnostic — they operate on the validated
// Zod output regardless of which backend produced the data.

function rankAndFilter(raw: RawMarket[]): PolymarketMarket[] {
  const now = Date.now();
  const scored: PolymarketMarket[] = [];

  for (const m of raw) {
    const endDate = parseEndDate(m.poll_end_date);
    const daysUntilClose = endDate
      ? Math.ceil((endDate.getTime() - now) / (1000 * 60 * 60 * 24))
      : 999;

    if (m.total_trading_volume < MIN_VOLUME_USD) continue;

    const inHorizon =
      daysUntilClose >= HORIZON_MIN_DAYS - BUFFER_DAYS &&
      daysUntilClose <= HORIZON_MAX_DAYS + BUFFER_DAYS * 4;

    if (!inHorizon && daysUntilClose !== 999) continue;

    const volScore = Math.log10(Math.max(m.total_trading_volume, 1)) / 8;
    const recencyScore =
      daysUntilClose <= HORIZON_MAX_DAYS
        ? 1 - daysUntilClose / HORIZON_MAX_DAYS
        : 0;
    const relevanceScore = volScore * 0.6 + recencyScore * 0.4;

    scored.push({
      title: m.title,
      url: m.title_citation ?? `https://polymarket.com/predictions`,
      totalVolume: m.total_trading_volume,
      pollEndDate: m.poll_end_date,
      daysUntilClose,
      relevanceScore,
      predictions: m.predictions.map((p) => ({
        option: p.option,
        percentage: p.percentage,
        volume: p.volume,
        citation: p.option_citation,
      })),
    });
  }

  scored.sort((a, b) => {
    const dayDiff = a.daysUntilClose - b.daysUntilClose;
    if (dayDiff !== 0) return dayDiff;
    return b.totalVolume - a.totalVolume;
  });

  return scored.slice(0, MAX_MARKETS_PER_TOPIC);
}

function rankAndFilterPriceForecasts(raw: RawMarket[]): PolymarketMarket[] {
  const now = Date.now();
  const scored: PolymarketMarket[] = [];

  for (const m of raw) {
    const endDate = parseEndDate(m.poll_end_date);
    const daysUntilClose = endDate
      ? Math.ceil((endDate.getTime() - now) / (1000 * 60 * 60 * 24))
      : 999;

    if (m.total_trading_volume < 1_000) continue;
    if (daysUntilClose < 0 || (daysUntilClose > 180 && daysUntilClose !== 999))
      continue;

    scored.push({
      title: m.title,
      url: m.title_citation ?? `https://polymarket.com/predictions`,
      totalVolume: m.total_trading_volume,
      pollEndDate: m.poll_end_date,
      daysUntilClose,
      relevanceScore: Math.log10(Math.max(m.total_trading_volume, 1)) / 8,
      predictions: m.predictions.map((p) => ({
        option: p.option,
        percentage: p.percentage,
        volume: p.volume,
        citation: p.option_citation,
      })),
    });
  }

  scored.sort((a, b) => b.totalVolume - a.totalVolume);
  return scored.slice(0, 5);
}

// ─── Helpers ───

function topicToSlug(topic: string): string {
  // Short all-uppercase strings (e.g. "NVDA") are likely tickers —
  // preserve their case since Polymarket URLs can be case-sensitive.
  if (/^[A-Z0-9]{1,5}$/.test(topic)) {
    return topic;
  }
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseEndDate(dateStr: string): Date | null {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}
