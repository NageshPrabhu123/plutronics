// Server-side safety check for a crisis plan proposed by Claude (v6).
// The plan is only used if it passes. Metrics are recomputed here from the context, never taken from Claude.
// ctx  = what the browser sent: { rules, resources, trips[], donorCandidates[], students[] }
//        students[i].opts = [[tripId, board "H:MM", arrive "H:MM", note]]  (note "ifReplaced" for broken trips)
// plan = Claude's JSON: { assignments[{student,bus,auto}], busMoves[{from,to,reason}], reasons[], studentsMissingExam[], studentsWithoutTransport[] }
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };

// v7: Claude lists only the students it seats DIFFERENTLY from the greedy plan (shorter answer → fits Vercel's 60 s).
// Everyone it doesn't mention keeps their greedy seat. The merged, complete plan is what gets checked and used.
export function mergeWithGreedy(ctx, plan) {
  if (!plan || !Array.isArray(plan.assignments)) return plan;
  const seat = new Map(Object.entries(ctx.greedy?.assign || {}));
  for (const a of plan.assignments) if (a && a.student) seat.set(a.student, a.bus || (a.auto ? a.auto : ""));
  const assignments = (ctx.students || []).map((s) => {
    const v = seat.get(s.id) || "";
    return { student: s.id, bus: v.startsWith("T") ? v : "", auto: v && !v.startsWith("T") ? v : "" };
  });
  return { ...plan, assignments, changed: plan.assignments.length };
}

export function checkCrisisPlan(ctx, plan) {
  const errors = [];
  if (!plan || !Array.isArray(plan.assignments) || !Array.isArray(plan.busMoves)) return { ok: false, errors: ["reply was not the required JSON shape"], metrics: null };
  const trips = Object.fromEntries((ctx.trips || []).map((t) => [t.id, t]));
  const studs = Object.fromEntries((ctx.students || []).map((s) => [s.id, s]));
  const spare = ctx.resources?.spareBuses || 0, autos = ctx.resources?.autos || 0, podSize = ctx.rules?.podSize || 4, buffer = ctx.rules?.examBufferMin ?? 10;

  // 1. bus moves: depot buses within the spare count, donors only from the allowed list, only onto broken trips
  let depot = 0; const replaced = new Set(), donated = new Set();
  for (const m of plan.busMoves) {
    const to = trips[m.to];
    if (!to || !to.broken) { errors.push(`bus move to ${m.to} is not a broken trip`); continue; }
    if (to.blockedNoDetour) { errors.push(`${m.to} cannot run: its road is blocked with no detour`); continue; }
    if (replaced.has(m.to)) { errors.push(`${m.to} replaced twice`); continue; }
    if (m.from === "depot") { if (++depot > spare) { errors.push(`uses ${depot} depot buses, only ${spare} available`); continue; } }
    else if (!(ctx.donorCandidates || []).includes(m.from) || donated.has(m.from)) { errors.push(`${m.from} cannot lend its bus`); continue; }
    else donated.add(m.from);
    replaced.add(m.to);
  }
  const cap = (id) => { const t = trips[id]; if (!t || donated.has(id) || t.blockedNoDetour) return 0; if (t.broken) return replaced.has(id) ? t.seats : 0; return t.seats; };

  // 2. assignments: only reachable options, no broken bus unless replaced, seats and pod limits
  const used = {}, pods = {}, placed = {};
  for (const a of plan.assignments) {
    const s = studs[a.student];
    if (!s) { errors.push(`unknown student ${a.student}`); continue; }
    if (placed[a.student]) { errors.push(`${a.student} assigned twice`); continue; }
    if (a.bus) {
      const o = (s.opts || []).find((x) => x[0] === a.bus);
      if (!o) { errors.push(`${a.student}: ${a.bus} does not stop near them`); continue; }
      if (cap(a.bus) === 0) { errors.push(`${a.student}: ${a.bus} has no seats (broken, blocked or bus moved away)`); continue; }
      used[a.bus] = (used[a.bus] || 0) + 1; placed[a.student] = o[2];
    } else if (a.auto) {
      if (!s.auto) { errors.push(`${a.student}: no shared auto possible`); continue; }
      (pods[a.auto] = pods[a.auto] || []).push(a.student); placed[a.student] = s.auto[1];
    }
  }
  for (const [id, n] of Object.entries(used)) if (n > cap(id)) errors.push(`${id} over capacity: ${n}/${cap(id)} seats`);
  if (Object.keys(pods).length > autos) errors.push(`uses ${Object.keys(pods).length} autos, only ${autos} available`);
  for (const [p, m] of Object.entries(pods)) if (m.length > podSize) errors.push(`auto ${p} carries ${m.length} students (max ${podSize})`);

  // 3. every exam student placed or explicitly listed as missing the exam
  const listed = new Set(plan.studentsMissingExam || []);
  let examMiss = 0, stranded = 0, examTotal = 0;
  for (const s of ctx.students || []) {
    const arr = placed[s.id];
    if (!arr) stranded++;
    if (s.exam) {
      examTotal++;
      if (!arr && !listed.has(s.id)) errors.push(`exam student ${s.id} neither placed nor listed`);
      if (!arr || toMin(arr) > toMin(s.exam) - buffer) examMiss++;
    }
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 15), errorCount: errors.length, metrics: { examMiss, stranded, examTotal, placed: Object.keys(placed).length, autosUsed: Object.keys(pods).length } };
}
