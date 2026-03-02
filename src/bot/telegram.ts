import { Telegraf, type Context } from "telegraf";
import type { Message, Update } from "telegraf/types";
import axios from "axios";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import {
  sanitizeTelegramHtml,
  markdownToTelegramHtml,
  escapeHtml,
  extractDomain,
} from "../utils/format.js";
import {
  getSession,
  getSessionAsync,
  setSessionState,
  resetSession,
  cancelActiveWorkflow,
  bufferInput,
  fuzzyMatchCommand,
  shouldSendDefaultReply,
} from "./session.js";
import { runMacroWorkflow } from "../workflows/macro.js";
import { runGeopoliticsWorkflow } from "../workflows/geopolitics.js";
import { runBriefingWorkflow } from "../workflows/briefing.js";
import { runEquityWorkflow } from "../workflows/equity.js";
import { runChatWorkflow } from "../workflows/chat.js";
import {
  checkQueryQuota,
  decrementQueryCount,
  getRemainingQueries,
  upsertUser,
  DEFAULT_QUERY_LIMIT,
} from "../clients/telegram-users.js";
import type { TelegramUserInfo } from "../clients/telegram-users.js";
import type { SynthesisOutput, WorkflowProgress, FredChartResult } from "../types/index.js";

// ─── Bot Instance ───

export const bot = new Telegraf<Context<Update>>(config.TELEGRAM_BOT_TOKEN, {
  handlerTimeout: 300_000, // 5 min ceiling for long workflows
});

// Global error handler — log and reply gracefully instead of crashing
bot.catch((err, ctx) => {
  const updateId = ctx.update?.update_id ?? "unknown";
  logger.error("telegram", `Unhandled error for update ${updateId}: ${err}`);
  const chatId = ctx.chat?.id;
  if (chatId) resetSession(chatId);
  ctx.reply("Something went wrong. Please try again.").catch(() => {});
});

// ─── Constants ───

const COMMAND_GUIDANCE =
  `/macro — US macro & rates intelligence\n` +
  `/geopolitics — Geopolitical risk analysis\n` +
  `/briefing — Daily multi-domain briefing\n` +
  `/equity <i>TICKER</i> — Single stock deep-dive\n` +
  `/chat — Free-form Q&A\n` +
  `/status — Check remaining queries`;

const BUSY_MESSAGE =
  "⏳ I'm still working on your previous request. " +
  "Send a new <b>command</b> to cancel it and start fresh.";

/** All recognized bot commands (for embedded-command detection) */
const KNOWN_COMMANDS = new Set([
  "/macro", "/geopolitics", "/briefing", "/equity",
  "/chat", "/start", "/help", "/status",
]);

/**
 * Detect recognized /commands embedded in text.
 * Returns the list of found command tokens (e.g. ["/briefing", "/macro"]).
 */
function detectEmbeddedCommands(text: string): string[] {
  const tokens = text.match(/\/[a-zA-Z_]+/g) ?? [];
  return tokens.filter((t) => KNOWN_COMMANDS.has(t.toLowerCase()));
}

// ═══════════════════════════════════════════════════════════════
//  PROGRESS BAR — Single Editable Message
// ═══════════════════════════════════════════════════════════════

function buildProgressMessage(
  workflowName: string,
  step: number,
  totalSteps: number,
  description: string
): string {
  const pct = Math.round((step / totalSteps) * 100);
  const barLen = 20;
  const filled = Math.round((step / totalSteps) * barLen);
  const empty = barLen - filled;
  const bar = "▓".repeat(filled) + "░".repeat(empty);

  return (
    `🔄 ${workflowName} [${step}/${totalSteps}]\n` +
    `${bar} ${pct}%\n` +
    `${description}`
  );
}

function createProgressTracker(
  ctx: Context<Update>,
  workflowName: string,
  totalSteps: number
): { progress: WorkflowProgress; cleanup: () => Promise<void> } {
  const chatId = ctx.chat!.id;
  let messageId: number | null = null;

  const progress: WorkflowProgress = {
    totalSteps,

    async update(step: number, description: string): Promise<void> {
      const text = buildProgressMessage(workflowName, step, totalSteps, description);
      try {
        if (messageId === null) {
          const sent = await ctx.reply(text, { parse_mode: undefined });
          messageId = sent.message_id;
        } else {
          await bot.telegram.editMessageText(chatId, messageId, undefined, text);
        }
      } catch (err) {
        logger.debug("telegram", `Progress update failed: ${err}`);
      }
    },

    async done(): Promise<void> {
      if (messageId === null) return;
      try {
        await bot.telegram.deleteMessage(chatId, messageId);
      } catch {
        // Ignore delete errors
      }
      messageId = null;
    },
  };

  return { progress, cleanup: progress.done };
}

// ═══════════════════════════════════════════════════════════════
//  TABLE-AS-IMAGE — Render tables via QuickChart
// ═══════════════════════════════════════════════════════════════

const QUICKCHART_URL = "https://quickchart.io/chart";

function stripInlineNumericCitations(text: string): string {
  return text.replace(/\[(\d+)\](?!\()/g, "");
}

function parseNumericCell(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.\-]/g, "").trim();
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract table blocks from the body text.
 * Supports TABLE_START/TABLE_END fenced blocks and pipe-delimited tables.
 */
function extractTables(body: string): { tables: string[]; bodyWithoutTables: string } {
  const tables: string[] = [];
  let cleaned = body;

  // 1. Fenced TABLE_START / TABLE_END blocks
  const fencedPattern = /TABLE_START\n?([\s\S]*?)TABLE_END/g;
  let match: RegExpExecArray | null;
  while ((match = fencedPattern.exec(body)) !== null) {
    tables.push(match[1].trim());
  }
  cleaned = cleaned.replace(fencedPattern, "").trim();

  // 2. Pipe-delimited tables (3+ consecutive lines with |)
  const pipePattern = /(?:^|\n)((?:\|.+\|(?:\n|$)){3,})/g;
  while ((match = pipePattern.exec(cleaned)) !== null) {
    tables.push(match[1].trim());
  }
  cleaned = cleaned.replace(pipePattern, "\n").trim();

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return { tables, bodyWithoutTables: cleaned };
}

function parseTable(tableText: string): { headers: string[]; rows: string[][] } | null {
  const lines = tableText.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const parseLine = (line: string): string[] =>
    line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter((c) => c.length > 0);

  const headers = parseLine(lines[0]);
  if (headers.length === 0) return null;

  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^[\s|:-]+$/.test(lines[i])) continue;
    const cells = parseLine(lines[i]);
    if (cells.length > 0) rows.push(cells);
  }

  return rows.length > 0 ? { headers, rows } : null;
}

const TABLE_CHART_COLORS = [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2",
];

/**
 * Detect whether numeric columns need separate Y-axes (>5x scale difference).
 */
function detectColumnScales(
  headers: string[],
  rows: string[][]
): { needsMultiAxis: boolean; axisAssignments: number[] } {
  const numericHeaders = headers.slice(1);
  if (numericHeaders.length < 2) return { needsMultiAxis: false, axisAssignments: [0] };

  const medians: number[] = numericHeaders.map((_, colIdx) => {
    const values = rows
      .map((r) => {
        const raw = r[colIdx + 1] ?? "";
        const cleaned = raw.replace(/[^0-9.\-]/g, "");
        return cleaned ? Math.abs(parseFloat(cleaned)) : NaN;
      })
      .filter((v) => !isNaN(v) && v > 0)
      .sort((a, b) => a - b);
    if (values.length === 0) return 0;
    return values[Math.floor(values.length / 2)];
  });

  const assignments = new Array<number>(numericHeaders.length).fill(0);
  let nextAxis = 0;
  const assigned = new Set<number>();

  for (let i = 0; i < medians.length; i++) {
    if (assigned.has(i)) continue;
    assignments[i] = nextAxis;
    assigned.add(i);
    for (let j = i + 1; j < medians.length; j++) {
      if (assigned.has(j)) continue;
      const ratio =
        medians[i] > 0 && medians[j] > 0
          ? Math.max(medians[i] / medians[j], medians[j] / medians[i])
          : Infinity;
      if (ratio <= 5) {
        assignments[j] = nextAxis;
        assigned.add(j);
      }
    }
    nextAxis++;
  }

  const uniqueAxes = new Set(assignments).size;
  return { needsMultiAxis: uniqueAxes > 1, axisAssignments: assignments };
}

/**
 * Render a table as a PNG chart image via QuickChart.
 * Falls back to text table image, then plain text.
 */
async function renderTableImage(tableText: string): Promise<Buffer | null> {
  const parsed = parseTable(tableText);
  if (!parsed) return null;

  const { headers, rows } = parsed;

  const hasNumericData = rows.some((r) =>
    r.slice(1).some((cell) => /\d/.test(cell))
  );

  if (!hasNumericData) {
    return renderTextTableImage(headers, rows);
  }

  const numericColumns = headers.slice(1).map((header, idx) => ({
    originalIdx: idx,
    header,
    values: rows.map((r) => {
      const raw = r[idx + 1] ?? "";
      return parseNumericCell(raw);
    }),
  }));

  const { needsMultiAxis, axisAssignments } = detectColumnScales(headers, rows);

  if (needsMultiAxis) {
    logger.info("telegram", `Multi-axis table chart: ${headers.slice(1).join(", ")}`);
  }

  const datasets = numericColumns
    .filter((col) => col.values.some((v) => typeof v === "number" && !isNaN(v)))
    .map((col, idx) => {
    const color = TABLE_CHART_COLORS[idx % TABLE_CHART_COLORS.length];
    const axisId = needsMultiAxis
      ? axisAssignments[col.originalIdx] === 0 ? "y" : `y${axisAssignments[col.originalIdx]}`
      : "y";
    return {
      label: col.header,
      data: col.values,
      backgroundColor: color + "CC",
      borderColor: color,
      borderWidth: 1,
      yAxisID: axisId,
    };
  });

  if (datasets.length === 0) {
    logger.info("telegram", "Skipping table chart; no numeric values detected");
    return null;
  }

  const scales: Record<string, any> = { x: { ticks: { maxRotation: 0 } } };

  if (needsMultiAxis) {
    const axisGroups = new Map<number, { headers: string[]; colorIdx: number }>();
    for (let i = 0; i < axisAssignments.length; i++) {
      const axis = axisAssignments[i];
      if (!axisGroups.has(axis)) axisGroups.set(axis, { headers: [], colorIdx: i });
      axisGroups.get(axis)!.headers.push(numericColumns[i].header);
    }
    for (const [axisIdx, group] of axisGroups) {
      const axisId = axisIdx === 0 ? "y" : `y${axisIdx}`;
      const position = axisIdx === 0 ? "left" : "right";
      const color = TABLE_CHART_COLORS[group.colorIdx % TABLE_CHART_COLORS.length];
      scales[axisId] = {
        type: "linear",
        position,
        display: true,
        title: { display: true, text: group.headers.join(", "), color, font: { weight: "bold", size: 11 } },
        ticks: { color },
        grid: { drawOnChartArea: axisIdx === 0 },
      };
    }
  } else {
    scales["y"] = { beginAtZero: false };
  }

  const chartConfig = {
    type: "bar" as const,
    data: { labels: rows.map((r) => r[0] ?? ""), datasets },
    options: {
      responsive: false,
      plugins: {
        title: { display: false },
        legend: { display: headers.length > 2, position: "bottom" as const },
      },
      indexAxis: "y" as const,
      scales,
    },
  };

  try {
    const response = await axios.post(
      QUICKCHART_URL,
      {
        chart: chartConfig,
        width: 700,
        height: Math.max(300, rows.length * 50 + 120),
        format: "png",
        backgroundColor: "#ffffff",
        version: "4",  // Chart.js v4 for multi-axis support (scales.y, scales.y2)
      },
      { responseType: "arraybuffer", timeout: 10_000 }
    );
    return Buffer.from(response.data);
  } catch (err) {
    logger.warn("telegram", `Table chart render failed: ${err}, falling back to text image`);
    // ── Fallback: text table image ──
    return renderTextTableImage(headers, rows);
  }
}

async function renderTextTableImage(
  headers: string[],
  rows: string[][]
): Promise<Buffer | null> {
  const colWidths = headers.map((h, i) => {
    const maxCell = Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length));
    return maxCell;
  });

  const pad = (s: string, w: number) => s.padEnd(w);
  const headerLine = headers.map((h, i) => pad(h, colWidths[i])).join("  │  ");
  const separator = colWidths.map((w) => "─".repeat(w)).join("──┼──");
  const dataLines = rows.map((r) =>
    r.map((c, i) => pad(c, colWidths[i])).join("  │  ")
  );

  const tableStr = [headerLine, separator, ...dataLines].join("\n");

  const chartConfig = {
    type: "bar",
    data: { labels: [""], datasets: [{ data: [0] }] },
    options: {
      responsive: false,
      scales: { x: { display: false }, y: { display: false } },
      plugins: {
        legend: { display: false },
        title: { display: false },
        annotation: {
          annotations: {
            label1: {
              type: "label",
              xValue: 0,
              yValue: 0,
              content: tableStr.split("\n"),
              font: { family: "monospace", size: 13 },
              color: "#1a1a1a",
            },
          },
        },
      },
    },
  };

  try {
    const lineCount = tableStr.split("\n").length;
    const response = await axios.post(
      QUICKCHART_URL,
      {
        chart: chartConfig,
        width: Math.max(500, Math.max(...tableStr.split("\n").map((l) => l.length)) * 9 + 40),
        height: Math.max(200, lineCount * 22 + 60),
        format: "png",
        backgroundColor: "#ffffff",
        version: "4",
      },
      { responseType: "arraybuffer", timeout: 10_000 }
    );
    return Buffer.from(response.data);
  } catch (err) {
    logger.warn("telegram", `Text table image render failed: ${err}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  PHOTO UPLOAD — Direct Telegram Bot API via fetch()
// ═══════════════════════════════════════════════════════════════
//
//  Telegraf's ctx.replyWithPhoto({ source: Buffer }) relies on
//  Node.js streams internally, which do not work in Cloudflare
//  Workers. Instead, we call the Telegram Bot API directly using
//  Web-standard fetch() + FormData + Blob, which CF Workers
//  supports natively.
// ═══════════════════════════════════════════════════════════════

async function sendPhotoViaApi(
  chatId: number,
  photoBuffer: Buffer | Uint8Array,
  caption?: string,
): Promise<boolean> {
  try {
    const formData = new FormData();
    formData.append("chat_id", chatId.toString());
    formData.append(
      "photo",
      new Blob([new Uint8Array(photoBuffer)], { type: "image/png" }),
      "chart.png",
    );
    if (caption) {
      formData.append("caption", caption);
    }

    const response = await fetch(
      `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendPhoto`,
      { method: "POST", body: formData },
    );

    // IMPORTANT: Always consume the response body to prevent CF Workers
    // "stalled HTTP response" deadlock when many fetch() calls are in flight.
    const responseBody = await response.text();

    if (!response.ok) {
      logger.warn("telegram", `sendPhoto API error (${response.status}): ${responseBody}`);
      return false;
    }

    return true;
  } catch (err) {
    logger.warn("telegram", `sendPhoto fetch failed: ${err}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  OUTPUT — Buffered, HTML-formatted, tables as images
// ═══════════════════════════════════════════════════════════════

function stripUnavailableSections(body: string): string {
  return body
    .replace(
      /^[^\n]*<b>[^<]*<\/b>[^\n]*\n(?:[^\n]*(?:unavailable|no data|N\/A|not available|no significant|could not)[^\n]*\n?)+/gim,
      ""
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendOutput(
  ctx: Context<Update>,
  output: SynthesisOutput | string
): Promise<void> {
  if (typeof output === "string") {
    await sendLongMessage(ctx, output, "HTML");
    return;
  }

  // ── Send charts first ──
  // Uses direct Telegram Bot API via fetch() instead of Telegraf's
  // replyWithPhoto, which breaks in Cloudflare Workers due to
  // Node.js stream incompatibilities.
  if (output.charts?.length) {
    const chatId = ctx.chat!.id;
    for (const chart of output.charts) {
      const ok = await sendPhotoViaApi(chatId, chart.buffer, chart.title);
      if (!ok) {
        logger.warn("telegram", `Chart send failed for: ${chart.title}`);
      }
    }
  }

  // ── Process body ──
  let body = output.body;
  body = stripInlineNumericCitations(body);
  body = stripUnavailableSections(body);

  // Extract tables before HTML conversion
  const { tables, bodyWithoutTables } = extractTables(body);
  body = markdownToTelegramHtml(bodyWithoutTables);

  // Render tables as images
  for (const tableText of tables) {
    const imgBuf = await renderTableImage(tableText);
    if (imgBuf) {
      const chatId = ctx.chat!.id;
      const ok = await sendPhotoViaApi(chatId, imgBuf);
      if (!ok) {
        // Final fallback: send as preformatted text
        logger.warn("telegram", `Table image send failed, falling back to text`);
        const plainTable = `<pre>${escapeHtml(tableText)}</pre>`;
        await ctx.reply(plainTable, { parse_mode: "HTML" }).catch(() => {});
      }
    }
  }

  // Citation footer (skip for equity — no sources)
  const bodyHasSources =
    body.includes('<a href="') ||
    body.toLowerCase().includes("sources") ||
    body.includes("📎");

  if (!bodyHasSources && output.citations?.length) {
    const links = output.citations
      .slice(0, 5)
      .map((url) => {
        const label = extractDomain(url);
        return `• <a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
      })
      .join("\n");
    body += `\n\n📎 <b>Sources</b>\n${links}`;
  }

  // Sanitize final HTML
  body = sanitizeTelegramHtml(body.trim());

  if (!body.trim()) {
    await ctx.reply("Analysis complete but no substantive content was generated. Try again.");
    return;
  }

  await sendLongMessage(ctx, body, "HTML");
}

/**
 * Send a long message, splitting at Telegram's 4096-char limit.
 * Each chunk is individually sanitized to ensure tag balance.
 */
async function sendLongMessage(
  ctx: Context<Update>,
  text: string,
  parseMode?: "HTML"
): Promise<void> {
  const MAX_LEN = 4000;

  if (text.length <= MAX_LEN) {
    const finalText = parseMode === "HTML" ? sanitizeTelegramHtml(text) : text;
    try {
      await ctx.reply(finalText, {
        parse_mode: parseMode,
        link_preview_options: { is_disabled: true },
      } as any);
    } catch (err) {
      logger.warn("telegram", `HTML send failed, retrying as plain text: ${err}`);
      await ctx.reply(text.replace(/<[^>]+>/g, ""));
    }
    return;
  }

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (line.length > MAX_LEN) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }

      for (let i = 0; i < line.length; i += MAX_LEN) {
        const segment = line.slice(i, i + MAX_LEN).trim();
        if (segment) chunks.push(segment);
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_LEN && current.length > 0) {
      chunks.push(current.trim());
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  for (const chunk of chunks) {
    const finalChunk = parseMode === "HTML" ? sanitizeTelegramHtml(chunk) : chunk;
    try {
      await ctx.reply(finalChunk, {
        parse_mode: parseMode,
        link_preview_options: { is_disabled: true },
      } as any);
    } catch (err) {
      logger.warn("telegram", `Chunk send failed, retrying as plain text: ${err}`);
      await ctx.reply(chunk.replace(/<[^>]+>/g, ""));
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  WORKFLOW RUNNER — Cancel/Replace + Session Management
// ═══════════════════════════════════════════════════════════════

async function handleWorkflow(
  ctx: Context<Update>,
  commandName: string,
  runner: (progress: WorkflowProgress) => Promise<SynthesisOutput | string>
): Promise<void> {
  const chatId = ctx.chat!.id;
  // Hydrate session from KV if not in this isolate's memory
  const session = await getSessionAsync(chatId);

  // ── Query quota check ──
  const userInfo = extractUserInfo(ctx);
  try {
    const { allowed, remaining } = await checkQueryQuota(userInfo);
    if (!allowed) {
      await ctx.reply(
        `🚫 <b>Query limit reached</b>\n\n` +
          `You've used all <b>${DEFAULT_QUERY_LIMIT}</b> queries available in MVP mode.\n\n` +
          `Contact <b>thesensbot@gmail.com</b> for further updates or if you have any questions.`,
        { parse_mode: "HTML" }
      );
      return;
    }
  } catch (err) {
    logger.error("telegram", `Query quota check failed for ${userInfo.telegramId}: ${err}`);
    // On quota check failure, allow the query to proceed rather than blocking
  }

  // Cancel/replace policy: if busy, cancel the old workflow and start new one
  if (session.state === "busy" && session.abortController) {
    cancelActiveWorkflow(chatId);
    await new Promise((r) => setTimeout(r, 200));
  }

  // Set up new workflow
  const abortController = new AbortController();
  session.abortController = abortController;
  setSessionState(chatId, "busy", commandName);

  const stepMap: Record<string, number> = {
    macro: 4,
    geopolitics: 4,
    briefing: 2,
    equity: 4,
    chat: 2,
  };
  const totalSteps = stepMap[commandName] ?? 3;
  const workflowLabel = commandName.charAt(0).toUpperCase() + commandName.slice(1);
  const { progress, cleanup } = createProgressTracker(ctx, workflowLabel, totalSteps);

  // Hard workflow timeout — ensures the user always gets feedback even if
  // an upstream API (OpenRouter, Manus, FRED) hangs. Set to 280s to leave
  // margin before Workers Unbound's 15-min ceiling and to cap user wait time.
  const WORKFLOW_TIMEOUT_MS = 280_000;

  try {
    if (abortController.signal.aborted) return;

    const result = await Promise.race([
      runner(progress),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("WORKFLOW_TIMEOUT")),
          WORKFLOW_TIMEOUT_MS
        );
      }),
    ]);

    if (abortController.signal.aborted) {
      await cleanup();
      return;
    }

    // ── Decrement query count after successful processing ──
    try {
      await decrementQueryCount(userInfo.telegramId);
    } catch (err) {
      logger.error("telegram", `Failed to decrement query count for ${userInfo.telegramId}: ${err}`);
    }

    await cleanup();
    await sendOutput(ctx, result);
  } catch (err: any) {
    await cleanup();
    if (abortController.signal.aborted) return;

    if (err?.message === "WORKFLOW_TIMEOUT") {
      logger.error("telegram", `/${commandName} timed out after ${WORKFLOW_TIMEOUT_MS}ms`);
      await ctx.reply(
        "\u23F1 This analysis is taking longer than expected. " +
        "Please try again \u2014 results are often faster on retry due to caching."
      ).catch(() => {});
    } else {
      logger.error("telegram", `/${commandName} workflow error: ${err}`);
      await ctx.reply("Something went wrong. Please try again.").catch(() => {});
    }
  } finally {
    if (session.abortController === abortController) {
      session.abortController = undefined;
    }
    resetSession(chatId);
  }
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS — Telegram User Info
// ═══════════════════════════════════════════════════════════════

function extractUserInfo(ctx: Context<Update>): TelegramUserInfo {
  return {
    telegramId: ctx.from!.id,
    username: ctx.from?.username,
    firstName: ctx.from?.first_name,
    lastName: ctx.from?.last_name,
  };
}

// ═══════════════════════════════════════════════════════════════
//  COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════

bot.command("start", async (ctx) => {
  resetSession(ctx.chat.id);

  // Upsert user on /start so they exist in the DB, then fetch actual remaining credits
  const userInfo = extractUserInfo(ctx);
  let remaining = DEFAULT_QUERY_LIMIT;
  try {
    await upsertUser(userInfo);
    remaining = await getRemainingQueries(userInfo.telegramId);
  } catch {
    // Non-blocking: don't prevent /start from working; fall back to default
  }

  await ctx.reply(
    `<b>SENS</b>\n\n` +
      `${COMMAND_GUIDANCE}\n\n` +
      `⚠️ <b>MVP Mode</b> — You have <b>${remaining} / ${DEFAULT_QUERY_LIMIT} queries</b> remaining. ` +
      `Use /status to check your balance.`,
    { parse_mode: "HTML" }
  );
});

bot.command("help", async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply(
    `<b>Available Commands</b>\n\n${COMMAND_GUIDANCE}`,
    { parse_mode: "HTML" }
  );
});

bot.command("status", async (ctx) => {
  const userInfo = extractUserInfo(ctx);
  let remaining = 0;
  try {
    await upsertUser(userInfo);
    remaining = await getRemainingQueries(userInfo.telegramId);
  } catch (err) {
    logger.error("telegram", `Failed to fetch status for ${userInfo.telegramId}: ${err}`);
    await ctx.reply("Could not retrieve your status. Please try again.");
    return;
  }

  await ctx.reply(
    `📊 <b>Status</b>\n\n` +
      `🔹 <b>Mode:</b> MVP (public preview)\n` +
      `🔹 <b>Remaining queries:</b> ${remaining} / ${DEFAULT_QUERY_LIMIT}\n\n` +
      `Contact <b>thesensbot@gmail.com</b> for further updates or if you have any questions.`,
    { parse_mode: "HTML" }
  );
});

bot.command("macro", async (ctx) => {
  const extraText = (ctx.message as Message.TextMessage).text.replace(/^\/macro\s*/i, "").trim();
  if (extraText) {
    const embedded = detectEmbeddedCommands(extraText);
    if (embedded.length > 0) {
      await ctx.reply(
        `<b>/macro</b> does not accept arguments.\n\n` +
          `It looks like you also included: <b>${escapeHtml(embedded.join(", "))}</b>\n` +
          `Please send each command as a separate message.`,
        { parse_mode: "HTML" }
      );
      return;
    }
  }
  await handleWorkflow(ctx, "macro", (progress) => runMacroWorkflow(progress));
});

bot.command("geopolitics", async (ctx) => {
  const extraText = (ctx.message as Message.TextMessage).text.replace(/^\/geopolitics\s*/i, "").trim();
  if (extraText) {
    const embedded = detectEmbeddedCommands(extraText);
    if (embedded.length > 0) {
      await ctx.reply(
        `<b>/geopolitics</b> does not accept arguments.\n\n` +
          `It looks like you also included: <b>${escapeHtml(embedded.join(", "))}</b>\n` +
          `Please send each command as a separate message.`,
        { parse_mode: "HTML" }
      );
      return;
    }
  }
  await handleWorkflow(ctx, "geopolitics", (progress) =>
    runGeopoliticsWorkflow(progress)
  );
});

bot.command("briefing", async (ctx) => {
  const extraText = (ctx.message as Message.TextMessage).text.replace(/^\/briefing\s*/i, "").trim();
  if (extraText) {
    const embedded = detectEmbeddedCommands(extraText);
    if (embedded.length > 0) {
      await ctx.reply(
        `<b>/briefing</b> does not accept arguments.\n\n` +
          `It looks like you also included: <b>${escapeHtml(embedded.join(", "))}</b>\n` +
          `Please send each command as a separate message.`,
        { parse_mode: "HTML" }
      );
      return;
    }
  }
  await handleWorkflow(ctx, "briefing", (progress) =>
    runBriefingWorkflow(progress)
  );
});

bot.command("equity", async (ctx) => {
  const chatId = ctx.chat.id;
  const rawArgs = (ctx.message as Message.TextMessage).text
    .replace(/^\/equity\s*/i, "")
    .trim();

  if (rawArgs) {
    // Detect embedded commands: /equity NVDA /macro
    const embedded = detectEmbeddedCommands(rawArgs);
    if (embedded.length > 0) {
      await ctx.reply(
        `It looks like your message contains command(s): <b>${escapeHtml(embedded.join(", "))}</b>\n\n` +
          `Commands cannot be combined in a single message. ` +
          `Please send each command separately.\n\n` +
          `<i>Usage: /equity TICKER</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Ticker provided inline: /equity NVDA, /equity $NVDA, /equity nvidia
    const ticker = rawArgs.replace(/^\$/, "").trim();
    await handleWorkflow(ctx, "equity", (progress) =>
      runEquityWorkflow(ticker, progress)
    );
  } else {
    // No ticker — enter awaiting_ticker state
    setSessionState(chatId, "awaiting_ticker", "equity");
    await ctx.reply(
      "Which ticker would you like to analyze?\n\n" +
        "<i>Send a ticker symbol (e.g. <code>NVDA</code>), " +
        "<code>$TSLA</code>, or a company name.</i>",
      { parse_mode: "HTML" }
    );
  }
});

bot.command("chat", async (ctx) => {
  const chatId = ctx.chat.id;
  const rawArgs = (ctx.message as Message.TextMessage).text
    .replace(/^\/chat\s*/i, "")
    .trim();

  if (rawArgs) {
    // Detect embedded commands: /chat /briefing, /chat /equity NVDA /macro
    const embedded = detectEmbeddedCommands(rawArgs);
    if (embedded.length > 0) {
      await ctx.reply(
        `It looks like your message contains command(s): <b>${escapeHtml(embedded.join(", "))}</b>\n\n` +
          `Commands cannot be combined in a single message. ` +
          `Please send each command separately.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Question provided inline: /chat What is the fed funds rate?
    await handleWorkflow(ctx, "chat", (progress) =>
      runChatWorkflow(rawArgs, progress)
    );
  } else {
    // No question — enter awaiting_chat state
    setSessionState(chatId, "awaiting_chat", "chat");
    await ctx.reply(
      "Ask any question.\n\n" +
        "<i>Usage: /chat Ask any question</i>",
      { parse_mode: "HTML" }
    );
  }
});

// ═══════════════════════════════════════════════════════════════
//  TEXT INPUT HANDLER — State Machine Router
// ═══════════════════════════════════════════════════════════════

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  // Hydrate session from KV if not in this isolate's memory
  const session = await getSessionAsync(chatId);
  const rawText = ctx.message.text.trim();

  // ── Busy guard: prevent out-of-order responses ──
  // When a workflow is running, non-command text would get an immediate reply
  // that appears BEFORE the workflow result, creating confusing ordering.
  // Silently drop non-command text while busy (the progress bar already
  // indicates the bot is working). Slash commands still pass through for
  // fuzzy matching → cancel/replace.
  if (session.state === "busy" && !rawText.startsWith("/")) {
    logger.debug("telegram", `Chat ${chatId}: dropped non-command text while busy (${session.activeCommand})`);
    return;
  }

  // ── Handle partial/typo slash commands ──
  if (rawText.startsWith("/")) {
    const firstWord = rawText.split(/\s/)[0];
    const rest = rawText.slice(firstWord.length).trim();
    const matched = fuzzyMatchCommand(firstWord);

    if (matched) {
      // If the matched command takes inline args, route directly
      if (matched === "/equity" && rest) {
        // Check for embedded commands: /eq NVDA /macro
        const embedded = detectEmbeddedCommands(rest);
        if (embedded.length > 0) {
          await ctx.reply(
            `Commands cannot be combined in a single message. ` +
              `Please send each command separately.`,
            { parse_mode: "HTML" }
          );
          return;
        }
        const ticker = rest.replace(/^\$/, "").trim();
        await handleWorkflow(ctx, "equity", (progress) =>
          runEquityWorkflow(ticker, progress)
        );
        return;
      }
      if (matched === "/chat" && rest) {
        // Check for embedded commands: /chat /briefing
        const embedded = detectEmbeddedCommands(rest);
        if (embedded.length > 0) {
          await ctx.reply(
            `It looks like your message contains command(s): <b>${escapeHtml(embedded.join(", "))}</b>\n\n` +
              `Commands cannot be combined in a single message. ` +
              `Please send each command separately.`,
            { parse_mode: "HTML" }
          );
          return;
        }
        await handleWorkflow(ctx, "chat", (progress) =>
          runChatWorkflow(rest, progress)
        );
        return;
      }

      // For exact matches without args, the command handler above already
      // handles it. For fuzzy matches, give a hint.
      if (firstWord !== matched) {
        // Don't send "did you mean" while busy — it causes ordering issues
        if (session.state === "busy") {
          logger.debug("telegram", `Chat ${chatId}: dropped fuzzy-match hint while busy`);
          return;
        }
        await ctx.reply(
          `Did you mean <b>${matched}</b>?\n\nTap the command to use it.`,
          { parse_mode: "HTML" }
        );
        return;
      }
    }

    // Unrecognized slash command — suppress response while busy
    if (session.state === "busy") {
      logger.debug("telegram", `Chat ${chatId}: dropped unrecognized command while busy`);
      return;
    }
    if (shouldSendDefaultReply(chatId)) {
      await ctx.reply(COMMAND_GUIDANCE, { parse_mode: "HTML" });
    }
    return;
  }

  // ── State: awaiting_ticker → route to equity ──
  if (session.state === "awaiting_ticker") {
    const merged = await bufferInput(chatId, rawText);
    // Accept: NVDA, $NVDA, nvidia, Bloom Energy, etc.
    const ticker = merged.replace(/^\$/, "").split(/\s{2,}/)[0].trim();

    if (!ticker) {
      await ctx.reply("Please send a valid ticker symbol.");
      return;
    }

    await handleWorkflow(ctx, "equity", (progress) =>
      runEquityWorkflow(ticker, progress)
    );
    return;
  }

  // ── State: awaiting_chat → route to chat ──
  if (session.state === "awaiting_chat") {
    const merged = await bufferInput(chatId, rawText);

    if (!merged) {
      await ctx.reply("Please type your question.");
      return;
    }

    await handleWorkflow(ctx, "chat", (progress) =>
      runChatWorkflow(merged, progress)
    );
    return;
  }

  // ── State: idle → no command, guide the user ──
  if (shouldSendDefaultReply(chatId)) {
    await ctx.reply(
      "Select a command to activate the bot.\n\n" + COMMAND_GUIDANCE,
      { parse_mode: "HTML" }
    );
  }
});

// ═══════════════════════════════════════════════════════════════
//  NON-TEXT INPUT HANDLERS
// ═══════════════════════════════════════════════════════════════

const NON_TEXT_REPLY =
  "Select a command to activate the bot.\n\n" + COMMAND_GUIDANCE;

for (const event of [
  "photo", "sticker", "voice", "video", "document",
  "location", "contact", "animation", "audio", "video_note",
] as const) {
  bot.on(event, async (ctx) => {
    if (shouldSendDefaultReply(ctx.chat.id)) {
      await ctx.reply(NON_TEXT_REPLY, { parse_mode: "HTML" });
    }
  });
}
