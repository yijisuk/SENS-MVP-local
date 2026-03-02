import Perplexity from "@perplexity-ai/perplexity_ai";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import type { NewsItem } from "../types/index.js";

const client = new Perplexity({
  apiKey: config.PERPLEXITY_API_KEY,
  timeout: 30_000, // 30 s — prevent hung requests from stalling workflows
});

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

/**
 * Generic Perplexity query — used across all workflows.
 * Each workflow defines its own precise questions.
 */
export async function queryPerplexity(
  question: string,
  systemPrompt?: string
): Promise<{ content: string; citations: string[] }> {
  const completion = await client.chat.completions.create({
    model: "sonar",
    messages: [
      {
        role: "system",
        content:
          systemPrompt ??
          "You are a research analyst. " +
            "Answer with concrete facts, numbers, and dates. " +
            "Do not speculate. If information is unavailable, say so explicitly.",
      },
      { role: "user", content: question },
    ],
    search_recency_filter: "week",
    web_search_options: {
      search_context_size: "high",
    },
  });

  const content = extractTextContent(
    completion.choices?.[0]?.message?.content ?? ""
  );
  const citations: string[] = (completion as any).citations ?? [];

  return { content, citations };
}

/**
 * Runs multiple precise questions in parallel and returns NewsItems.
 */
export async function fetchNews(
  queries: string[],
  context: string,
  systemPrompt?: string
): Promise<NewsItem[]> {
  logger.info("perplexity", `Fetching ${context} (${queries.length} queries)`);

  const results = await Promise.allSettled(
    queries.map(async (query) => {
      const response = await queryPerplexity(query, systemPrompt);
      return {
        summary: response.content,
        citations: response.citations,
        query,
      } satisfies NewsItem;
    })
  );

  const news: NewsItem[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      news.push(result.value);
    } else {
      logger.warn("perplexity", `Query failed: ${result.reason}`);
    }
  }

  logger.info("perplexity", `Got ${news.length}/${queries.length} successful responses`);
  return news;
}
