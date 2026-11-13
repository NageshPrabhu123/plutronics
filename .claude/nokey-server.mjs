// Dev-only: run RouteLess WITHOUT an Anthropic key on port 5174 with a separate data file.
// Loads .env (login settings) but removes ANTHROPIC_API_KEY; env.js then skips .env.
try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch {}
delete process.env.ANTHROPIC_API_KEY;
process.env.ROUTELESS_NO_DOTENV = "1";
process.env.PORT = "5174";
process.env.DATA_FILE = new URL("../data/nokey-db.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await import("../server.js");
