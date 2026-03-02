import { fetchNews } from "../clients/perplexity.js";
import { fetchMarketsByTags } from "../clients/supabase.js";
import { fetchSentimentBatch } from "../clients/manus.js";
import { extractConcepts, synthesize } from "../clients/openrouter.js";
import { withTimeout } from "../utils/timeout.js";
import { logger } from "../utils/logger.js";
import { buildCacheKey, getCachedResponse, setCachedResponse, type CacheRequestPayload } from "../utils/cache.js";
import type {
  SynthesisOutput,
  WorkflowProgress,
  SentimentResult,
  PolymarketResult,
} from "../types/index.js";

// ─── Timeout Budgets ───
const NEWS_TIMEOUT_MS = 90_000;          // 90 s — Perplexity news scan
const SYNTHESIS_TIMEOUT_MS = 120_000;    // 120 s — OpenRouter synthesis
const SENTIMENT_TIMEOUT_MS = 210_000;    // 210 s — single batched Manus task takes ~2–3 min
const SUPABASE_TIMEOUT_MS = 15_000;      // 15 s — Supabase DB query (replaces Polymarket SPA scraping)
const STEP3_TIMEOUT_MS = 270_000;        // 270 s — accommodate Manus batch (2–3 min)

/**
 * /geopolitics — 4-Step Pyramid
 *
 * Step 1: Perplexity 24h geopolitical scan
 * Step 2: Flashpoint extraction (FAST tier via OpenRouter)
 * Step 3: Per-flashpoint sentiment + Polymarket (parallel, timeout-guarded)
 * Step 4: Synthesis (FULL tier via OpenRouter)
 */
export async function runGeopoliticsWorkflow(
  progress: WorkflowProgress
): Promise<SynthesisOutput | string> {
  // ── Cache check (30-min TTL) ──
  const cachePayload: CacheRequestPayload = { route: "/geopolitics" };
  const cacheKey = buildCacheKey(cachePayload);
  const cached = await getCachedResponse("/geopolitics", cacheKey);
  if (cached) {
    logger.info("geopolitics", "Cache hit, returning cached response");
    return cached;
  }

  // ── Step 1 ──
  await progress.update(1, "Scanning geopolitical developments (last 24h)...");

  const news = await withTimeout(
    fetchNews(
      [
        `What are the most significant geopolitical developments in the past 24 hours ` +
          `that could impact global financial markets? Cover: US foreign policy, ` +
          `trade/tariff actions, military conflicts, sanctions, diplomatic shifts, ` +
          `elections, and supply chain disruptions. Be specific.`,
      ],
      "geopolitics:overview",
      "You are a geopolitical risk analyst focused on market impact. " +
        "Report only on events from the last 24 hours. " +
        "Every event must include its market transmission channel."
    ),
    NEWS_TIMEOUT_MS,
    [],
    "geopolitics:news"
  );

  if (news.length === 0 || !news[0]?.summary) {
    await progress.done();
    return "Could not retrieve geopolitical data. Try again in a moment.";
  }

  // ── Step 2 ──
  await progress.update(2, "Identifying active flashpoints...");

  const concepts = await extractConcepts(news[0].summary, "geopolitics");

  if (concepts.length === 0) {
    await progress.done();
    return synthesize({
      topic: "Geopolitics & Global Risk", news, polymarkets: [], sentiment: null,
    });
  }

  // ── Step 3 ──
  await progress.update(
    3,
    `Researching ${concepts.length} flashpoints (sentiment + markets)...`
  );

  // 3a. Manus sentiment — single batched task for all flashpoints (~2–3 min)
  const sentimentBatchPromise = withTimeout(
    fetchSentimentBatch(
      concepts.map((c) => ({
        name: c.name,
        context:
          `Research positioning on: ${c.name}. Check Polymarket, X, Reddit. ` +
          `Was this priced in? Escalation probability. Key catalysts.`,
      }))
    ).catch(() => Object.fromEntries(concepts.map((c) => [c.name, null]))),
    SENTIMENT_TIMEOUT_MS,
    Object.fromEntries(concepts.map((c) => [c.name, null])),
    "sentiment:batch"
  );

  // 3b. Supabase prediction markets (tag: 'geopolitics')
  const polyPromise = withTimeout(
    fetchMarketsByTags(["geopolitics"]).catch(() => [] as PolymarketResult[]),
    SUPABASE_TIMEOUT_MS,
    [] as PolymarketResult[],
    "supabase:geopolitics",
  );

  // Wait for all parallel work — with an overall Step 3 hard cap
  const [conceptSentiments, polyResults] = await withTimeout(
    Promise.all([
      sentimentBatchPromise,
      polyPromise.catch(() => [] as PolymarketResult[]),
    ]),
    STEP3_TIMEOUT_MS,
    [
      Object.fromEntries(concepts.map((c) => [c.name, null])) as Record<string, SentimentResult | null>,
      [] as PolymarketResult[],
    ],
    "step3:all"
  );

  // ── Step 4 ──
  await progress.update(4, "Synthesizing geopolitical intelligence...");

  const result = await withTimeout(
    synthesize({
      topic: "Geopolitics & Global Risk",
      news,
      polymarkets: polyResults as PolymarketResult[],
      sentiment: null,
      conceptSentiments,
    }),
    SYNTHESIS_TIMEOUT_MS,
    { topic: "Geopolitics & Global Risk", body: "Synthesis timed out. Please try again.", citations: [], timestamp: new Date() } as SynthesisOutput,
    "geopolitics:synthesis"
  );

  setCachedResponse("/geopolitics", cacheKey, cachePayload, result).catch(() => {});
  return result;
}
