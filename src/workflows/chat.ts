import { fetchSentiment } from "../clients/manus.js";
import { classifyChatIntent, generateDirectChatAnswer, planChatResearch, reviewContent, rewriteChatAnswer } from "../clients/openrouter.js";
import { withTimeout } from "../utils/timeout.js";
import { queryPerplexity } from "../clients/perplexity.js";
import { fetchMarketsByTags } from "../clients/supabase.js";
import { extractDomain, escapeHtml } from "../utils/format.js";
import { logger } from "../utils/logger.js";
import { buildCacheKey, getCachedResponse, setCachedResponse, type CacheRequestPayload } from "../utils/cache.js";
import type { PolymarketMarket, SynthesisOutput, WorkflowProgress } from "../types/index.js";

/**
 * /chat is the freestyle mode.
 *
 * User sends any finance question → intent classifier routes the request:
 * - web-needed questions can use a fluid mix of Perplexity, Manus, and Polymarket
 * - timeless/general finance questions are answered directly by the model.
 */

const CHAT_SYSTEM_PROMPT = `You are a knowledgeable financial and markets assistant.

ANSWER-EFFICIENCY RULES:
- Evaluate the question's complexity before answering.
- Simple factual questions (e.g. "What is the current fed funds rate?", "What did the S&P close at?") → 2–3 sentences: state the fact, then add brief context (date, change direction, or comparison).
- Moderate questions (e.g. "Why did gold rally today?") → 3–5 sentences covering the key driver(s) and market reaction.
- Complex analytical questions (e.g. "How might a Fed pause affect EM currencies?") → structured answer, up to 6–8 sentences.
- MINIMUM DEPTH: every answer must contain at least 2 complete sentences with substantive content. Never return just a number, a single phrase, or bare links.

FORMAT:
- Use Telegram HTML tags only: <b>, <i>, <code>, <a href="URL">text</a>
- No Markdown syntax whatsoever
- Be concise and direct
- Include numbers and dates where relevant
- Never pad answers with unnecessary context the user didn't ask for`;

function formatPolymarketSnippet(markets: PolymarketMarket[]): string {
  return markets
    .slice(0, 3)
    .map((market) => {
      const netVol = market.predictions.reduce((s, p) => s + (p.volume || 0), 0);
      const fmtVol = market.totalVolume >= 1_000_000
        ? `${(market.totalVolume / 1_000_000).toFixed(1)}M`
        : market.totalVolume >= 1_000
          ? `${(market.totalVolume / 1_000).toFixed(0)}K`
          : market.totalVolume.toLocaleString();
      const header = `${market.title} (Total market volume: ~$${fmtVol})`;
      const preds = market.predictions
        .slice()
        .sort((a, b) => b.percentage - a.percentage)
        .map((p) => {
          const volPct =
            netVol > 0 && p.volume
              ? ` (${((p.volume / netVol) * 100).toFixed(1)}% of net vol)`
              : "";
          return `• ${p.option}: ${p.percentage}% odds${volPct}`;
        })
        .join("\n");
      return `${header}\n${preds}`;
    })
    .join("\n\n");
}

export async function runChatWorkflow(
  userMessage: string,
  progress: WorkflowProgress
): Promise<SynthesisOutput | string> {
  // ── Cache check ──
  const cachePayload: CacheRequestPayload = { route: "/chat", query: userMessage };
  const cacheKey = buildCacheKey(cachePayload);
  const cached = await getCachedResponse("/chat", cacheKey);
  if (cached) {
    logger.info("chat", `Cache hit for query, returning cached response`);
    return cached;
  }

  // ── Resolve current date/time context ──
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/New_York",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short",
  });
  const timeContext = `Current date and time: ${dateStr}, ${timeStr} (US Eastern).`;

  const intent = await withTimeout(
    classifyChatIntent(userMessage),
    15_000,
    { topicRelevant: true, needsWebSearch: true, maliciousInjection: false, allow: true },
    "chat:classify"
  );
  if (!intent.allow) {
    return (
      "I can help when your question is finance-related " +
      "(e.g. latest market moves, current macro data, recent news)."
    );
  }

  const researchPlan = intent.needsWebSearch
    ? await withTimeout(
        planChatResearch(userMessage),
        15_000,
        { usePerplexity: true, useManus: false, usePolymarket: false, manusTopic: "", polymarketTopics: [] as string[] },
        "chat:plan"
      )
    : {
        usePerplexity: false,
        useManus: false,
        usePolymarket: false,
        manusTopic: "",
        polymarketTopics: [] as string[],
      };

  const usesFluidResearch = researchPlan.usePerplexity || researchPlan.useManus || researchPlan.usePolymarket;
  await progress.update(1, usesFluidResearch ? "Researching web, sentiment, and market odds..." : "Thinking...");

  // Build time-aware query and system prompt
  const timeAwareQuery = `${timeContext}\n\nUser question: ${userMessage}`;
  const timeAwareSystemPrompt = `${CHAT_SYSTEM_PROMPT}\n\n${timeContext} Use this to resolve any relative time references (e.g. "today", "this week", "yesterday", "current") in the user's question. Always ground your answer in the correct date.`;

  try {
    const [perplexityResponse, sentiment, polymarketResults] = await withTimeout(
      Promise.all([
        researchPlan.usePerplexity
          ? queryPerplexity(timeAwareQuery, timeAwareSystemPrompt)
          : Promise.resolve({ content: "", citations: [] as string[] }),
        researchPlan.useManus
          ? fetchSentiment(
              researchPlan.manusTopic?.trim() || userMessage,
              "Summarize the crowd narrative for this finance question and highlight directional sentiment."
            )
          : Promise.resolve(null),
        researchPlan.usePolymarket && researchPlan.polymarketTopics.length > 0
          ? fetchMarketsByTags(researchPlan.polymarketTopics).catch(() => [])
          : Promise.resolve([]),
      ]),
      90_000,
      [{ content: "", citations: [] as string[] }, null, []] as [{ content: string; citations: string[] }, null, never[]],
      "chat:research"
    );

    const topPolymarkets = polymarketResults.flatMap((r) => r.markets).slice(0, 3);

    const evidenceBlocks: string[] = [];
    if (perplexityResponse.content.trim()) {
      evidenceBlocks.push(`Web findings:
${perplexityResponse.content.trim()}`);
    }
    if (sentiment?.summary?.trim()) {
      evidenceBlocks.push(`Social sentiment (Manus):
${sentiment.summary.trim()}`);
    }
    if (topPolymarkets.length > 0) {
      evidenceBlocks.push(`Polymarket pricing:
${formatPolymarketSnippet(topPolymarkets)}`);
    }

    await progress.update(2, "Synthesizing answer...");

    let answerBody: string;
    if (evidenceBlocks.length > 0) {
      answerBody = await generateDirectChatAnswer(
        `${timeContext}\n\nUser question:\n${userMessage}\n\nEvidence:\n${evidenceBlocks.join("\n\n")}\n\nProduce a direct answer that prioritizes the strongest evidence and resolves disagreements across sources.`,
        timeAwareSystemPrompt
      );
    } else {
      answerBody = await generateDirectChatAnswer(timeAwareQuery, timeAwareSystemPrompt);
    }

    if (!answerBody.trim()) {
      return "Couldn't find a good answer for that. Try rephrasing your question.";
    }

    const citationUrls = [
      ...perplexityResponse.citations,
      ...topPolymarkets.map((m) => m.url),
      ...(sentiment?.taskUrl ? [sentiment.taskUrl] : []),
    ];

    let citationFooter = "";
    if (citationUrls.length > 0) {
      const links = [...new Set(citationUrls)]
        .slice(0, 5)
        .map((url) => {
          const label = escapeHtml(extractDomain(url));
          return `• <a href="${escapeHtml(url)}">${label}</a>`;
        })
        .join("\n");
      citationFooter = `\n\n📎 <b>Sources</b>\n${links}`;
    }

    const rawBody = answerBody + citationFooter;
    const rewrittenBody =
      answerBody.length >= 80
        ? await rewriteChatAnswer(userMessage, rawBody)
        : rawBody;
    const reviewedBody = await withTimeout(
      reviewContent(rewrittenBody, false),
      30_000,
      rewrittenBody, // fallback to unreviewed content
      "chat:review"
    );

    const result: SynthesisOutput = {
      topic: "Chat",
      body: reviewedBody,
      citations: [],
      timestamp: new Date(),
    };

    setCachedResponse("/chat", cacheKey, cachePayload, result).catch(() => {});
    return result;
  } catch (err) {
    logger.error("chat", `Chat query failed: ${err}`);
    return "Something went wrong. Please try again.";
  }
}
