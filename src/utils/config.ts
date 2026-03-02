import { z } from "zod";

// ─── Environment variable schema ───
const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  PERPLEXITY_API_KEY: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  MANUS_API_KEY: z.string().min(1),
  FRED_API_KEY: z.string().min(1),
  // ─── Financial Data ───
  FMP_API_KEY: z.string().min(1),
  // ─── Scraper ───
  SCRAPEGRAPH_API_KEY: z.string().optional().default(""),
});

export type Config = z.infer<typeof envSchema>;

// ─── Singleton ───
let _config: Config | null = null;

function loadConfig(): Config {
  if (_config) return _config;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Missing or invalid environment variables:");
    for (const issue of parsed.error.issues) {
      console.error(`   ${issue.path.join(".")}: ${issue.message}`);
    }
    throw new Error(
      "Invalid environment configuration. Copy .env.example to .env and fill in the values."
    );
  }

  _config = parsed.data;
  return _config;
}

// Use a Proxy so that property access always reads the latest loaded config.
export const config: Config = new Proxy({} as Config, {
  get(_target, prop: string) {
    if (!_config) loadConfig();
    return (_config as any)[prop];
  },
});
