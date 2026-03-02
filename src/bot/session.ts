import { logger } from "../utils/logger.js";

/**
 * Per-chat session state machine with in-memory persistence.
 *
 * States:
 *   idle            — waiting for a command
 *   awaiting_ticker — /equity was sent without a ticker; next text → ticker
 *   awaiting_chat   — /chat was sent without a question; next text → question
 *   busy            — a workflow is running; new commands → cancel/replace
 *
 * In the local Node.js version, session state is held entirely in-memory
 * (a plain Map). There is no Cloudflare KV — sessions are scoped to the
 * lifetime of the process, which is sufficient for local development and
 * single-instance deployments.
 */

export type SessionState = "idle" | "awaiting_ticker" | "awaiting_chat" | "busy";

export interface ChatSession {
  state: SessionState;
  /** The command currently running (for cancel/replace) */
  activeCommand?: string;
  /** AbortController for the running workflow */
  abortController?: AbortController;
  /** Buffer for multi-segment long messages */
  inputBuffer: string[];
  /** Timer for flushing the input buffer */
  bufferTimer?: ReturnType<typeof setTimeout>;
  /** Timestamp of last activity */
  lastActivity: number;
  /** Timestamp of last default guidance reply (anti-spam) */
  lastDefaultReplyAt?: number;
}

const sessions = new Map<number, ChatSession>();

/** Session TTL: 10 minutes of inactivity → auto-cleanup */
const SESSION_TTL_MS = 10 * 60 * 1000;

/** Buffer debounce: wait 500ms for additional message segments */
const BUFFER_DEBOUNCE_MS = 500;

const DEFAULT_REPLY_COOLDOWN_MS = 8_000;

// ─── Session Management ───

/**
 * Get or create a session for a chat (synchronous, in-memory).
 */
export function getSession(chatId: number): ChatSession {
  let session = sessions.get(chatId);
  if (!session) {
    session = {
      state: "idle",
      inputBuffer: [],
      lastActivity: Date.now(),
    };
    sessions.set(chatId, session);
  }
  session.lastActivity = Date.now();
  return session;
}

/**
 * Async alias for getSession — provided for API compatibility with the
 * Cloudflare Workers version, which needed to hydrate from KV on cache miss.
 * In the local version this is a simple in-memory lookup.
 */
export async function getSessionAsync(chatId: number): Promise<ChatSession> {
  return getSession(chatId);
}

export function setSessionState(
  chatId: number,
  state: SessionState,
  command?: string,
): void {
  const session = getSession(chatId);
  session.state = state;
  if (command !== undefined) session.activeCommand = command;
  logger.info("session", `Chat ${chatId}: ${state}${command ? ` (${command})` : ""}`);
}

export function resetSession(chatId: number): void {
  const session = sessions.get(chatId);
  if (session) {
    if (session.bufferTimer) clearTimeout(session.bufferTimer);
    session.state = "idle";
    session.activeCommand = undefined;
    session.inputBuffer = [];
    session.bufferTimer = undefined;
    // abortController is cleared by the workflow itself
  }
}

/**
 * Rate-limit generic default replies so split/gibberish multi-part messages
 * do not trigger repeated guidance spam.
 */
export function shouldSendDefaultReply(chatId: number): boolean {
  const session = getSession(chatId);
  const now = Date.now();
  if (
    typeof session.lastDefaultReplyAt === "number" &&
    now - session.lastDefaultReplyAt < DEFAULT_REPLY_COOLDOWN_MS
  ) {
    return false;
  }
  session.lastDefaultReplyAt = now;
  return true;
}

/**
 * Cancel the currently running workflow for a chat.
 * Returns true if there was something to cancel.
 */
export function cancelActiveWorkflow(chatId: number): boolean {
  const session = sessions.get(chatId);
  if (session?.abortController) {
    session.abortController.abort();
    session.abortController = undefined;
    logger.info(
      "session",
      `Chat ${chatId}: cancelled active workflow (${session.activeCommand})`,
    );
    return true;
  }
  return false;
}

/**
 * Buffer a text segment and return the merged text after debounce.
 * Returns a Promise that resolves with the full merged text once
 * no more segments arrive within BUFFER_DEBOUNCE_MS.
 */
export function bufferInput(chatId: number, text: string): Promise<string> {
  const session = getSession(chatId);
  return new Promise((resolve) => {
    session.inputBuffer.push(text);
    if (session.bufferTimer) clearTimeout(session.bufferTimer);
    session.bufferTimer = setTimeout(() => {
      const merged = session.inputBuffer.join("\n").trim();
      session.inputBuffer = [];
      session.bufferTimer = undefined;
      resolve(merged);
    }, BUFFER_DEBOUNCE_MS);
  });
}

/**
 * Fuzzy-match a partial slash input to the closest command.
 * Returns the matched command or null.
 */
export function fuzzyMatchCommand(input: string): string | null {
  const COMMANDS = [
    "/macro",
    "/geopolitics",
    "/briefing",
    "/equity",
    "/chat",
    "/start",
    "/help",
    "/status",
  ];
  const normalized = input.toLowerCase().trim();

  // Exact match
  const exact = COMMANDS.find((c) => c === normalized);
  if (exact) return exact;

  // Prefix match (e.g. /eq → /equity, /mac → /macro, /geo → /geopolitics)
  const prefixMatches = COMMANDS.filter((c) => c.startsWith(normalized));
  if (prefixMatches.length === 1) return prefixMatches[0];

  return null;
}

/**
 * Periodic cleanup of stale sessions.
 * Called via setInterval in the main entry point.
 */
export function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [chatId, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      if (session.bufferTimer) clearTimeout(session.bufferTimer);
      sessions.delete(chatId);
      logger.info("session", `Chat ${chatId}: evicted (stale)`);
    }
  }
}
