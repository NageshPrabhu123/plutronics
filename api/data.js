// GET  /api/data  → shared live state (routes, today's + recent reports, alerts, riders, crisis…)
// POST /api/data  → {action, ...}  student actions: report, rider, autoAlert
//                                   admin actions (need ADMIN_PIN if set): addRoute, deleteRoute, override, alert, config, addOperator, deleteOperator,
//                                   crisis {op: "set" | "simulate" | "reset"}  — Exam Day Crisis mode, shared by every device
import { load, save, send, readJson, istDate, storageKind, emptyCrisis } from "./_store.js";

const OUTCOMES = ["ontime", "late", "noshow", "full"];
const str = (s, n = 120) => String(s ?? "").trim().slice(0, n);
const num = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x) || 0));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const rid = () => "p" + Math.random().toString(36).slice(2, 10);
const point = (p) => (p && p.lat ? { name: str(p.name, 80), lat: num(p.lat, -90, 90), lng: num(p.lng, -180, 180) } : null);

function cleanCrisis(c = {}) {
  const detours = {};
  Object.entries(c.detours || {}).slice(0, 50).forEach(([k, d]) => {
    detours[str(k, 30)] = { found: !!d?.found, extraMin: num(d?.extraMin, 0, 300), extraKm: num(d?.extraKm, 0, 300), via: str(d?.via, 80), geometry: (d?.geometry || []).slice(0, 400) };
  });
  return {
    active: !!c.active, simulated: !!c.simulated,
    broken: (c.broken || []).map((x) => str(x, 40)).slice(0, 50),
    surgePct: num(c.surgePct, 0, 300), autos: num(c.autos, 0, 200), spare: num(c.spare, 0, 50),
    blocked: c.blocked && c.blocked.a && c.blocked.b ? { a: point(c.blocked.a), b: point(c.blocked.b), spot: point(c.blocked.spot) } : null,
    detours, startedAt: c.active ? Number(c.startedAt) || Date.now() : null,
    // v6: who decided the live plan, Claude's validated plan (real ids) and the comparison shown to the admin
    decision: c.decision === "claude" && c.claude ? "claude" : "greedy",
    decisionNote: str(c.decisionNote, 300),
    claude: c.claude && c.claude.map ? {
      map: Object.fromEntries(Object.entries(c.claude.map).slice(0, 1000).map(([k, v]) => [str(k, 60), str(v, 60)])),
      busMoves: (c.claude.busMoves || []).slice(0, 50).map((m) => ({ from: str(m.from, 40), to: str(m.to, 40), reason: str(m.reason, 200) })),
    } : null,
    claudeMeta: c.claudeMeta ? {
      model: str(c.claudeMeta.model, 60), ok: !!c.claudeMeta.ok, errors: (c.claudeMeta.errors || []).slice(0, 15).map((e) => str(e, 200)),
      reasons: (c.claudeMeta.reasons || []).slice(0, 8).map((e) => str(e, 400)), structured: !!c.claudeMeta.structured,
      examMiss: num(c.claudeMeta.examMiss, 0, 9999), stranded: num(c.claudeMeta.stranded, 0, 9999), at: Number(c.claudeMeta.at) || Date.now(),
    } : null,
  };
}

function publicView(db) {
  const today = istDate();
  const since = istDate(Date.now() - 120 * 864e5);
  return {
    routes: db.routes, reports: db.reports.filter((r) => r.date >= since).map(({ clientId, ...r }) => r),
    alerts: db.alerts.filter((a) => a.ts > Date.now() - 3 * 864e5),
    overrides: db.overrides[today] || {}, operators: db.operators, config: db.config,
    riders: Object.values(db.riders).map(({ clientId, ...r }) => ({ ...r, name: r.name.split(" ")[0] })),
    crisis: db.crisis || emptyCrisis(),
    today, storage: storageKind, adminLocked: !!process.env.ADMIN_PIN, serverTime: Date.now(),
  };
}

export default async function handler(req, res) {
  let db;
  try { db = await load(); } catch (e) { return send(res, 503, { error: "Database temporarily unavailable, please retry" }); }
  if (req.method === "GET") return send(res, 200, publicView(db));
  if (req.method !== "POST") return send(res, 405, { error: "GET or POST" });
  let b; try { b = await readJson(req); } catch { return send(res, 400, { error: "bad json" }); }
  const admin = !process.env.ADMIN_PIN || b.pin === process.env.ADMIN_PIN;
  const needAdmin = () => { if (!admin) { send(res, 403, { error: "Wrong admin PIN" }); return true; } return false; };
  const route = db.routes.find((r) => r.id === b.routeId);
  let myRid = null;

  switch (b.action) {
    case "report": {
      if (!route || !route.times.includes(b.time) || !OUTCOMES.includes(b.outcome)) return send(res, 400, { error: "bad report" });
      const cid = str(b.clientId, 60), today = istDate();
      // one report per device per trip per day (latest wins) — stops spam
      db.reports = db.reports.filter((r) => !(r.clientId === cid && r.routeId === b.routeId && r.time === b.time && r.date === today));
      db.reports.push({ routeId: b.routeId, time: b.time, outcome: b.outcome, date: today, ts: Date.now(), rain: num(b.rain, 0, 1), exam: db.config.examWeek ? 1 : 0, clientId: cid, by: str(b.name, 40).split(" ")[0] || "student" });
      // whole DB is one Redis value — keep it small (≈150 B/report → ≤ ~0.75 MB)
      if (db.reports.length > 5000) db.reports = db.reports.slice(-5000);
      break;
    }
    case "rider": {
      const cid = str(b.clientId, 60); if (!cid) return send(res, 400, { error: "clientId" });
      if (!b.routeId) { delete db.riders[cid]; break; }
      if (!route || !route.times.includes(b.time) || !b.stop) return send(res, 400, { error: "bad rider" });
      const exam = !!b.exam && HHMM.test(String(b.examTime || ""));
      db.riders[cid] = { clientId: cid, rid: db.riders[cid]?.rid || rid(), name: str(b.name, 40) || "Student", routeId: b.routeId, time: b.time, stop: point(b.stop), exam, examTime: exam ? b.examTime : null, ts: Date.now() };
      myRid = db.riders[cid].rid;
      break;
    }
    case "crisis": {
      if (needAdmin()) return;
      if (b.op === "reset") {
        db.crisis = emptyCrisis();
        Object.keys(db.riders).forEach((k) => { if (k.startsWith("sim-")) delete db.riders[k]; });
        db.alerts = db.alerts.filter((a) => !a.crisis); // crisis alerts end with the crisis
      } else if (b.op === "simulate") { // replace the simulated students (clearly flagged sim:true)
        Object.keys(db.riders).forEach((k) => { if (k.startsWith("sim-")) delete db.riders[k]; });
        (b.simRiders || []).slice(0, 400).forEach((s, i) => {
          const r = db.routes.find((x) => x.id === s.routeId); if (!r || !r.times.includes(s.time) || !s.stop) return;
          const exam = !!s.exam && HHMM.test(String(s.examTime || ""));
          db.riders["sim-" + i] = { clientId: "sim-" + i, rid: "sim" + i, sim: true, name: `Sim${String(i + 1).padStart(3, "0")}`, routeId: s.routeId, time: s.time, stop: point(s.stop), exam, examTime: exam ? s.examTime : null, ts: Date.now() };
        });
      } else {
        db.crisis = cleanCrisis({ ...b.crisis, startedAt: db.crisis?.startedAt });
      }
      break;
    }
    case "autoAlert": { // generated by clients from crowd reports; dedup by key
      const key = str(b.key, 120); if (!key.startsWith("auto-") || db.alerts.some((a) => a.key === key)) break;
      db.alerts.unshift({ level: ["high", "med", "low"].includes(b.level) ? b.level : "med", scope: str(b.scope, 40) || "all", text: str(b.text, 300), key, ts: Date.now(), auto: true });
      break;
    }
    case "alert":
      if (needAdmin()) return;
      db.alerts.unshift({ level: ["high", "med", "low"].includes(b.level) ? b.level : "med", scope: str(b.scope, 40) || "all", text: str(b.text, 300), ts: Date.now(), ...(b.crisis ? { crisis: true } : {}) });
      break;
    case "addRoute": {
      if (needAdmin()) return;
      const r = b.route || {};
      const times = (r.times || []).map((t) => str(t, 5)).filter((t) => HHMM.test(t)).sort();
      const stops = (r.stops || []).slice(0, 40).map((s) => ({ name: str(s.name, 80), lat: num(s.lat, -90, 90), lng: num(s.lng, -180, 180) })).filter((s) => s.name && s.lat);
      if (!str(r.code) || stops.length < 2 || !times.length) return send(res, 400, { error: "Route needs a name/number, at least 2 stops and 1 departure time" });
      db.routes.push({
        id: "r" + Date.now().toString(36), code: str(r.code, 60), operator: str(r.operator, 40) || "KSRTC", stops, times,
        offsets: (r.offsets || []).slice(0, 40).map((x) => num(x, 0, 600)), geometry: (r.geometry || []).slice(0, 2000),
        capacity: num(r.capacity, 10, 120) || 55, marketDay: r.marketDay === "" || r.marketDay == null ? null : num(r.marketDay, 0, 6),
        source: str(r.source, 300), verified: !!r.verified, sample: !!r.sample, addedBy: r.addedBy === "ai" ? "ai" : "admin", createdAt: Date.now(),
      });
      break;
    }
    case "deleteRoute":
      if (needAdmin()) return;
      db.routes = db.routes.filter((r) => r.id !== b.routeId);
      break;
    case "override": {
      if (needAdmin()) return;
      const today = istDate(); db.overrides = { [today]: db.overrides[today] || {} };
      const k = `${b.routeId}|${b.time}`;
      if (b.status) db.overrides[today][k] = str(b.status, 20); else delete db.overrides[today][k];
      break;
    }
    case "config":
      if (needAdmin()) return;
      db.config = { examWeek: !!b.config?.examWeek, spare: num(b.config?.spare, 0, 50) };
      break;
    case "addOperator":
      if (needAdmin()) return;
      if (!str(b.op?.name)) return send(res, 400, { error: "name" });
      db.operators.push({ id: "o" + Date.now().toString(36), name: str(b.op.name, 80), type: str(b.op.type, 30), phone: str(b.op.phone, 20), area: str(b.op.area, 80), cost: str(b.op.cost, 20), lat: num(b.op.lat, -90, 90), lng: num(b.op.lng, -180, 180) });
      break;
    case "deleteOperator":
      if (needAdmin()) return;
      db.operators = db.operators.filter((o) => o.id !== b.id);
      break;
    case "checkPin":
      return send(res, admin ? 200 : 403, { ok: admin });
    default:
      return send(res, 400, { error: "unknown action" });
  }
  try { await save(db); } catch (e) { return send(res, 500, { error: String(e.message) }); }
  return send(res, 200, myRid ? { ...publicView(db), myRid } : publicView(db));
}
