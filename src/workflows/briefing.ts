import { fetchNews } from "../clients/perplexity.js";
import { fetchMarketsByTags } from "../clients/supabase.js";
import { synthesize } from "../clients/openrouter.js";
import { renderYieldCurve } from "../clients/fred.js";
import { withTimeout } from "../utils/timeout.js";
import { logger } from "../utils/logger.js";
import type {
  SynthesisOutput,
  WorkflowProgress,
  NewsItem,
  PolymarketResult,
  FredChartResult,
} from "../types/index.js";

// ─── Timeout Budgets ───
const NEWS_TIMEOUT_MS = 90_000;          // 90 s — Perplexity news scan (2 batches sequential)
const SUPABASE_TIMEOUT_MS = 15_000;      // 15 s — Supabase DB query (replaces Polymarket SPA scraping)
const FRED_TIMEOUT_MS = 15_000;
const SYNTHESIZE_TIMEOUT_MS = 120_000;   // 120 s — OpenRouter synthesis

/**
 * /briefing — Reverse Pyramid
 *
 * Step 1: Parallel domain scan (6 domains) + Polymarket + yield curve
 * Step 2: Synthesis (FULL tier via OpenRouter)
 *
 * No Manus (speed priority). Target: <90s, <$0.15
 */

const BRIEFING_QUERIES: { domain: string; query: string }[] = [
  {
    domain: "macro",
    query:
      "Key US macro developments in the last 24 hours: Fed actions/speeches, " +
      "Treasury yields (2Y/10Y/30Y), CPI/PPI/PCE, jobs data, ECB/BOJ/PBoC moves. Numbers only.",
  },
  {
    domain: "equities",
    query:
      "US equity market performance in the last 24 hours: S&P 500, Nasdaq 100, Dow, " +
      "Russell 2000 levels and moves. Top movers, sector rotation, VIX. Notable earnings.",
  },
  {
    domain: "geopolitics",
    query:
      "Geopolitical/trade policy developments in the last 24 hours impacting markets: " +
      "tariffs, sanctions, conflicts, diplomatic shifts. Countries, actors, affected sectors.",
  },
  {
    domain: "commodities",
    query:
      "Commodity moves in the last 24 hours: gold, silver, WTI/Brent oil, copper, natural gas. " +
      "Levels, percentage moves, drivers (OPEC, central bank buying, etc.).",
  },
  {
    domain: "crypto",
    query:
      "Crypto markets in the last 24 hours: BTC and ETH price, ETF inflows/outflows, " +
      "regulatory developments, notable institutional activity.",
  },
  {
    domain: "fx",
    query:
      "Major FX moves in the last 24 hours: DXY, EUR/USD, USD/JPY, GBP/USD. " +
      "Intervention signals, EM stress (TRY, BRL, MXN).",
  },
];

const BRIEFING_POLY_TAGS = ["macro", "crypto", "geopolitics", "equity"];

export async function runBriefingWorkflow(
  progress: WorkflowProgress
): Promise<SynthesisOutput | string> {
  // ── Step 1 ──
  await progress.update(
    1,
    `Scanning ${BRIEFING_QUERIES.length} domains + markets...`
  );

  const allNews: NewsItem[] = [];
  const batches = chunk(BRIEFING_QUERIES, 4);

  const newsPromise = withTimeout(
    (async () => {
      for (const batch of batches) {
        const results = await fetchNews(
          batch.map((q) => q.query),
          `briefing:${batch.map((q) => q.domain).join("+")}`,
          "You are a financial analyst providing a daily morning briefing. " +
            "Only report events from the last 24 hours. Facts and numbers only."
        );
        allNews.push(...results);
      }
      return allNews;
    })(),
    NEWS_TIMEOUT_MS,
    [] as NewsItem[],
    "briefing:news"
  );

  const polyPromise = withTimeout(
    fetchMarketsByTags(BRIEFING_POLY_TAGS).catch(() => [] as PolymarketResult[]),
    SUPABASE_TIMEOUT_MS,
    [] as PolymarketResult[],
    "supabase:briefing"
  );

  const yieldCurvePromise = withTimeout(
    renderYieldCurve().catch(() => null),
    FRED_TIMEOUT_MS,
    null,
    "fred:yield-curve"
  );

  const [, polyResults, yieldCurve] = await Promise.all([
    newsPromise,
    polyPromise,
    yieldCurvePromise,
  ]);

  if (allNews.length === 0) {
    await progress.done();
    return "Could not retrieve briefing data. Try again in a moment.";
  }

  const charts: FredChartResult[] = [];
  if (yieldCurve) charts.push(yieldCurve);

  // ── Step 2 ──
  await progress.update(2, "Generating your daily briefing...");

  const result = await withTimeout(
    synthesize({
      topic: "Daily Market Briefing",
      news: allNews,
      polymarkets: polyResults as PolymarketResult[],
      sentiment: null,
      charts,
    }),
    SYNTHESIZE_TIMEOUT_MS,
    null,
    "briefing:synthesize"
  );

  if (!result) {
    return "Briefing synthesis timed out. Please try again.";
  }

  return result;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}
