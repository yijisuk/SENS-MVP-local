import Perplexity from "@perplexity-ai/perplexity_ai";
import { config } from "./config.js";
import { logger } from "./logger.js";

const client = new Perplexity({
  apiKey: config.PERPLEXITY_API_KEY,
});

/**
 * Common ticker → company name map for fast resolution.
 * Tickers in this map skip external validation (known-good).
 */
const KNOWN_TICKERS: Record<string, string> = {
  AAPL: "Apple", MSFT: "Microsoft", GOOGL: "Alphabet", GOOG: "Alphabet",
  AMZN: "Amazon", NVDA: "NVIDIA", META: "Meta Platforms", TSLA: "Tesla",
  BRK: "Berkshire Hathaway", JPM: "JPMorgan Chase", V: "Visa",
  JNJ: "Johnson & Johnson", WMT: "Walmart", PG: "Procter & Gamble",
  MA: "Mastercard", UNH: "UnitedHealth", HD: "Home Depot", DIS: "Walt Disney",
  BAC: "Bank of America", ADBE: "Adobe", CRM: "Salesforce", NFLX: "Netflix",
  INTC: "Intel", AMD: "AMD", PYPL: "PayPal", CSCO: "Cisco",
  PEP: "PepsiCo", KO: "Coca-Cola", NKE: "Nike", MRK: "Merck",
  ABBV: "AbbVie", LLY: "Eli Lilly", COST: "Costco", AVGO: "Broadcom",
  ORCL: "Oracle", ACN: "Accenture", TXN: "Texas Instruments",
  QCOM: "Qualcomm", UBER: "Uber", SNAP: "Snap", SQ: "Block",
  SHOP: "Shopify", SPOT: "Spotify", PLTR: "Palantir", COIN: "Coinbase",
  RIVN: "Rivian", LCID: "Lucid Motors", ARM: "Arm Holdings",
  SMCI: "Super Micro Computer", MSTR: "MicroStrategy", GME: "GameStop",
  AMC: "AMC Entertainment", SOFI: "SoFi Technologies", RBLX: "Roblox",
  ABNB: "Airbnb", CRWD: "CrowdStrike", SNOW: "Snowflake",
  NET: "Cloudflare", DDOG: "Datadog", ZS: "Zscaler",
  PANW: "Palo Alto Networks", NOW: "ServiceNow", WDAY: "Workday",
  TEAM: "Atlassian", MDB: "MongoDB", OKTA: "Okta", U: "Unity Software",
  PATH: "UiPath", AI: "C3.ai", IONQ: "IonQ", RGTI: "Rigetti Computing",
  TSM: "Taiwan Semiconductor", ASML: "ASML", BABA: "Alibaba",
  PDD: "PDD Holdings", NIO: "NIO", LI: "Li Auto", XPEV: "XPeng",
  BE: "Bloom Energy", PLUG: "Plug Power", FCEL: "FuelCell Energy",
  ENPH: "Enphase Energy", SEDG: "SolarEdge", RUN: "Sunrun",
  SPWR: "SunPower", CHPT: "ChargePoint", QS: "QuantumScape",
  DNA: "Ginkgo Bioworks", JOBY: "Joby Aviation", HOOD: "Robinhood",
  AFRM: "Affirm", UPST: "Upstart", DASH: "DoorDash", LYFT: "Lyft",
  PINS: "Pinterest", TTD: "The Trade Desk", ZM: "Zoom Video",
  ROKU: "Roku", DOCU: "DocuSign", BILL: "BILL Holdings",
  HUBS: "HubSpot", VEEV: "Veeva Systems", TWLO: "Twilio",
  ESTC: "Elastic", CFLT: "Confluent", S: "SentinelOne",
  GTLB: "GitLab", MNDY: "monday.com", DUOL: "Duolingo",
  APP: "AppLovin", CELH: "Celsius Holdings", CAVA: "CAVA Group",
  BIRK: "Birkenstock", ON: "ON Semiconductor",
};

/**
 * Negative list — common English words that are also ticker symbols.
 * These MUST go through external validation to avoid returning
 * irrelevant content (e.g. "be" the verb instead of $BE Bloom Energy).
 */
const AMBIGUOUS_TICKERS = new Set([
  "A", "AN", "ALL", "AM", "ARE", "AS", "AT", "BE", "BIG", "CAN",
  "CAR", "CARE", "CASH", "COST", "DAY", "DO", "FAST", "FIT", "FOR",
  "FUN", "GO", "GOOD", "HAS", "HE", "HI", "HIT", "HOME", "HON",
  "HOT", "ICE", "IT", "KEY", "KIND", "LIFE", "LIVE", "LOW", "MAN",
  "MAT", "MAY", "MET", "MIND", "MOST", "NEAR", "NET", "NEW", "NEXT",
  "NOW", "OLD", "ON", "ONE", "OPEN", "OUR", "OUT", "OWN", "PAY",
  "PLAY", "POST", "REAL", "RIDE", "RUN", "SAFE", "SAY", "SEE",
  "SO", "SUN", "TALK", "TEN", "THE", "TRUE", "TWO", "UP", "US",
  "VERY", "WELL", "WIN", "YOU",
]);

function extractTextContent(
  raw: string | Array<{ type: string; text?: string }>
): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

// ─── Stock Existence Validation ───

/**
 * Validate that a ticker symbol corresponds to a real, publicly traded stock
 * by checking Yahoo Finance's quote endpoint (no API key required).
 *
 * Returns the company name from Yahoo if valid, or null if not found.
 */
async function validateTickerExists(
  ticker: string
): Promise<{ valid: boolean; companyName?: string }> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=5&newsCount=0&listsCount=0`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      // Consume body to prevent CF Workers stalled response deadlock
      await response.text().catch(() => {});
      logger.warn("ticker", `Yahoo Finance search returned ${response.status} for ${ticker}`);
      return { valid: false };
    }

    const data = (await response.json()) as {
      quotes?: Array<{
        symbol?: string;
        shortname?: string;
        longname?: string;
        quoteType?: string;
        exchange?: string;
      }>;
    };

    if (!data.quotes || data.quotes.length === 0) {
      return { valid: false };
    }

    // Find an exact match for the ticker among equity results
    const match = data.quotes.find(
      (q) =>
        q.symbol?.toUpperCase() === ticker.toUpperCase() &&
        (q.quoteType === "EQUITY" || q.quoteType === "ETF")
    );

    if (match) {
      const name = match.longname || match.shortname || undefined;
      return { valid: true, companyName: name };
    }

    // Also accept if the first result is a close match (e.g. BE vs BE)
    const first = data.quotes[0];
    if (
      first?.symbol?.toUpperCase() === ticker.toUpperCase() &&
      first.quoteType &&
      ["EQUITY", "ETF", "MUTUALFUND"].includes(first.quoteType)
    ) {
      const name = first.longname || first.shortname || undefined;
      return { valid: true, companyName: name };
    }

    return { valid: false };
  } catch (err) {
    logger.warn("ticker", `Yahoo Finance validation failed for ${ticker}: ${err}`);
    // On network error, don't block — fall through to Perplexity resolution
    return { valid: true };
  }
}

// ─── Reverse Lookup: Company Name → Ticker ───

/**
 * Build a reverse map from company name → ticker for fast lookup.
 */
function buildReverseLookup(): Map<string, string> {
  const reverse = new Map<string, string>();
  for (const [ticker, name] of Object.entries(KNOWN_TICKERS)) {
    reverse.set(name.toLowerCase(), ticker);
  }
  return reverse;
}

const REVERSE_LOOKUP = buildReverseLookup();

/**
 * Check if the input looks like a company name rather than a ticker symbol.
 * Company names: contain spaces, are longer than 5 chars, or contain lowercase.
 */
function looksLikeCompanyName(input: string): boolean {
  if (input.includes(" ")) return true;
  if (input.length > 5 && input !== input.toUpperCase()) return true;
  // All-lowercase inputs longer than 4 chars are likely company names
  if (input === input.toLowerCase() && input.length > 4) return true;
  return false;
}

/**
 * Resolve a company name to a ticker via reverse lookup or Yahoo Finance search.
 */
async function resolveCompanyNameToTicker(
  name: string
): Promise<{ ticker: string; companyName: string } | null> {
  const normalized = name.toLowerCase().trim();

  // Check reverse lookup first
  const knownTicker = REVERSE_LOOKUP.get(normalized);
  if (knownTicker) {
    return { ticker: knownTicker, companyName: KNOWN_TICKERS[knownTicker] };
  }

  // Search Yahoo Finance for the company name
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=5&newsCount=0&listsCount=0`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      // Consume body to prevent CF Workers stalled response deadlock
      await response.text().catch(() => {});
      return null;
    }

    const data = (await response.json()) as {
      quotes?: Array<{
        symbol?: string;
        shortname?: string;
        longname?: string;
        quoteType?: string;
      }>;
    };

    if (!data.quotes || data.quotes.length === 0) return null;

    // Find the first equity/ETF result
    const match = data.quotes.find(
      (q) => q.quoteType === "EQUITY" || q.quoteType === "ETF"
    );

    if (match?.symbol) {
      const ticker = match.symbol.toUpperCase();
      const companyName = match.longname || match.shortname || name;
      logger.info("ticker", `Company name "${name}" resolved to ${ticker} (${companyName})`);
      KNOWN_TICKERS[ticker] = companyName;
      return { ticker, companyName };
    }

    return null;
  } catch (err) {
    logger.warn("ticker", `Company name search failed for "${name}": ${err}`);
    return null;
  }
}

// ─── Public API ───

/**
 * Resolves a ticker symbol OR company name to a { ticker, companyName } pair.
 *
 * Accepted input formats:
 *   - Ticker symbol: "NVDA", "nvda", "$NVDA"
 *   - Company name: "nvidia", "Bloom Energy", "apple"
 *
 * Validation flow:
 *   1. Strip $ prefix, detect if input is a company name
 *   2. For company names: reverse lookup → Yahoo Finance search
 *   3. For tickers: KNOWN_TICKERS map → Yahoo Finance validation → Perplexity
 *
 * Returns null if the ticker/company is not a real publicly traded stock.
 */
export async function resolveTicker(
  input: string
): Promise<{ ticker: string; companyName: string } | null> {
  const cleaned = input.replace(/^\$/, "").trim();

  // ── Check if input looks like a company name ──
  if (looksLikeCompanyName(cleaned)) {
    logger.info("ticker", `Input "${cleaned}" looks like a company name, resolving...`);
    const result = await resolveCompanyNameToTicker(cleaned);
    if (result) return result;
    // If company name resolution fails, try as a ticker anyway
  }

  const normalized = cleaned.toUpperCase();

  // ── Fast path: known ticker that isn't ambiguous ──
  if (KNOWN_TICKERS[normalized] && !AMBIGUOUS_TICKERS.has(normalized)) {
    return { ticker: normalized, companyName: KNOWN_TICKERS[normalized] };
  }

  // ── Validate the ticker actually exists as a traded stock ──
  logger.info("ticker", `Validating ticker "${normalized}" via Yahoo Finance`);
  const validation = await validateTickerExists(normalized);

  if (!validation.valid) {
    logger.warn("ticker", `Ticker "${normalized}" not found on any exchange`);
    return null;
  }

  // If we have a known name and Yahoo confirmed it exists, use the known name
  if (KNOWN_TICKERS[normalized]) {
    return { ticker: normalized, companyName: KNOWN_TICKERS[normalized] };
  }

  // If Yahoo returned a company name, use it directly
  if (validation.companyName) {
    logger.info("ticker", `Yahoo resolved "${normalized}" → "${validation.companyName}"`);
    KNOWN_TICKERS[normalized] = validation.companyName;
    return { ticker: normalized, companyName: validation.companyName };
  }

  // ── Fallback: resolve company name via Perplexity ──
  logger.info("ticker", `Resolving company name for "${normalized}" via Perplexity`);

  try {
    const completion = await client.chat.completions.create({
      model: "sonar",
      messages: [
        {
          role: "system",
          content:
            "You are a stock ticker resolver. " +
            "Given a ticker symbol that is confirmed to be a real publicly traded stock, " +
            "respond with ONLY the company name (e.g. 'Bloom Energy' for BE, 'SentinelOne' for S). " +
            "Do NOT explain what the word means in English. " +
            "If you cannot determine the company, respond with exactly: UNKNOWN",
        },
        {
          role: "user",
          content:
            `The stock ticker ${normalized} is a real publicly traded company. ` +
            `What is the company name for ticker symbol $${normalized}?`,
        },
      ],
    });

    const answer = extractTextContent(
      completion.choices?.[0]?.message?.content ?? ""
    ).trim();

    if (answer === "UNKNOWN" || answer.length === 0 || answer.length > 100) {
      return null;
    }

    KNOWN_TICKERS[normalized] = answer;
    return { ticker: normalized, companyName: answer };
  } catch (err) {
    logger.error("ticker", `Perplexity resolution failed for ${normalized}: ${err}`);
    return null;
  }
}
