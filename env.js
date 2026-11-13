// Local runs only: load variables (e.g. ANTHROPIC_API_KEY) from .env into process.env.
// On Vercel the values come from Project → Settings → Environment Variables; this file is not used there.
// Never logs values. .env is git-ignored.
import { fileURLToPath } from "node:url";
import path from "node:path";

// ROUTELESS_NO_DOTENV=1 skips it (used to test the app without an API key).
if (!process.env.ROUTELESS_NO_DOTENV) {
  try {
    process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), ".env"));
  } catch {
    /* no .env file — fine */
  }
}
