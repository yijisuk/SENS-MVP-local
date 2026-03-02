/**
 * Telegram HTML formatting utilities.
 *
 * Telegram Bot API supports a limited subset of HTML:
 *   <b>, <strong>, <i>, <em>, <u>, <s>, <strike>, <del>,
 *   <code>, <pre>, <a href="...">, <pre language="...">
 *
 * All other HTML tags or Markdown syntax will cause parse errors.
 */

// Tags that Telegram's HTML parser accepts
const ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "s", "strike", "del",
  "code", "pre", "a",
]);

// Self-closing tags that don't need a closing counterpart
const VOID_TAGS = new Set(["br", "hr", "img"]);

/** Escape HTML special characters to prevent Telegram parse errors */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Sanitize HTML for Telegram's strict parser.
 *
 * 1. Strips tags not in Telegram's allowed set
 * 2. Escapes bare < and > that aren't valid Telegram HTML tags
 * 3. Closes any unclosed tags (the root cause of the 400 parse error)
 * 4. Removes orphan closing tags that have no opener
 * 5. Ensures <a> tags have valid href attributes
 *
 * This is the LAST step before sending — applied after markdownToTelegramHtml.
 */
export function sanitizeTelegramHtml(html: string): string {
  let result = html;

  // Step 1: Remove HTML comments
  result = result.replace(/<!--[\s\S]*?-->/g, "");

  // Step 2: Strip unsupported tags (keep their content)
  //         Match opening tags like <div>, <span class="...">, <p>, etc.
  result = result.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g, (match, tagName) => {
    const tag = tagName.toLowerCase();
    if (ALLOWED_TAGS.has(tag) || VOID_TAGS.has(tag)) return match;
    return ""; // strip unsupported tag, keep surrounding text
  });

  // Step 3: Remove void tags (Telegram doesn't support <br>, <hr>, <img>)
  result = result.replace(/<\/?(?:br|hr|img)\b[^>]*\/?>/gi, "");

  // Step 4: Fix malformed <a> tags — ensure href is present and properly quoted
  result = result.replace(/<a\b([^>]*)>/gi, (match, attrs: string) => {
    // Check if href exists
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) {
      // No valid href — strip the tag
      return "";
    }
    // Rebuild with clean href only
    return `<a href="${hrefMatch[1]}">`;
  });

  // Step 5: Escape bare < and > that aren't part of valid Telegram HTML tags.
  //         LLM-generated content often contains raw angle brackets (e.g.
  //         "inflation < 2%", "<TICKER>") which Telegram parses as broken tags,
  //         causing "Unclosed start tag" 400 errors.
  result = escapeBareAngleBrackets(result);

  // Step 6: Close unclosed tags / remove orphan closing tags
  result = balanceTags(result);

  // Step 7: Clean up excessive whitespace
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Balance HTML tags — close any unclosed opening tags and remove
 * orphan closing tags. Processes left-to-right using a stack.
 */
function balanceTags(html: string): string {
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const openStack: { tag: string; pos: number }[] = [];
  const toRemove: { start: number; end: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const fullMatch = match[0];
    const tagName = match[1].toLowerCase();

    if (!ALLOWED_TAGS.has(tagName)) continue;

    const isClosing = fullMatch.startsWith("</");

    if (isClosing) {
      // Find matching opener on the stack
      let found = false;
      for (let i = openStack.length - 1; i >= 0; i--) {
        if (openStack[i].tag === tagName) {
          openStack.splice(i, 1);
          found = true;
          break;
        }
      }
      if (!found) {
        // Orphan closing tag — mark for removal
        toRemove.push({ start: match.index, end: match.index + fullMatch.length });
      }
    } else {
      openStack.push({ tag: tagName, pos: match.index });
    }
  }

  // Remove orphan closing tags (process in reverse to preserve indices)
  let cleaned = html;
  for (let i = toRemove.length - 1; i >= 0; i--) {
    const { start, end } = toRemove[i];
    cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  }

  // Append closing tags for any remaining unclosed openers (in reverse order)
  if (openStack.length > 0) {
    const closers = openStack
      .reverse()
      .map((o) => `</${o.tag}>`)
      .join("");
    cleaned += closers;
  }

  return cleaned;
}

/**
 * Escape bare < and > that aren't part of valid Telegram HTML tags.
 * Protects recognized tags via placeholders, escapes everything else,
 * then restores. Also escapes bare & not part of HTML entities.
 */
function escapeBareAngleBrackets(html: string): string {
  const placeholders: string[] = [];

  // Protect valid Telegram HTML tags (opening and closing)
  const validTagPattern = /<(\/?(b|strong|i|em|u|s|strike|del|code|pre|a)\b[^>]*)>/gi;
  let safe = html.replace(validTagPattern, (match) => {
    placeholders.push(match);
    return `\x00TAG${placeholders.length - 1}\x00`;
  });

  // Escape bare & that aren't already HTML entities
  safe = safe.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[a-fA-F0-9]+);)/g, "&amp;");

  // Escape remaining bare < and >
  safe = safe.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Restore protected tags
  safe = safe.replace(/\x00TAG(\d+)\x00/g, (_, idx) => placeholders[parseInt(idx)]);

  return safe;
}

/**
 * Strip Markdown formatting and convert to Telegram-safe HTML.
 * Handles: **bold**, *italic*, [links](url), # headings, `code`,
 * ```code blocks```, ~~strikethrough~~, markdown tables.
 *
 * NOTE: Always call sanitizeTelegramHtml() on the final output
 * before sending to Telegram.
 */
export function markdownToTelegramHtml(text: string): string {
  let result = text;

  // Code blocks: ```lang\n...\n``` → <pre>...</pre>
  result = result.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, lang, code) => {
    const langAttr = lang ? ` language="${lang}"` : "";
    return `<pre${langAttr}>${escapeHtml(code.trim())}</pre>`;
  });

  // Inline code: `...` → <code>...</code>
  result = result.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);

  // Bold: **text** → <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* → <i>text</i> (but not inside HTML tags)
  result = result.replace(/(?<![<\w])(\*)(?!\s)(.+?)(?<!\s)\1(?![>\w])/g, "<i>$2</i>");

  // Strikethrough: ~~text~~ → <s>text</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url) → <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headings: # text → <b>text</b> (with newline)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bullet points: convert "- item" and "* item" at line start to "• item"
  result = result.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  // Remove markdown table separator rows (---|---|---)
  result = result.replace(/^\|?[\s-:|]+\|[\s-:|]*$/gm, "");

  // Convert markdown table rows to plain text
  result = result.replace(/^\|(.+)\|$/gm, (_m, row) => {
    return row
      .split("|")
      .map((c: string) => c.trim())
      .filter(Boolean)
      .join("  ·  ");
  });

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/** Extract a short domain label from a URL for concise citation display */
export function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const parts = hostname.split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
  } catch {
    return url.slice(0, 30);
  }
}
