import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { SynthesisOutput, FredChartResult } from "../types/index.js";

// ─── Supabase client (service-role, bypasses RLS) ───

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY);

// ─── TTL Configuration (seconds) ───

const ROUTE_TTL: Record<string, number | null> = {
  "/equity": 12 * 60 * 60,   // 12 hours
  "/chat": 60 * 60,           // 1 hour
  "/macro": 30 * 60,          // 30 minutes
  "/geopolitics": 30 * 60,    // 30 minutes
};

// ─── Types ───

export interface CacheRequestPayload {
  route: string;
  query?: string;
  ticker?: string;
  [key: string]: unknown;
}

interface SerializedChart {
  buffer_base64: string;
  title: string;
  seriesId: string;
}

// ─── Normalization helpers ───

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function sortKeysRecursively(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysRecursively);
  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysRecursively(record[key]);
        return acc;
      }, {});
  }
  return obj;
}

// ─── Key generation ───

export function buildCacheKey(payload: CacheRequestPayload): string {
  const normalized: Record<string, unknown> = { ...payload };

  if (typeof normalized.query === "string") {
    normalized.query = normalizeText(normalized.query);
  }
  if (typeof normalized.ticker === "string") {
    normalized.ticker = normalized.ticker.toUpperCase().trim();
  }

  const sorted = sortKeysRecursively(normalized);
  const serialized = JSON.stringify(sorted);
  return createHash("sha256").update(serialized).digest("hex");
}

// ─── Chart serialization (Buffer ↔ base64) ───

function serializeCharts(charts: FredChartResult[]): SerializedChart[] {
  return charts.map((c) => ({
    buffer_base64: c.buffer.toString("base64"),
    title: c.title,
    seriesId: c.seriesId,
  }));
}

function deserializeCharts(charts: SerializedChart[]): FredChartResult[] {
  return charts.map((c) => ({
    buffer: Buffer.from(c.buffer_base64, "base64"),
    title: c.title,
    seriesId: c.seriesId,
  }));
}

// ─── Cache read ───

export async function getCachedResponse(
  route: string,
  key: string,
): Promise<SynthesisOutput | null> {
  try {
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("response_cache")
      .select("*")
      .eq("route", route)
      .eq("key", key)
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    // Update hit stats (fire and forget)
    // Wrap in Promise.resolve() because Supabase's PostgrestFilterBuilder
    // returns a PromiseLike (thenable) which lacks .catch() — converting
    // to a real Promise provides the full Promise API.
    Promise.resolve(
      supabase
        .from("response_cache")
        .update({
          hit_count: (data.hit_count ?? 0) + 1,
          last_accessed_at: new Date().toISOString(),
        })
        .eq("id", data.id)
    ).catch(() => {});

    // Reconstruct SynthesisOutput
    const meta = (data.response_meta ?? {}) as Record<string, unknown>;
    const output: SynthesisOutput = {
      topic: (meta.topic as string) ?? "",
      body: data.response_text,
      citations: (meta.citations as string[]) ?? [],
      timestamp: new Date((meta.timestamp as string) ?? data.created_at),
    };

    if (meta.label) {
      output.label = meta.label as string;
    }

    if (Array.isArray(meta.charts) && meta.charts.length > 0) {
      output.charts = deserializeCharts(meta.charts as SerializedChart[]);
    }

    logger.info(
      "cache",
      `HIT ${route} [key=${key.slice(0, 8)}…] hits=${(data.hit_count ?? 0) + 1}`,
    );
    return output;
  } catch (err) {
    logger.warn("cache", `Read failed: ${err}`);
    return null;
  }
}

// ─── Cache write (append) ───

export async function setCachedResponse(
  route: string,
  key: string,
  request: CacheRequestPayload,
  output: SynthesisOutput,
): Promise<void> {
  try {
    const ttlSeconds = ROUTE_TTL[route] ?? null;
    const expiresAt =
      ttlSeconds != null
        ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
        : null;

    const meta: Record<string, unknown> = {
      topic: output.topic,
      citations: output.citations,
      timestamp: output.timestamp.toISOString(),
    };

    if (output.label) meta.label = output.label;
    if (output.charts?.length) {
      meta.charts = serializeCharts(output.charts);
    }

    const { error } = await supabase.from("response_cache").insert({
      route,
      key,
      request,
      response_text: output.body,
      response_meta: meta,
      expires_at: expiresAt,
      hit_count: 1,
      last_accessed_at: new Date().toISOString(),
    });

    if (error) {
      logger.warn("cache", `Write failed: ${error.message}`);
    } else {
      logger.info(
        "cache",
        `WRITE ${route} [key=${key.slice(0, 8)}…] ttl=${ttlSeconds ?? "none"}`,
      );
    }
  } catch (err) {
    logger.warn("cache", `Write error: ${err}`);
  }
}

// ─── Maintenance: purge expired entries ───

export async function cleanupExpiredCache(): Promise<number> {
  try {
    // Delete entries that expired more than 1 day ago
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("response_cache")
      .delete()
      .not("expires_at", "is", null)
      .lt("expires_at", cutoff)
      .select("id");

    if (error) {
      logger.warn("cache", `Cleanup failed: ${error.message}`);
      return 0;
    }

    const count = data?.length ?? 0;
    if (count > 0) {
      logger.info("cache", `Cleaned up ${count} expired cache entries`);
    }
    return count;
  } catch (err) {
    logger.warn("cache", `Cleanup error: ${err}`);
    return 0;
  }
}
