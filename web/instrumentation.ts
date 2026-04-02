/**
 * Next.js instrumentation hook — runs once at server startup.
 * Validates that required environment variables are present so
 * misconfigurations fail loudly instead of silently at request time.
 */
export async function register() {
  // Only validate on the server (not during build or in the edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const required = [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    ];

    // These are only required for the WhatsApp webhook but we still want
    // early warning if they're missing in a deployed environment
    const webhookVars = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_WHATSAPP_FROM",
      "ANTHROPIC_API_KEY",
    ];

    const missing = [...required, ...webhookVars].filter(
      (k) => !process.env[k],
    );

    if (missing.length > 0) {
      console.error(
        `[sitemgr] WARNING: Missing environment variables: ${missing.join(", ")}`,
      );
      console.error(
        "[sitemgr] Some features will not work. Check your Vercel/hosting env var configuration.",
      );
    }
  }
}
