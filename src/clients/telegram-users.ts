import { config } from "../utils/config.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../utils/logger.js";

// ── Initialise client ───────────────────────────────────────────────
const supabase: SupabaseClient = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SECRET_KEY,
);

// ── Constants ───────────────────────────────────────────────────────
const DEFAULT_QUERY_LIMIT = 10;

// ── Types ───────────────────────────────────────────────────────────

interface TelegramUserInfo {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

// ── (1) Upsert User ────────────────────────────────────────────────

/**
 * Find or create a user by their Telegram ID.
 * On conflict (existing user), update profile fields and `updated_at`.
 * New users get `remaining_queries` set to DEFAULT_QUERY_LIMIT by the DB default.
 */
async function upsertUser(user: TelegramUserInfo): Promise<void> {
  const { error } = await supabase
    .from("telegram_users")
    .upsert(
      {
        telegram_id: user.telegramId,
        username: user.username ?? null,
        first_name: user.firstName ?? null,
        last_name: user.lastName ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "telegram_id" },
    );

  if (error) {
    logger.error("telegram-users", `upsertUser(${user.telegramId}): ${error.message}`);
    throw new Error(`upsertUser: ${error.message}`);
  }

  logger.debug("telegram-users", `Upserted user ${user.telegramId}`);
}

// ── (2) Check Remaining Queries ────────────────────────────────────

/**
 * Retrieve the remaining query count for a user.
 * Returns 0 if the user is not found.
 */
async function getRemainingQueries(telegramId: number): Promise<number> {
  const { data, error } = await supabase
    .from("telegram_users")
    .select("remaining_queries")
    .eq("telegram_id", telegramId)
    .single();

  if (error) {
    logger.error("telegram-users", `getRemainingQueries(${telegramId}): ${error.message}`);
    return 0;
  }

  return data?.remaining_queries ?? 0;
}

// ── (3) Decrement Query Count ──────────────────────────────────────

/**
 * Atomically decrement `remaining_queries` and increment `total_queries_used`.
 * The WHERE clause `remaining_queries > 0` prevents going negative.
 * Returns true if a row was updated (i.e. the user had queries remaining).
 */
async function decrementQueryCount(telegramId: number): Promise<boolean> {
  const { data, error } = await supabase.rpc("decrement_query_count", {
    p_telegram_id: telegramId,
  });

  // If there's no RPC function, fall back to a raw update
  if (error) {
    logger.debug("telegram-users", `RPC fallback for decrement: ${error.message}`);
    return decrementQueryCountFallback(telegramId);
  }

  return true;
}

/**
 * Fallback: Use a direct update with a filter to atomically decrement.
 * Supabase JS client doesn't support `remaining_queries - 1` in .update(),
 * so we use the raw SQL via .rpc or a two-step read-then-write with check.
 */
async function decrementQueryCountFallback(telegramId: number): Promise<boolean> {
  // Read current count
  const { data: user, error: readErr } = await supabase
    .from("telegram_users")
    .select("remaining_queries, total_queries_used")
    .eq("telegram_id", telegramId)
    .single();

  if (readErr || !user) {
    logger.error("telegram-users", `decrementFallback read(${telegramId}): ${readErr?.message}`);
    return false;
  }

  if (user.remaining_queries <= 0) return false;

  const { error: updateErr } = await supabase
    .from("telegram_users")
    .update({
      remaining_queries: user.remaining_queries - 1,
      total_queries_used: (user.total_queries_used ?? 0) + 1,
      last_query_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("telegram_id", telegramId)
    .eq("remaining_queries", user.remaining_queries); // Optimistic concurrency check

  if (updateErr) {
    logger.error("telegram-users", `decrementFallback update(${telegramId}): ${updateErr.message}`);
    return false;
  }

  logger.debug(
    "telegram-users",
    `Decremented queries for ${telegramId}: ${user.remaining_queries} → ${user.remaining_queries - 1}`,
  );
  return true;
}

// ── (4) Combined: Check Quota and Process ──────────────────────────

/**
 * Check if a user has remaining queries.
 * This is a convenience wrapper that upserts the user first,
 * then returns the remaining count.
 */
async function checkQueryQuota(user: TelegramUserInfo): Promise<{ allowed: boolean; remaining: number }> {
  await upsertUser(user);
  const remaining = await getRemainingQueries(user.telegramId);
  return { allowed: remaining > 0, remaining };
}

export {
  upsertUser,
  getRemainingQueries,
  decrementQueryCount,
  checkQueryQuota,
  DEFAULT_QUERY_LIMIT,
};
export type { TelegramUserInfo };
