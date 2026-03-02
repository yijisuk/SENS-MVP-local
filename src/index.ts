/**
 * SENS-MVP-local — Entry Point
 *
 * Runs the Telegram bot in long-polling mode using Node.js.
 * All configuration is loaded from a .env file via dotenv.
 *
 * Usage:
 *   npm start          # run with tsx (no build step required)
 *   npm run dev        # run with tsx --watch (hot-reload)
 *   npm run build && npm run start:compiled  # compile then run
 */
import "dotenv/config";
import { bot } from "./bot/telegram.js";
import { logger } from "./utils/logger.js";
import { cleanupExpiredCache } from "./utils/cache.js";
import { cleanupStaleSessions } from "./bot/session.js";

async function main() {
  logger.info("main", "Starting SENS (local Node.js mode)...");
  logger.info("main", "Transport: Telegram long-polling");
  logger.info("main", "LLM: OpenRouter (Anthropic / OpenAI / Google / Grok)");
  logger.info("main", "Data: Perplexity + ScrapeGraph + Manus + FRED");
  logger.info("main", "Commands: /macro, /geopolitics, /briefing, /equity, /chat");

  // Graceful shutdown
  process.once("SIGINT", () => {
    logger.info("main", "Received SIGINT, stopping...");
    bot.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    logger.info("main", "Received SIGTERM, stopping...");
    bot.stop("SIGTERM");
  });

  await bot.launch();
  logger.info("main", "✅ Bot is running. Press Ctrl+C to stop.");

  // ── Periodic cache cleanup ──
  // Purge Supabase response_cache entries expired >1 day ago, every 6 hours.
  const CACHE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
  setInterval(() => {
    cleanupExpiredCache().catch((err) =>
      logger.warn("main", `Cache cleanup error: ${err}`),
    );
  }, CACHE_CLEANUP_INTERVAL_MS);

  // ── Periodic session cleanup ──
  // Evict in-memory sessions idle for >10 minutes, every 5 minutes.
  const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    cleanupStaleSessions();
  }, SESSION_CLEANUP_INTERVAL_MS);

  // Run both cleanups once at startup (non-blocking)
  cleanupExpiredCache().catch(() => {});
  cleanupStaleSessions();
}

main().catch((err) => {
  logger.error("main", `Fatal error: ${err}`);
  process.exit(1);
});
