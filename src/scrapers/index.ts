// ─── Scraper Module ───
//
// Exports the ScrapeGraphAI SmartScraper as the scraping backend.

export {
  scrape,
  isScrapingAvailable,
  disableScraping,
} from "./scrapegraph.js";

export type { ScrapeRequest, ScrapeResponse } from "./scrapegraph.js";
