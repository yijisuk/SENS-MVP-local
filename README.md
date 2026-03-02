# SENS-MVP-local

**Check the Korean demo videos via [linktr.ee/thesensbot](https://linktr.ee/thesensbot)**

> SENS is a Telegram-based service that uses LLMs to unify three heterogeneous data sources — news (facts), prediction markets (probabilities), and social media (sentiment) — delivering multi-layered market intelligence to investors.

A locally runnable Node.js version of SENS — an AI-powered financial intelligence Telegram bot that delivers comprehensive analysis across macroeconomics, geopolitics, and US equities. 

---

## Introduction

SENS is designed for proactive, part-time retail investors who manage US-listed equity portfolios. Rather than relying on emotional decisions or entertainment-focused media, SENS empowers users to build strategies with a probabilistic edge based on macroeconomic data and corporate financials.

By leveraging an agent-based workflow, SENS orchestrates multiple LLMs (via OpenRouter) to synthesize factual news (Perplexity AI), predictive market probabilities (Polymarket), and qualitative market sentiment (Manus AI) into actionable intelligence. 

---

## Pain Points & Solutions

### 1. Information Overload & Fragmentation
**Pain Point:** Investors must individually check macro news, interest rates, prediction markets, and sentiment indicators across multiple sources. Synthesizing this into an actionable judgment takes 1–2 hours daily.
**Solution (Automated Synthesis):** SENS automatically collects and synthesizes all these disparate sources into a core insight briefing within 3 minutes, triggered by a single Telegram command.

### 2. Language & Time Zone Barriers
**Pain Point:** Tracking real-time English sources (FRED, Polymarket, US financial news) presents language and time zone hurdles. Existing secondary Korean media often lacks speed, accuracy, and objectivity.
**Solution (Real-time Korean Briefings):** Through LLM-based automatic translation and summarization, SENS provides immediate Korean briefings sourced directly from reliable, primary English data.

### 3. Disconnected Equity Analysis
**Pain Point:** News, sentiment indicators, and macroeconomic data related to individual stocks are scattered, making it excessively time-consuming to build the context needed for entry and exit timing.
**Solution (On-Demand Deep Dives):** SENS offers instant, integrated analysis of individual equities upon request. It combines fundamental financial analysis, valuation metrics, real-time news, and market participant sentiment into a single, comprehensive corporate evaluation.

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
