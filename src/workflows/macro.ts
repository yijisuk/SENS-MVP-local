import { fetchNews } from "../clients/perplexity.js";
import { fetchMarketsByTags } from "../clients/supabase.js";
import { fetchSentimentBatch } from "../clients/manus.js";
import { extractConcepts, synthesize } from "../clients/openrouter.js";
import {
  renderYieldCurve,
  fetchFredSeries,
  renderChart,
  FRED_SERIES,
} from "../clients/fred.js";
import { withTimeout } from "../utils/timeout.js";
import { logger } from "../utils/logger.js";
import { buildCacheKey, getCachedResponse, setCachedResponse, type CacheRequestPayload } from "../utils/cache.js";
import type {
  SynthesisOutput,
  WorkflowProgress,
  SentimentResult,
  PolymarketResult,
  FredChartResult,
} from "../types/index.js";

// ─── Timeout Budgets ───
const NEWS_TIMEOUT_MS = 90_000;          // 90 s — Perplexity news scan
const SYNTHESIS_TIMEOUT_MS = 120_000;    // 120 s — OpenRouter synthesis
const SENTIMENT_TIMEOUT_MS = 210_000;    // 210 s — single batched Manus task takes ~2–3 min
const SUPABASE_TIMEOUT_MS = 15_000;      // 15 s — Supabase DB query (replaces Polymarket SPA scraping)
const FRED_TIMEOUT_MS = 15_000;          // 15 s — FRED API + QuickChart
const STEP3_TIMEOUT_MS = 270_000;        // 270 s — accommodate Manus batch (2–3 min) + FRED

/**
 * /macro — 4-Step Pyramid
 *
 * Step 1: Perplexity 24h macro scan
 * Step 2: Core concept extraction (FAST tier via OpenRouter)
 * Step 3: Parallel deep dive (Manus + Polymarket + FRED)
 * Step 4: Synthesis (FULL tier via OpenRouter)
 */
export async function runMacroWorkflow(
  progress: WorkflowProgress
): Promise<SynthesisOutput | string> {
  // ── Cache check (30-min TTL) ──
  const cachePayload: CacheRequestPayload = { route: "/macro" };
  const cacheKey = buildCacheKey(cachePayload);
  const cached = await getCachedResponse("/macro", cacheKey);
  if (cached) {
    logger.info("macro", "Cache hit, returning cached response");
    return cached;
  }

  // ── Step 1 ──
  await progress.update(1, "Scanning macro news (last 24h)...");

  const news = await withTimeout(
    fetchNews(
      [
        `What are the most significant US macroeconomic developments in the past 24 hours? ` +
          `Focus on the Fed, US Treasury yields, US economic data releases (CPI, PPI, PCE, jobs), ` +
          `and US bond/FX/commodity moves. Include non-US events (ECB, BOJ, PBOC, etc.) only if ` +
          `they have a direct, material impact on US markets or US monetary policy. ` +
          `Be specific with numbers.`,
      ],
      "macro:overview",
      "You are a US-focused macroeconomic research analyst. Prioritize US macro developments. " +
        "Include foreign central bank or economic events only when they directly affect " +
        "US rates, equities, or the dollar. Report only on events from the last 24 hours. " +
        "Be precise with data points, dates, and sources. No speculation."
    ),
    NEWS_TIMEOUT_MS,
    [],
    "macro:news"
  );

  if (news.length === 0 || !news[0]?.summary) {
    await progress.done();
    return "Could not retrieve macro news. Try again in a moment.";
  }

  // ── Step 2 ──
  await progress.update(2, "Identifying core macro themes...");

  const concepts = await extractConcepts(news[0].summary, "macro");

  if (concepts.length === 0) {
    logger.warn("macro", "No concepts extracted, fallback to basic synthesis");
    await progress.done();
    return synthesize({ topic: "US Macro & Rates", news, polymarkets: [], sentiment: null });
  }

  logger.info("macro", `${concepts.length} concepts: ${concepts.map((c) => c.name).join(", ")}`);

  // ── Step 3 ──
  await progress.update(
    3,
    `Deep dive: ${concepts.length} themes (sentiment + markets + data)...`
  );

  // 3a. Manus sentiment — single batched task for all concepts (~2–3 min)
  const sentimentBatchPromise = withTimeout(
    fetchSentimentBatch(
      concepts.map((c) => ({
        name: c.name,
        context:
          `Search for US market-focused consensus on: ${c.name}. ` +
          `Check Polymarket, X/FinTwit, Reddit (r/wallstreetbets, r/investing, r/economics). ` +
          `Focus on how US-based traders and investors are positioning around this theme. ` +
          `If this is a non-US event, report only on its perceived impact on US markets. ` +
          `Report: consensus direction, contrarian voices, shift vs prior week.`,
      }))
    ).catch(() => Object.fromEntries(concepts.map((c) => [c.name, null]))),
    SENTIMENT_TIMEOUT_MS,
    Object.fromEntries(concepts.map((c) => [c.name, null])),
    "sentiment:batch"
  );

  // 3b. Supabase prediction markets (tag: 'macro')
  const polyPromise = withTimeout(
    fetchMarketsByTags(["macro"]).catch(() => [] as PolymarketResult[]),
    SUPABASE_TIMEOUT_MS,
    [] as PolymarketResult[],
    "supabase:macro",
  );

  // 3c. FRED charts (timeout-guarded)
  //     [3] Each chart includes a detailed time horizon label
  const fredSeriesIds = new Set<string>();
  for (const c of concepts) {
    for (const id of c.fredSeriesIds ?? []) {
      if (FRED_SERIES[id]) fredSeriesIds.add(id);
    }
  }

  const FRED_MONTHS = 12; // default lookback
  const chartPromises: Promise<FredChartResult | null>[] = [
    withTimeout(renderYieldCurve(), FRED_TIMEOUT_MS, null, "fred:yield-curve"),
  ];
  for (const id of [...fredSeriesIds].slice(0, 3)) {
    chartPromises.push(
      withTimeout(
        fetchFredSeries(id, FRED_MONTHS).then((s) =>
          s ? renderChart(s, { months: FRED_MONTHS }) : null
        ),
        FRED_TIMEOUT_MS,
        null,
        `fred:${id}`
      )
    );
  }

  // Wait for all parallel work — with an overall Step 3 hard cap
  const [conceptSentiments, polyResults, ...chartResults] = await withTimeout(
    Promise.all([
      sentimentBatchPromise,
      polyPromise.catch(() => [] as PolymarketResult[]),
      ...chartPromises.map((p) => p.catch(() => null)),
    ]),
    STEP3_TIMEOUT_MS,
    [
      Object.fromEntries(concepts.map((c) => [c.name, null])) as Record<string, SentimentResult | null>,
      [] as PolymarketResult[],
      ...chartPromises.map(() => null),
    ],
    "step3:all"
  );

  const charts = (chartResults as (FredChartResult | null)[]).filter(
    (c): c is FredChartResult => c !== null
  );

  // ── Step 4 ──
  await progress.update(4, "Synthesizing macro intelligence...");

  const result = await withTimeout(
    synthesize({
      topic: "Macro Intelligence",
      news,
      polymarkets: polyResults as PolymarketResult[],
      sentiment: null,
      conceptSentiments,
      charts,
    }),
    SYNTHESIS_TIMEOUT_MS,
    { topic: "Macro Intelligence", body: "Synthesis timed out. Please try again.", citations: [], timestamp: new Date() } as SynthesisOutput,
    "macro:synthesis"
  );

  setCachedResponse("/macro", cacheKey, cachePayload, result).catch(() => {});
  return result;
}
