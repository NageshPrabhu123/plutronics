// Login for RouteLess (v9). Node crypto only — no extra packages.
//  - student passwords: scrypt + random 16-byte salt (never stored or returned in plain text)
//  - sessions: HMAC-SHA256 signed token (SESSION_SECRET), valid 7 days
//  - admin: ADMIN_ID / ADMIN_PASSWORD from environment variables (never in frontend code)
import crypto from "node:crypto";

const TOKEN_DAYS = 7;
const b64u = (buf) => Buffer.from(buf).toString("base64url");

export const authConfigured = () => !!process.env.SESSION_SECRET;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}
export function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(String(password), Buffer.from(salt, "hex"), 64);
  const want = Buffer.from(hash, "hex");
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}
// constant-time compare for the admin ID/password (hash first so lengths always match)
export function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const y = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(x, y) && String(a ?? "") === String(b ?? "");
}

const sign = (data) => b64u(crypto.createHmac("sha256", process.env.SESSION_SECRET).update(data).digest());
export function signToken({ sub, role, name }) {
  const payload = b64u(JSON.stringify({ sub, role, name, iat: Date.now(), exp: Date.now() + TOKEN_DAYS * 864e5 }));
  return `${payload}.${sign(payload)}`;
}
export function verifyToken(token) {
  if (!token || !authConfigured()) return null;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  const good = Buffer.from(sign(payload)), got = Buffer.from(sig);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    return p.exp > Date.now() && (p.role === "student" || p.role === "admin") ? p : null;
  } catch { return null; }
}
// user from "Authorization: Bearer <token>"; students must still exist (an admin can remove them)
export function userFrom(req, db) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const u = verifyToken(String(h).replace(/^Bearer\s+/i, ""));
  if (!u) return null;
  if (u.role === "student" && !(db && db.students && db.students[u.sub])) return null;
  return u;
}

// students log in with their email address (stored lower-case)
export const normEmail = (s) => String(s || "").trim().toLowerCase();
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/;
