// POST /api/auth  {action: "signup" | "login", role: "student" | "admin", id, password, name?, code?}
// → { token, user: { id, name, role } }   (token = signed, 7 days; the client keeps it in localStorage)
import { load, save, send, readJson } from "./_store.js";
import { hashPassword, verifyPassword, safeEqual, signToken, authConfigured, normEmail, EMAIL_RE } from "./_auth.js";

const MAX_TRIES = 5, LOCK_MS = 60_000;
const str = (s, n = 80) => String(s ?? "").trim().slice(0, n);

// 5 wrong tries → locked for 1 minute (stored in the shared DB so it holds across serverless instances)
function lockedFor(db, key) { const f = db.loginFails?.[key]; return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
// returns tries left before the lock (0 = just locked)
function fail(db, key) {
  db.loginFails = db.loginFails || {};
  const f = db.loginFails[key] || { n: 0, until: 0 };
  if (f.until && f.until <= Date.now()) { f.n = 0; f.until = 0; } // previous lock expired
  f.n += 1;
  if (f.n >= MAX_TRIES) { f.n = 0; f.until = Date.now() + LOCK_MS; db.loginFails[key] = f; return 0; }
  db.loginFails[key] = f;
  return MAX_TRIES - f.n;
}
const clearFails = (db, key) => { if (db.loginFails) delete db.loginFails[key]; };

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (!authConfigured()) return send(res, 500, { error: "Login is not configured on the server (SESSION_SECRET missing)." });
  let b; try { b = await readJson(req); } catch { return send(res, 400, { error: "bad json" }); }
  let db; try { db = await load(); } catch { return send(res, 503, { error: "Database temporarily unavailable, please retry" }); }
  db.students = db.students || {};
  const role = b.role === "admin" ? "admin" : "student";
  const done = async (code, body) => { try { await save(db); } catch {} return send(res, code, body); };

  if (b.action === "signup") {
    if (role !== "student") return send(res, 400, { error: "Only students can sign up." });
    const email = normEmail(b.id), name = str(b.name, 40), password = String(b.password || "");
    if (!EMAIL_RE.test(email) || email.length > 120) return send(res, 400, { error: "Please enter a valid email address, e.g. asha@sahyadri.edu.in." });
    // v10: only college emails (env ALLOWED_EMAIL_DOMAINS="sahyadri.edu.in,mite.ac.in"); unset = allow all
    const allowed = String(process.env.ALLOWED_EMAIL_DOMAINS || "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
    const domain = email.split("@")[1];
    if (allowed.length && !allowed.some((d) => domain === d || domain.endsWith("." + d)))
      return send(res, 403, { error: `Please sign up with your college email (${allowed.map((d) => "@" + d).join(" or ")}).` });
    if (name.length < 2) return send(res, 400, { error: "Please enter your name." });
    if (password.length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
    if (db.students[email]) return send(res, 409, { error: "This email is already registered. Log in instead." });
    db.students[email] = { email, name, ...hashPassword(password), createdAt: Date.now() };
    const user = { sub: email, role: "student", name };
    return done(200, { token: signToken(user), user: { id: email, name, role: "student" } });
  }

  if (b.action === "login") {
    const id = role === "admin" ? str(b.id, 60) : normEmail(b.id), password = String(b.password || "");
    const key = `${role}:${id.toLowerCase()}`;
    const wait = lockedFor(db, key); if (wait) return send(res, 429, { error: `Too many wrong passwords. Try again in ${wait} s.` });
    let user = null;
    if (role === "admin") {
      if (!process.env.ADMIN_ID || !process.env.ADMIN_PASSWORD) return send(res, 500, { error: "Admin login is not configured (ADMIN_ID / ADMIN_PASSWORD missing)." });
      if (safeEqual(id, process.env.ADMIN_ID) && safeEqual(password, process.env.ADMIN_PASSWORD)) user = { sub: id, role: "admin", name: "Transport cell" };
    } else {
      const s = db.students[id];
      if (s && verifyPassword(password, s.salt, s.hash)) user = { sub: id, role: "student", name: s.name };
    }
    if (!user) { const left = fail(db, key); return done(401, { error: left > 0 ? `Wrong ${role === "admin" ? "ID" : "email"} or password (${left} tries left).` : "Wrong password 5 times. Login is blocked for 1 minute." }); }
    clearFails(db, key);
    return done(200, { token: signToken(user), user: { id: user.sub, name: user.name, role: user.role } });
  }
  return send(res, 400, { error: "unknown action" });
}
