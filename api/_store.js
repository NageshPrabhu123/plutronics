// Shared database for RouteLess. Everything every student/admin sees comes from here.
// Production (Vercel): Upstash Redis via REST — set KV_REST_API_URL + KV_REST_API_TOKEN
//   (added automatically when you connect "Upstash for Redis" in the Vercel Marketplace),
//   or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
// Local (npm start): a JSON file at data/db.json.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "routeless:db:v2";
const FILE = process.env.DATA_FILE || (process.env.VERCEL ? "/tmp/routeless-db.json" : path.join(process.cwd(), "data", "db.json"));

export const storageKind = URL_ ? "upstash" : process.env.VERCEL ? "ephemeral" : "file";

export const emptyCrisis = () => ({ active: false, simulated: false, broken: [], surgePct: 40, autos: 10, spare: 0, blocked: null, detours: {}, startedAt: null });
export const emptyDb = () => ({ routes: [], reports: [], alerts: [], overrides: {}, riders: {}, operators: [], config: { examWeek: false, spare: 0 }, crisis: emptyCrisis() });

// A failed READ must never look like an empty database — otherwise the next write would wipe all data.
// Only "key not set yet" (Upstash) or "file not created yet" (local) count as empty.
export async function load() {
  if (URL_) {
    const r = await fetch(`${URL_}/get/${encodeURIComponent(KEY)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error("storage read failed: " + (j.error || r.status));
    return j.result ? { ...emptyDb(), ...JSON.parse(j.result) } : emptyDb();
  }
  try {
    return { ...emptyDb(), ...JSON.parse(await readFile(FILE, "utf8")) };
  } catch (e) {
    if (e.code === "ENOENT") return emptyDb();
    throw e;
  }
}

export async function save(db) {
  const body = JSON.stringify(db);
  if (URL_) {
    const r = await fetch(URL_, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(["SET", KEY, body]) });
    if (!r.ok) throw new Error("storage write failed " + r.status);
    return;
  }
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, body);
}

export const istDate = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export async function readJson(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

export function send(res, code, obj) {
  res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(obj));
}
