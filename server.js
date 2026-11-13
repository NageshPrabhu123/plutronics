// Local dev server: serves /public and the /api/assistant function (same code Vercel runs).
import "./env.js"; // must be first: loads .env (local only) before the api modules read process.env
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assistant from "./api/assistant.js";
import data from "./api/data.js";
import auth from "./api/auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const PORT = process.env.PORT || 5173;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/assistant") return assistant(req, res);
  if (url.pathname === "/api/data") return data(req, res);
  if (url.pathname === "/api/auth") return auth(req, res);
  let p = path.normalize(path.join(pub, decodeURIComponent(url.pathname)));
  if (!p.startsWith(pub)) { res.statusCode = 403; return res.end(); }
  if (url.pathname.endsWith("/")) p = path.join(p, "index.html");
  try {
    const data = await readFile(p);
    res.setHeader("Content-Type", TYPES[path.extname(p)] || "application/octet-stream");
    res.end(data);
  } catch { res.statusCode = 404; res.end("Not found"); }
}).listen(PORT, () => console.log(`RouteLess running at http://localhost:${PORT}`));
