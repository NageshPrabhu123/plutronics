// Dev-only: run RouteLess WITHOUT an API key (ignores .env) on port 5174 with a separate data file.
process.env.ROUTELESS_NO_DOTENV = "1";
delete process.env.ANTHROPIC_API_KEY;
process.env.PORT = "5174";
process.env.DATA_FILE = new URL("../data/nokey-db.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await import("../server.js");
