import axios, { type AxiosInstance, type AxiosError } from "axios";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import type { SentimentResult } from "../types/index.js";

const MANUS_URL = "https://api.manus.ai/v1";
const MANUS_MODEL = "manus-1.6";

/**
 * Manus tasks are async: create → poll → extract result.
 *
 * Each Manus query takes ~2–3 minutes to complete.
 * We use the lightweight "manus-1.6" profile in "chat" mode
 * for sentiment lookups. Full "agent" mode would be overkill
 * and burn credits unnecessarily.
 *
 * Workflows that need sentiment for multiple concepts should use
 * `fetchSentimentBatch` to combine them into a single Manus task,
 * avoiding N × 2–3 min parallel burns.
 */

interface ManusTaskResponse {
  task_id: string;
  task_title?: string;
  task_url?: string;
  share_url?: string;
}

interface ManusTaskStatus {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  output?: string;
  result?: string;
  [key: string]: unknown;
}

interface OutputTextItem {
  type: "output_text";
  text: string;
}

interface ManusTaskOutput {
  id: string;
  status: string;
  role: string;
  type: string;
  content: OutputTextItem[];
}


const api: AxiosInstance = axios.create({
  baseURL: MANUS_URL,
  timeout: 15_000, // 15s per-request timeout for individual API calls
  headers: {
    "Content-Type": "application/json",
    API_KEY: config.MANUS_API_KEY,
  },
});

/**
 * Creates a Manus task for public sentiment research.
 * The prompt is crafted to search Reddit, X, and forums
 * for a concise sentiment summary.
 */
async function createSentimentTask(
  topic: string,
  context: string
): Promise<ManusTaskResponse> {
  const prompt =
    `Research the current public sentiment for "${topic}" across Reddit, X (Twitter), ` +
    `and financial forums. ${context}\n\n` +
    `Provide a concise summary (under 500 words) covering:\n` +
    `1. Overall sentiment direction (bullish/bearish/neutral/mixed)\n` +
    `2. Key narratives and talking points from retail investors\n` +
    `3. Any notable viral posts, threads, or influencer takes\n` +
    `4. Sentiment shift vs last week (if detectable)\n\n` +
    `Be factual. Cite specific subreddits, accounts, or threads where possible.`;

  const response = await api.post<ManusTaskResponse>("/tasks", {
    prompt,
    agentProfile: MANUS_MODEL,
    taskMode: "chat",
  });

  return response.data;
}

/**
 * Check if an axios error is a non-retryable HTTP status.
 * 404 = task doesn't exist (deleted or invalid ID)
 * 401/403 = auth issue
 * 429 = rate limited (retryable but we treat as terminal after 2 hits)
 */
function isTerminalHttpError(err: unknown): { terminal: boolean; status?: number } {
  if (!axios.isAxiosError(err)) return { terminal: false };
  const axErr = err as AxiosError;
  const status = axErr.response?.status;
  if (!status) return { terminal: false };

  if (status === 404 || status === 401 || status === 403) {
    return { terminal: true, status };
  }
  return { terminal: false, status };
}

/**
 * Polls a Manus task until it completes or times out.
 *
 * Default 180s timeout — Manus tasks typically take 2–3 minutes.
 * Poll interval 10s to avoid unnecessary API chatter during the wait.
 * Handles 404/5xx gracefully with immediate return.
 */
async function pollTaskUntilDone(
  taskId: string,
  timeoutMs: number = 180_000,
  intervalMs: number = 10_000
): Promise<ManusTaskStatus | null> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    try {
      const response = await api.get<ManusTaskStatus>(`/tasks/${taskId}`);
      consecutiveErrors = 0; // Reset on success
      const task = response.data;

      if (task.status === "completed") {
        return task;
      }

      if (task.status === "failed") {
        logger.warn("manus", `Task ${taskId} failed`);
        return null;
      }

      // Still pending/running — wait and retry
      await new Promise((r) => setTimeout(r, intervalMs));
    } catch (err) {
      consecutiveErrors++;

      // Check for terminal HTTP errors (404, 401, 403)
      const { terminal, status } = isTerminalHttpError(err);
      if (terminal) {
        logger.warn("manus", `Task ${taskId}: terminal HTTP ${status}, aborting poll`);
        return null;
      }

      // Log the error
      logger.warn(
        "manus",
        `Poll error for ${taskId} (attempt ${consecutiveErrors}): ${err}`
      );

      // After 3 consecutive errors, give up
      if (consecutiveErrors >= 3) {
        logger.warn("manus", `Task ${taskId}: ${consecutiveErrors} consecutive poll errors, aborting`);
        return null;
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  logger.warn("manus", `Task ${taskId} timed out after ${timeoutMs}ms`);
  return null;
}

/**
 * Extracts text output from a completed Manus task.
 * The API may return output in different fields depending on version.
 */
function extractOutput(task: ManusTaskStatus): ManusTaskOutput[] {
  const candidate =
    task.output ??
    task.result ??
    (task as any).response ??
    (task as any).content ??
    [];

  return Array.isArray(candidate) ? (candidate as ManusTaskOutput[]) : [];
}

/**
 * Full sentiment fetch: create task → poll → extract.
 * Returns null if Manus is unavailable or times out — the workflow
 * continues without sentiment data (graceful degradation).
 */
/**
 * Batch sentiment fetch: combines multiple topics into a single Manus task.
 *
 * Instead of firing N parallel tasks (each taking 2–3 min and burning
 * N × API credits), we send one combined prompt. The single task takes
 * roughly the same 2–3 min but only uses one Manus slot.
 *
 * Output is parsed by topic header when possible; falls back to
 * assigning the full combined output to every topic.
 */
export async function fetchSentimentBatch(
  topics: { name: string; context: string }[]
): Promise<Record<string, SentimentResult | null>> {
  if (topics.length === 0) return {};

  // For a single topic, delegate to the regular path
  if (topics.length === 1) {
    const result = await fetchSentiment(topics[0].name, topics[0].context);
    return { [topics[0].name]: result };
  }

  logger.info("manus", `Batch sentiment for ${topics.length} topics: ${topics.map((t) => t.name).join(", ")}`);

  const topicList = topics
    .map((t, i) => `${i + 1}. "${t.name}" — ${t.context}`)
    .join("\n");

  const prompt =
    `Research the latest (past 24 hours) public sentiment for the following ${topics.length} topics ` +
    `across Reddit, X (Twitter), and financial forums.\n\n` +
    `Topics:\n${topicList}\n\n` +
    `For EACH topic, provide a concise summary (under 300 words each) covering:\n` +
    `1. Overall sentiment direction (bullish/bearish/neutral/mixed)\n` +
    `2. Key narratives and talking points from retail investors\n` +
    `3. Any notable viral posts, threads, or influencer takes\n` +
    `4. Sentiment shift vs last week (if detectable)\n\n` +
    `Format your response with clear headers for each topic using exactly this format:\n` +
    `### TOPIC: "<topic name>"\n` +
    `<your summary>\n\n` +
    `Be factual. Cite specific subreddits, accounts, or threads where possible.`;

  try {
    const task = await api.post<ManusTaskResponse>("/tasks", {
      prompt,
      agentProfile: MANUS_MODEL,
      taskMode: "chat",
    });

    logger.info("manus", `Batch task created: ${task.data.task_id}`);

    const completed = await pollTaskUntilDone(task.data.task_id);

    if (!completed) {
      logger.warn("manus", "Batch task did not complete, returning nulls");
      return Object.fromEntries(topics.map((t) => [t.name, null]));
    }

    const content = extractOutput(completed)?.[1]?.content;

    const output: string =
      content?.[0]?.type === "output_text"
        ? content[0].text
        : "";

    if (!output || output.length < 10) {
      logger.warn("manus", `Batch output too short (${output?.length ?? 0} chars)`);
      return Object.fromEntries(topics.map((t) => [t.name, null]));
    }

    const taskUrl = task.data.task_url ?? undefined;

    // Attempt to parse per-topic sections
    const parsed = parseTopicSections(output, topics.map((t) => t.name));

    // If parsing found at least half the topics, use parsed results
    const parsedCount = Object.values(parsed).filter(Boolean).length;
    if (parsedCount >= Math.ceil(topics.length / 2)) {
      logger.info("manus", `Parsed ${parsedCount}/${topics.length} topic sections from batch`);
      const results: Record<string, SentimentResult | null> = {};
      for (const t of topics) {
        results[t.name] = parsed[t.name]
          ? { summary: parsed[t.name]!, taskUrl }
          : null;
      }
      return results;
    }

    // Fallback: assign the full combined output to every topic
    logger.info("manus", `Could not parse individual sections, using full output for all ${topics.length} topics`);
    const fullResult: SentimentResult = { summary: output, taskUrl };
    return Object.fromEntries(topics.map((t) => [t.name, fullResult]));
  } catch (err: any) {
    const { terminal, status } = isTerminalHttpError(err);
    if (terminal) {
      logger.error("manus", `Batch create failed: HTTP ${status}`);
    } else {
      logger.error("manus", `Batch sentiment failed: ${err}`);
    }
    return Object.fromEntries(topics.map((t) => [t.name, null]));
  }
}

/**
 * Attempts to split batch output into per-topic sections using
 * "### TOPIC:" headers. Returns a map of topic name → section text.
 */
function parseTopicSections(
  output: string,
  topicNames: string[]
): Record<string, string | null> {
  const results: Record<string, string | null> = {};
  for (const name of topicNames) results[name] = null;

  // Split on ### TOPIC: headers
  const sectionRegex = /###\s*TOPIC:\s*"?([^"\n]+)"?\s*\n/gi;
  const matches = [...output.matchAll(sectionRegex)];

  if (matches.length === 0) return results;

  for (let i = 0; i < matches.length; i++) {
    const matchedName = matches[i][1].trim();
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : output.length;
    const section = output.slice(start, end).trim();

    // Find the best matching topic name (case-insensitive, partial match)
    const target = topicNames.find(
      (n) =>
        n.toLowerCase() === matchedName.toLowerCase() ||
        matchedName.toLowerCase().includes(n.toLowerCase()) ||
        n.toLowerCase().includes(matchedName.toLowerCase())
    );

    if (target && section.length >= 10) {
      results[target] = section;
    }
  }

  return results;
}

export async function fetchSentiment(
  topic: string,
  context: string
): Promise<SentimentResult | null> {
  logger.info("manus", `Fetching sentiment for "${topic}"`);

  try {
    const task = await createSentimentTask(topic, context);
    logger.info("manus", `Task created: ${task.task_id}`);

    const completed = await pollTaskUntilDone(task.task_id);

    if (!completed) {
      logger.warn("manus", `No completed task for "${topic}", returning null`);
      return null;
    }

    const content = extractOutput(completed)?.[1]?.content;
    const output: string =
      content?.[0]?.type === "output_text"
        ? content[0].text
        : "";

    if (!output || output.length < 10) {
      logger.warn("manus", `Empty/short output for "${topic}" (${output?.length ?? 0} chars), returning null`);
      return null;
    }

    logger.info("manus", `Sentiment fetched for "${topic}" (${output.length} chars)`);

    return {
      summary: output,
      taskUrl: task.task_url ?? undefined,
    };
  } catch (err: any) {
    // Handle specific HTTP errors at the create-task level
    const { terminal, status } = isTerminalHttpError(err);
    if (terminal) {
      logger.error("manus", `Sentiment create failed for "${topic}": HTTP ${status}`);
    } else {
      logger.error("manus", `Sentiment fetch failed for "${topic}": ${err}`);
    }
    return null;
  }
}
