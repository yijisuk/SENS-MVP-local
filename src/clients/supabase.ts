import { config } from "../utils/config.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../utils/logger.js";
import type { PolymarketMarket, PolymarketResult } from "../types/index.js";

// ── Initialise client ───────────────────────────────────────────────
const supabase: SupabaseClient = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SECRET_KEY,
);

// ── Types ───────────────────────────────────────────────────────────

interface MarketSummary {
  id: string;
  platform: string;
  title: string;
  url: string;
}

interface OutcomeLatest {
  outcome_id: string;
  value: string;
  sort_order: number;
  probability: number;
  scraped_at: string;
}

// ── (1) Get markets by tag ──────────────────────────────────────────

async function getMarketsByTag(tag: string): Promise<MarketSummary[]> {
  const { data, error } = await supabase
    .from("markets")
    .select("id, platform, title, url")
    .eq("tag", tag);

  if (error) throw new Error(`getMarketsByTag: ${error.message}`);
  return data as MarketSummary[];
}

// ── (2) Get latest outcomes for a market ────────────────────────────

async function getLatestOutcomes(marketId: string): Promise<OutcomeLatest[]> {
  const { data, error } = await supabase
    .from("outcomes")
    .select(`
      id,
      value,
      sort_order,
      outcome_snapshots (
        probability,
        scraped_at
      )
    `)
    .eq("market_id", marketId)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(`getLatestOutcomes: ${error.message}`);

  return (data ?? []).map((row: any) => {
    const snaps = row.outcome_snapshots as
      | { probability: number; scraped_at: string }[]
      | null;

    const latest = snaps
      ?.sort(
        (a: { scraped_at: string }, b: { scraped_at: string }) =>
          new Date(b.scraped_at).getTime() - new Date(a.scraped_at).getTime(),
      )
      .at(0);

    return {
      outcome_id: row.id,
      value: row.value,
      sort_order: row.sort_order,
      probability: latest?.probability ?? 0,
      scraped_at: latest?.scraped_at ?? "",
    };
  });
}

// ── (3) Search markets by multiple tags ─────────────────────────────

async function searchMarketsByTags(tags: string[]): Promise<MarketSummary[]> {
  const { data, error } = await supabase
    .from("markets")
    .select("id, platform, title, url")
    .in("tag", tags);

  if (error) throw new Error(`searchMarketsByTags: ${error.message}`);
  return data as MarketSummary[];
}

// ── (4) Fetch markets with latest outcomes, formatted for synthesis ──

/**
 * Retrieve all markets matching the given tags from Supabase,
 * join their latest outcome probabilities, and return as
 * PolymarketResult[] ready for the synthesis pipeline.
 */
async function fetchMarketsByTags(
  tags: string[],
): Promise<PolymarketResult[]> {
  const markets = await searchMarketsByTags(tags);

  if (markets.length === 0) return [];

  const polymarketMarkets: PolymarketMarket[] = await Promise.all(
    markets.map(async (market) => {
      const outcomes = await getLatestOutcomes(market.id);
      return {
        title: market.title,
        url: market.url,
        totalVolume: 0,
        pollEndDate: "",
        daysUntilClose: 999,
        relevanceScore: 1,
        predictions: outcomes.map((o) => ({
          option: o.value,
          percentage: Math.round(o.probability * 100),
          volume: 0,
        })),
      };
    }),
  );

  logger.info(
    "supabase",
    `fetchMarketsByTags([${tags.join(", ")}]): ${polymarketMarkets.length} markets`,
  );

  return polymarketMarkets.length > 0
    ? [{ markets: polymarketMarkets, searchTopic: tags.join("+") }]
    : [];
}

export { getMarketsByTag, getLatestOutcomes, searchMarketsByTags, fetchMarketsByTags };
export type { MarketSummary, OutcomeLatest };
