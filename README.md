# SENS-MVP-local

A locally runnable Node.js version of [SENS-MVP](https://github.com/yijisuk/SENS-MVP) — a Telegram bot that delivers AI-powered financial intelligence across macro economics, geopolitics, equity analysis, and more.

This repository is a direct reformat of the original Cloudflare Workers-based codebase into a standard Node.js long-polling setup. All core logic, workflows, and API integrations are preserved; only the infrastructure layer has been adapted.

---

## Key Differences from SENS-MVP

| Aspect | SENS-MVP (Cloudflare Workers) | SENS-MVP-local (Node.js) |
|---|---|---|
| **Transport** | Webhook (HTTP POST) | Long-polling (`bot.launch()`) |
| **Session storage** | Cloudflare KV (cross-isolate) | In-memory `Map` (process-scoped) |
| **Background jobs** | Cloudflare Queues | Native `Promise` + `setInterval` |
| **Config** | `wrangler.toml` + secrets | `.env` file via `dotenv` |
| **Deployment** | `wrangler deploy` | `node` / `tsx` directly |
| **CPU limits** | 5 min (Workers Unbound) | Unlimited |

---

## Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later
- API keys for all required services (see `.env.example`)

---

## Setup

**1. Clone the repository**

```bash
git clone https://github.com/yijisuk/SENS-MVP-local.git
cd SENS-MVP-local
```

**2. Install dependencies**

```bash
npm install
```

**3. Configure environment variables**

```bash
cp .env.example .env
```

Open `.env` and fill in all required values. Refer to the comments in `.env.example` for where to obtain each key.

---

## Running the Bot

**Development mode** (with hot-reload via `tsx --watch`):

```bash
npm run dev
```

**Production mode** (single run via `tsx`):

```bash
npm start
```

**Compiled mode** (TypeScript to JavaScript, then run):

```bash
npm run build
npm run start:compiled
```

---

## Available Commands

| Command | Description |
|---|---|
| `/start` | Welcome message and query balance |
| `/macro` | US macro & rates intelligence |
| `/geopolitics` | Geopolitical risk analysis |
| `/briefing` | Daily multi-domain briefing |
| `/equity <TICKER>` | Single stock deep-dive with charts |
| `/chat` | Free-form financial Q&A |
| `/status` | Check remaining query balance |
| `/help` | List all commands |

---

## Architecture

```
src/
├── index.ts              # Entry point — dotenv + bot.launch() + cleanup intervals
├── bot/
│   ├── telegram.ts       # Telegraf bot setup, command handlers, output rendering
│   └── session.ts        # In-memory session state machine (idle/busy/awaiting_*)
├── clients/
│   ├── openrouter.ts     # LLM routing (Anthropic / OpenAI / Google / Grok)
│   ├── perplexity.ts     # News & research via Perplexity Sonar
│   ├── fred.ts           # FRED macro data + QuickChart rendering
│   ├── fmp.ts            # Financial Modeling Prep — financials & ratios
│   ├── equity-charts.ts  # Equity chart rendering via QuickChart
│   ├── equity-eval.ts    # Financial evaluation orchestrator
│   ├── manus.ts          # Manus AI sentiment tasks
│   ├── polymarket.ts     # Polymarket prediction market scraping
│   ├── supabase.ts       # Supabase client (cache + prediction market DB)
│   └── telegram-users.ts # User quota management via Supabase
├── scrapers/
│   ├── index.ts          # Scraper router
│   └── scrapegraph.ts    # ScrapeGraphAI SmartScraper integration
├── types/
│   ├── index.ts          # Shared TypeScript interfaces
│   └── scrapegraph-js.d.ts # Type declarations for scrapegraph-js
├── utils/
│   ├── config.ts         # Environment variable loading and validation (Zod)
│   ├── logger.ts         # Structured console logger
│   ├── format.ts         # Telegram HTML formatting utilities
│   ├── cache.ts          # Supabase-backed response cache
│   ├── market-relevance.ts # Prediction market title relevance scoring
│   ├── ticker-resolver.ts  # Ticker symbol / company name resolution
│   └── timeout.ts        # Promise timeout wrapper
└── workflows/
    ├── macro.ts          # /macro workflow
    ├── geopolitics.ts    # /geopolitics workflow
    ├── briefing.ts       # /briefing workflow
    ├── equity.ts         # /equity workflow
    └── chat.ts           # /chat workflow
```

---

## Required API Keys

| Variable | Service | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram | From [@BotFather](https://t.me/BotFather) |
| `SUPABASE_URL` | Supabase | Project API URL |
| `SUPABASE_SECRET_KEY` | Supabase | Service role key |
| `PERPLEXITY_API_KEY` | Perplexity AI | Sonar model access |
| `OPENROUTER_API_KEY` | OpenRouter | Multi-model LLM routing |
| `MANUS_API_KEY` | Manus AI | Sentiment analysis tasks |
| `FRED_API_KEY` | FRED | Federal Reserve economic data |
| `FMP_API_KEY` | Financial Modeling Prep | Equity financials & ratios |
| `SCRAPEGRAPH_API_KEY` | ScrapeGraphAI | Web scraping (optional but recommended) |
