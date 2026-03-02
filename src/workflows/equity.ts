import { fetchNews } from "../clients/perplexity.js";
import { scrapeMarketUrls } from "../clients/polymarket.js";
import { searchMarketsByTags } from "../clients/supabase.js";
import { fetchSentiment } from "../clients/manus.js";
import { synthesize } from "../clients/openrouter.js";
import { fetchAllFinancials } from "../clients/fmp.js";
import { evaluateFinancials } from "../clients/equity-eval.js";
import { resolveTicker } from "../utils/ticker-resolver.js";
import { computeTitleRelevance } from "../utils/market-relevance.js";
import { withTimeout } from "../utils/timeout.js";
import { logger } from "../utils/logger.js";
import { buildCacheKey, getCachedResponse, setCachedResponse, type CacheRequestPayload } from "../utils/cache.js";
import type { SynthesisOutput, WorkflowProgress, PolymarketResult, EquityEvalResult } from "../types/index.js";

// ─── Timeout Budgets ───
const RESOLVE_TIMEOUT_MS = 15_000;       // 15 s — FMP ticker resolution
const SYNTHESIS_TIMEOUT_MS = 120_000;    // 120 s — OpenRouter synthesis
const NEWS_TIMEOUT_MS = 30_000;
const POLYMARKET_TIMEOUT_MS = 120_000;  // 120 s — Polymarket SPA needs longer for heavy JS rendering
const SENTIMENT_TIMEOUT_MS = 210_000;   // 210 s — Manus tasks take ~2–3 min
const FINANCIALS_TIMEOUT_MS = 60_000;   // 60 s — FMP API + chart rendering + LLM eval
const STEP2_TIMEOUT_MS = 270_000;       // 270 s — accommodate Manus (2–3 min) + Polymarket

function buildEquityQueries(ticker: string, company: string): string[] {
  return [
    `What are the most important developments for ${company} (${ticker}) in the last 24 hours? ` +
      `Prioritize concrete events and timing: guidance updates, major filings, management announcements, regulatory actions, legal outcomes, product or partnership updates.`,
    `What are traders and market participants saying about ${company} (${ticker}) in the last 24 hours? ` +
      `Summarize institutional and analyst tone shifts, positioning chatter, and key bull vs bear narratives with specific signals.`,
    `What market-moving catalysts should investors monitor next for ${company} (${ticker})? ` +
      `Focus on near-term events and why sentiment might shift from them.`,
  ];
}

export async function runEquityWorkflow(
  rawTicker: string,
  progress: WorkflowProgress
): Promise<SynthesisOutput | string> {
  // ── Step 1: Resolve ticker ──
  await progress.update(1, `Resolving ${rawTicker.toUpperCase()}...`);

  const resolved = await withTimeout(
    resolveTicker(rawTicker),
    RESOLVE_TIMEOUT_MS,
    null,
    `resolve:${rawTicker}`
  );
  if (!resolved) {
    return `Could not resolve ticker "${rawTicker.toUpperCase()}". Please check the symbol.`;
  }

  const { ticker, companyName } = resolved;

  // ── Cache check ──
  const cachePayload: CacheRequestPayload = { route: "/equity", ticker };
  const cacheKey = buildCacheKey(cachePayload);
  const cached = await getCachedResponse("/equity", cacheKey);
  if (cached) {
    logger.info("equity", `Cache hit for ${ticker}, returning cached response`);
    return cached;
  }

  // ── Step 2: Fetch all data (parallel, timeout-guarded) ──
  await progress.update(2, `Fetching data for ${companyName} (${ticker})...`);

  // 2a. Search Supabase for relevant prediction markets
  //     Tags: TICKER (all caps) or 'equity'
  let relevantMarkets: { title: string; url: string }[] = [];
  try {
    const supabaseMarkets = await searchMarketsByTags([ticker.toUpperCase(), "equity"]);
    relevantMarkets = supabaseMarkets.filter(
      (m) => computeTitleRelevance(m.title, ticker, companyName) >= 0.75,
    );
    logger.info(
      "equity",
      `Supabase: ${supabaseMarkets.length} markets found, ${relevantMarkets.length} pass relevance threshold`,
    );
  } catch (err) {
    logger.warn("equity", `Supabase market search failed: ${err}`);
  }

  // 2b. Parallel data fetch (timeout-guarded)
  const newsPromise = withTimeout(
    fetchNews(
      buildEquityQueries(ticker, companyName),
      `equity:${ticker}`,
      "You are a financial research analyst. Facts, numbers, dates. No speculation."
    ).catch(() => []),
    NEWS_TIMEOUT_MS,
    [],
    `news:${ticker}`
  );

  // Polymarket: scrape specific market URLs discovered via Supabase
  const polyPromise = relevantMarkets.length > 0
    ? withTimeout(
        scrapeMarketUrls(relevantMarkets, `equity:${ticker}`)
          .catch(() => ({ markets: [], searchTopic: `equity:${ticker}` } as PolymarketResult)),
        POLYMARKET_TIMEOUT_MS,
        { markets: [], searchTopic: `equity:${ticker}` } as PolymarketResult,
        `polymarket:${ticker}`
      )
    : Promise.resolve({ markets: [], searchTopic: `equity:${ticker}` } as PolymarketResult);

  const sentimentPromise = withTimeout(
    fetchSentiment(
      `${companyName} (${ticker}) stock`,
      `Retail investor sentiment, meme stock activity, trending discussions about ${ticker}.`
    ).catch(() => null),
    SENTIMENT_TIMEOUT_MS,
    null,
    `sentiment:${ticker}`
  );

  // Financial data fetch (FMP) — runs in parallel with all other data layers
  const financialsPromise = withTimeout(
    fetchAllFinancials(ticker).catch(() => ({
      profile: null,
      incomeStatements: [],
      balanceSheets: [],
      cashFlowStatements: [],
      ttmFinRatios: [],
    })),
    FINANCIALS_TIMEOUT_MS,
    { profile: null, incomeStatements: [], balanceSheets: [], cashFlowStatements: [], ttmFinRatios: [] },
    `financials:${ticker}`
  );

  const [news, polyResult, sentiment, financialData] = await withTimeout(
    Promise.all([newsPromise, polyPromise, sentimentPromise, financialsPromise]),
    STEP2_TIMEOUT_MS,
    [[], { markets: [], searchTopic: `equity:${ticker}` } as PolymarketResult, null, { profile: null, incomeStatements: [], balanceSheets: [], cashFlowStatements: [], ttmFinRatios: [] }],
    `step2:${ticker}`
  );

  const allPolymarkets = polyResult.markets.length > 0 ? [polyResult] : [];

  // Filter out news items with empty or trivially short summaries
  const validNews = news.filter((n) => n.summary && n.summary.trim().length >= 20);

  // Count actual markets, not just wrapper objects with empty market arrays
  const actualMarketCount = allPolymarkets.reduce((sum, r) => sum + r.markets.length, 0);

  const hasFinancials = financialData.incomeStatements.length > 0;

  logger.info("equity", `Data received for ${ticker}: news=${validNews.length}, polymarkets=${actualMarketCount}, sentiment=${sentiment ? "yes" : "no"}, financials=${hasFinancials ? financialData.incomeStatements.length + "Q" : "no"}`);

  if (validNews.length === 0 && actualMarketCount === 0 && !sentiment && !hasFinancials) {
    await progress.done();
    return `Could not retrieve any data for ${companyName} (${ticker}). Try again.`;
  }

  // ── Step 3: Financial evaluation (parallel with data analysis) ──
  await progress.update(3, "Evaluating financials & analyzing data...");

  let evalResult: EquityEvalResult | null = null;
  if (hasFinancials) {
    try {
      evalResult = await withTimeout(
        evaluateFinancials(ticker, companyName, financialData),
        FINANCIALS_TIMEOUT_MS,
        null as EquityEvalResult | null,
        `eval:${ticker}`
      );
    } catch (err) {
      logger.warn("equity", `Financial evaluation failed for ${ticker}: ${err}`);
    }
  }

  // ── Step 4: Synthesize ──
  await progress.update(4, "Synthesizing intelligence briefing...");

  const result = await withTimeout(
    synthesize({
      topic: `${companyName} (${ticker})`,
      label: ticker,
      news: validNews,
      polymarkets: allPolymarkets,
      sentiment,
    }),
    SYNTHESIS_TIMEOUT_MS,
    { topic: `${companyName} (${ticker})`, body: "Synthesis timed out. Please try again.", citations: [], timestamp: new Date() } as SynthesisOutput,
    `synthesis:${ticker}`
  );

  if (!hasConsistentEquityStructure(result.body)) {
    logger.warn("equity", `Inconsistent output structure for ${ticker}; retrying synthesis once`);
    const retry = await withTimeout(
      synthesize({
        topic: `${companyName} (${ticker})`,
        label: ticker,
        news: validNews,
        polymarkets: allPolymarkets,
        sentiment,
      }),
      SYNTHESIS_TIMEOUT_MS,
      { topic: `${companyName} (${ticker})`, body: "Synthesis timed out. Please try again.", citations: [], timestamp: new Date() } as SynthesisOutput,
      `synthesis-retry:${ticker}`
    );

    if (hasConsistentEquityStructure(retry.body)) {
      if (evalResult) {
        retry.charts = evalResult.charts;
      }
      setCachedResponse("/equity", cacheKey, cachePayload, retry).catch(() => {});
      return retry;
    }
  }

  // Attach financial charts (growth tables + metric charts).
  // Charts are sent before body text by the bot, achieving the
  // "financials first, then news & sentiment" output order.
  if (evalResult) {
    result.charts = evalResult.charts;
  }

  setCachedResponse("/equity", cacheKey, cachePayload, result).catch(() => {});
  return result;
}

function hasConsistentEquityStructure(body: string): boolean {
  const requiredSections = [
    "🏢 <b>COMPANY SNAPSHOT</b>",
    "📰 <b>LATEST NEWS (24H)</b>",
    "💬 <b>MARKET SENTIMENT</b>",
    "📈 <b>FINANCIALS CONTEXT</b>",
    "⚡ <b>BOTTOM LINE</b>",
  ];

  const hasAllSections = requiredSections.every((section) => body.includes(section));
  const hasNoTableBlocks = !/TABLE_START|TABLE_END/i.test(body);
  const hasSufficientLength = body.trim().length >= 450;

  return hasAllSections && hasNoTableBlocks && hasSufficientLength;
}
