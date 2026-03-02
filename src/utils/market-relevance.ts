/**
 * Hard-coded relevance scoring for market title vs. ticker/company name.
 *
 * Used by the /equity workflow to filter Supabase-discovered markets
 * before triggering the scraper on matching URLs.
 */

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compute how relevant a prediction market title is to a given ticker/company.
 *
 * Returns a score between 0 and 1:
 *   1.0  — exact ticker mention as whole word (e.g. "NVDA" in title)
 *   0.95 — full company name found as substring
 *   ≤0.9 — token overlap similarity (Jaccard-style)
 *
 * Recommended threshold: 0.75
 */
export function computeTitleRelevance(
  title: string,
  ticker: string,
  companyName: string,
): number {
  const t = title.toLowerCase();
  const cn = companyName.toLowerCase();

  // 1. Exact ticker as whole word → perfect match
  const tickerRegex = new RegExp(`\\b${escapeRegex(ticker)}\\b`, "i");
  if (tickerRegex.test(title)) return 1.0;

  // 2. Full company name substring → very high
  if (cn.length > 2 && t.includes(cn)) return 0.95;

  // 3. Token overlap similarity
  const titleTokens = new Set(
    t
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
  const companyTokens = cn
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (companyTokens.length === 0) return 0;

  let matches = 0;
  for (const ct of companyTokens) {
    for (const tt of titleTokens) {
      if (
        tt === ct ||
        (ct.length >= 4 && tt.startsWith(ct)) ||
        (tt.length >= 4 && ct.startsWith(tt))
      ) {
        matches++;
        break;
      }
    }
  }

  return (matches / companyTokens.length) * 0.9;
}
