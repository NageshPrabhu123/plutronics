/* RouteLess — Exam Day Crisis engine (Surprise Hurdle).
 * Deterministic: every device computes the same plan from the same shared state (routes, riders, crisis).
 *  1. Bus breakdown   : broken trips get 0 seats
 *  2. Demand surge    : +N% anonymous riders on every trip
 *  3. Road blockage   : routes using the blocked road are flagged; OSRM detour (alternatives / via-point) or unusable
 *  4. Exam priority   : students with an exam are seated first, earliest exam first
 * Optimiser: replace broken buses (depot spare → under-used donor trips), then priority seat assignment
 * (own bus → other bus at your stop → bus at a nearby stop → shared-auto pod of 4), before/after metrics. */
(function () {
  const RL = window.RL;
  const C = (RL.Crisis = {});
  const EXAM_BUFFER = 10;            // must reach college this many minutes before the exam
  const REPLACE_DELAY = 15;          // a replacement bus leaves this much later than the broken one
  const AUTO_KMH = 25, AUTO_GATHER = 10, POD = 4;
  const NEAR_KM = 1.5, NEARBY_KM = 4;

  const tripKey = (r) => `${r.routeId}|${r.time}`;
  const nearestIdx = (route, p) => { let bi = -1, bd = 1e9; route.stops.forEach((s, i) => { const d = RL.haversine(s, p); if (d < bd) { bd = d; bi = i; } }); return { i: bi, km: bd }; };
  const boardAt = (t, p) => { const r = RL.R[t.routeId]; return RL.toMin(t.time) + (r.offsets[Math.max(0, nearestIdx(r, p).i)] || 0); };
  const arriveAt = (t) => { const r = RL.R[t.routeId]; return RL.toMin(t.time) + (r.offsets[r.offsets.length - 1] || 0); };
  const label = (t) => `${RL.R[t.routeId].code} ${t.time}`;
  // stable pseudo-random order (so "before" = first-come-first-served, same on every device)
  const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

  // ---------- road segments & blockage ----------
  C.segments = () => {
    const seen = new Map();
    RL.ROUTES.forEach((r) => r.stops.slice(0, -1).forEach((a, i) => {
      const b = r.stops[i + 1]; const k = [a.name, b.name].sort().join("⇄");
      if (!seen.has(k)) seen.set(k, { key: k, a, b, label: `${a.name} → ${b.name}`, routes: new Set() });
      seen.get(k).routes.add(r.id);
    }));
    return [...seen.values()].map((s) => ({ ...s, routes: [...s.routes] })).sort((x, y) => y.routes.length - x.routes.length);
  };
  const sameSpot = (p, q) => RL.haversine(p, q) < 0.5;
  C.blockedRoutes = (crisis) => {
    const bl = crisis && crisis.blocked; if (!bl) return [];
    return RL.ROUTES.filter((r) => r.stops.some((s, i) => i < r.stops.length - 1 && ((sameSpot(s, bl.a) && sameSpot(r.stops[i + 1], bl.b)) || (sameSpot(s, bl.b) && sameSpot(r.stops[i + 1], bl.a))))).map((r) => r.id);
  };

  // distance (km) from point to a polyline given as [lng,lat] pairs
  const minDistKm = (coords, p) => coords.reduce((m, [lng, lat]) => Math.min(m, RL.haversine({ lat, lng }, p)), 1e9);
  async function osrm(points, alternatives) {
    const u = `https://router.project-osrm.org/route/v1/driving/${points.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(";")}?overview=full&geometries=geojson${alternatives ? "&alternatives=3" : ""}`;
    const j = await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json(); if (j.code !== "Ok") throw new Error("OSRM " + j.code); return j.routes;
  }
  // Detour around the blocked road between a and b: OSRM alternatives first, then a via-point on either side.
  C.findDetour = async (a, b) => {
    const routes = await osrm([a, b], true);
    const fastest = routes[0]; const g = fastest.geometry.coordinates;
    const mid = g[Math.floor(g.length / 2)]; const spot = { lat: mid[1], lng: mid[0], name: "flooded spot" };
    const avoids = (r) => minDistKm(r.geometry.coordinates, spot) > 0.8;
    let alt = routes.slice(1).find(avoids), via = "OSRM alternative route";
    if (!alt) {
      const dLat = b.lat - a.lat, dLng = b.lng - a.lng, len = Math.hypot(dLat, dLng) || 1;
      for (const side of [1, -1]) for (const off of [0.025, 0.045]) {
        const v = { lat: spot.lat + (-dLng / len) * off * side, lng: spot.lng + (dLat / len) * off * side };
        try { const r = (await osrm([a, v, b], false))[0]; if (avoids(r)) { alt = r; via = `via-point detour (${(off * 111).toFixed(1)} km off the main road)`; break; } } catch {}
        if (alt) break;
      }
    }
    if (!alt) return { found: false, spot, extraMin: 0, extraKm: 0, via: "" };
    const step = Math.max(1, Math.floor(alt.geometry.coordinates.length / 300));
    return {
      found: true, spot, via,
      extraMin: Math.max(1, Math.round(((alt.duration - fastest.duration) / 60) * 1.35)),
      extraKm: Math.max(0, Math.round((alt.distance - fastest.distance) / 100) / 10),
      geometry: alt.geometry.coordinates.filter((_, i) => i % step === 0).map(([lng, lat]) => [+lat.toFixed(5), +lng.toFixed(5)]),
    };
  };

  // ---------- the optimiser ----------
  C.run = ({ riders, crisis }) => {
    const broken = new Set(crisis.broken || []);
    const blocked = new Set(C.blockedRoutes(crisis));
    const detourMin = (rid) => (blocked.has(rid) && crisis.detours?.[rid]?.found ? crisis.detours[rid].extraMin : 0);
    const routeUsable = (rid) => !blocked.has(rid) || !!crisis.detours?.[rid]?.found;

    // passengers: registered + simulated riders, plus anonymous surge riders on every trip
    const pax = riders.filter((r) => RL.T[tripKey(r)] && r.stop).map((r) => ({ id: r.rid || r.name, name: r.name, stop: r.stop, tripId: tripKey(r), exam: !!r.exam, examTime: r.examTime, sim: !!r.sim }));
    const byTrip = {}; pax.forEach((p) => (byTrip[p.tripId] = byTrip[p.tripId] || []).push(p));
    const surge = (crisis.surgePct || 0) / 100;
    Object.entries(byTrip).forEach(([tid, list]) => {
      const extra = Math.round(list.length * surge);
      for (let k = 0; k < extra; k++) pax.push({ id: `surge-${tid}-${k}`, name: "Extra rider (surge)", stop: list[k % list.length].stop, tripId: tid, exam: false, surge: true });
    });
    const deadline = (p) => (p.exam ? RL.toMin(p.examTime) - EXAM_BUFFER : Infinity);

    // trip state
    const T = {};
    RL.TRIPS.forEach((t) => {
      const usable = !broken.has(t.id) && routeUsable(t.routeId);
      T[t.id] = { trip: t, cap: usable ? t.capacity : 0, broken: broken.has(t.id), blocked: blocked.has(t.routeId), detour: detourMin(t.routeId), delay: detourMin(t.routeId), usable, replacedBy: null, donatedTo: null, before: 0, after: 0 };
    });
    const arr = (tid) => arriveAt(T[tid].trip) + T[tid].delay;

    // ---- BEFORE: no plan. Everyone waits for their own bus, first come first served, no priority, no autos.
    const before = { examMiss: 0, stranded: 0, exam: 0, total: pax.length };
    const seats0 = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.cap]));
    pax.slice().sort((a, b) => hash(a.id) - hash(b.id)).forEach((p) => {
      if (p.exam) before.exam++;
      const ok = seats0[p.tripId] > 0; if (ok) { seats0[p.tripId]--; T[p.tripId].before++; }
      if (!ok) before.stranded++;
      if (p.exam && (!ok || arr(p.tripId) > deadline(p))) before.examMiss++;
    });

    // ---- AFTER, step 1: replace broken buses (depot spare first, then under-used donor trips)
    const load = (tid) => (byTrip[tid] || []).length * (1 + surge);
    const examUrgency = (tid) => { const ex = (byTrip[tid] || []).filter((p) => p.exam).map((p) => RL.toMin(p.examTime)); return ex.length ? [ex.length, -Math.min(...ex)] : [0, 0]; };
    const needs = Object.values(T).filter((s) => s.broken && routeUsable(s.trip.routeId) && load(s.trip.id) > 0)
      .sort((x, y) => { const a = examUrgency(x.trip.id), b = examUrgency(y.trip.id); return b[0] - a[0] || b[1] - a[1] || load(y.trip.id) - load(x.trip.id); });
    let spare = crisis.spare || 0;
    const donors = Object.values(T).filter((s) => s.usable && load(s.trip.id) < s.trip.capacity * 0.4 && !(byTrip[s.trip.id] || []).some((p) => p.exam))
      .filter((s) => { // its riders must fit on another trip of the same route
        const free = Object.values(T).filter((o) => o !== s && o.usable && o.trip.routeId === s.trip.routeId).reduce((n, o) => n + Math.max(0, o.cap - load(o.trip.id)), 0);
        return free >= load(s.trip.id);
      }).sort((a, b) => load(a.trip.id) - load(b.trip.id));
    const donorIds = donors.map((d) => d.trip.id);
    const replacements = [];
    needs.forEach((s) => {
      let from = null, donor = "depot";
      if (spare > 0) { spare--; from = "depot reserve bus"; }
      else { const d = donors.find((x) => x.cap > 0 && x.trip.routeId !== s.trip.routeId) || donors.find((x) => x.cap > 0); if (d) { d.cap = 0; d.usable = false; d.donatedTo = s.trip.id; donor = d.trip.id; from = `bus moved from ${label(d.trip)} (only ${Math.round(load(d.trip.id))} riders, absorbed by its other trips)`; } }
      if (from) { s.cap = s.trip.capacity; s.usable = true; s.delay += REPLACE_DELAY; s.replacedBy = from; replacements.push({ trip: s.trip.id, label: label(s.trip), from, donor }); }
    });

    // ---- AFTER, step 2: priority seat assignment
    const seats = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.cap]));
    let autosLeft = crisis.autos || 0; const pods = [];
    const order = pax.slice().sort((a, b) => (b.exam - a.exam) || (a.exam && b.exam ? RL.toMin(a.examTime) - RL.toMin(b.examTime) : 0) || (!!a.surge - !!b.surge) || (hash(a.id) - hash(b.id)));
    const results = {}; const after = { examMiss: 0, stranded: 0, exam: before.exam, total: pax.length, moved: 0, nearby: 0, auto: 0, late: 0 };
    order.forEach((p) => {
      const opts = [];
      RL.TRIPS.forEach((t) => {
        const st = T[t.id]; if (!st.usable || seats[t.id] <= 0) return;
        const n = nearestIdx(RL.R[t.routeId], p.stop); if (n.i >= RL.R[t.routeId].stops.length - 1) return;
        if (n.km <= NEAR_KM) opts.push({ mode: t.id === p.tripId ? "own" : "next", tid: t.id, arrival: arr(t.id), board: boardAt(t, p.stop) + st.delay - st.detour, km: n.km });
        else if (n.km <= NEARBY_KM) opts.push({ mode: "nearby", tid: t.id, arrival: arr(t.id), board: boardAt(t, p.stop) + st.delay - st.detour, km: n.km, stopName: RL.R[t.routeId].stops[n.i].name });
      });
      const dl = deadline(p);
      const rank = (o) => (o.mode === "own" ? 0 : o.mode === "next" ? 1 : 2);
      const inTime = opts.filter((o) => o.arrival <= dl).sort((a, b) => rank(a) - rank(b) || a.arrival - b.arrival);
      let pick = inTime[0] || null;
      // shared-auto pod: straight to college from the student's stop
      // exam students' autos leave as early as needed to make the exam (never before 06:00); others at their bus time
      const autoTravel = AUTO_GATHER + ((RL.haversine(p.stop, RL.COLLEGE) * 1.3) / AUTO_KMH) * 60;
      const autoDep = Math.round(p.exam ? Math.max(6 * 60, dl - autoTravel) : boardAt(RL.T[p.tripId], p.stop));
      const autoArr = Math.round(autoDep + autoTravel);
      const podFor = () => {
        let pod = pods.find((x) => x.members.length < POD && RL.haversine(x.stop, p.stop) < 1.2);
        if (!pod && autosLeft > 0) { autosLeft--; pod = { id: `A${pods.length + 1}`, stop: p.stop, members: [], dep: autoDep }; pods.push(pod); }
        return pod;
      };
      let res;
      if (pick) res = { ...pick };
      else if (p.exam && autoArr <= dl) { const pod = podFor(); if (pod) { pod.members.push(p); res = { mode: "auto", pod: pod.id, arrival: autoArr, board: pod.dep }; } }
      if (!res) {
        const late = opts.sort((a, b) => a.arrival - b.arrival)[0];
        if (late) res = { ...late, late: true };
        else { const pod = podFor(); if (pod) { pod.members.push(p); res = { mode: "auto", pod: pod.id, arrival: autoArr, board: pod.dep }; } }
      }
      if (res && res.tid) { seats[res.tid]--; T[res.tid].after++; }
      if (!res) { res = { mode: "none" }; after.stranded++; }
      if (res.mode === "next") after.moved++;
      if (res.mode === "nearby") after.nearby++;
      if (res.mode === "auto") after.auto++;
      res.onTime = res.mode !== "none" && res.arrival <= dl;
      if (p.exam && !res.onTime) after.examMiss++;
      if (res.late) after.late++;
      results[p.id] = { ...res, p };
    });

    return { before, after, replacements, pods, results, trips: T, blockedRoutes: [...blocked], autosUsed: pods.length, spareLeft: spare,
      examStudents: order.filter((p) => p.exam), surgeAdded: pax.filter((p) => p.surge).length, order, donorIds, decidedBy: "greedy" };
  };

  // ---------- v6: what Claude sees (short ids T#/S# keep it compact; maps translate back) ----------
  const autoFor = (p) => {
    const dl = p.exam ? RL.toMin(p.examTime) - EXAM_BUFFER : Infinity;
    const travel = AUTO_GATHER + ((RL.haversine(p.stop, RL.COLLEGE) * 1.3) / AUTO_KMH) * 60;
    const dep = Math.round(p.exam ? Math.max(6 * 60, dl - travel) : boardAt(RL.T[p.tripId], p.stop));
    return { dep, arr: Math.round(dep + travel) };
  };
  // every bus a passenger could physically use (ignores seats — Claude decides seats); broken trips only "ifReplaced"
  const optionsFor = (p, crisis, blocked) => {
    const out = [];
    RL.TRIPS.forEach((t) => {
      const rid = t.routeId, det = blocked.has(rid) ? crisis.detours?.[rid] : null;
      if (blocked.has(rid) && !(det && det.found)) return;
      const n = nearestIdx(RL.R[rid], p.stop); if (n.i >= RL.R[rid].stops.length - 1 || n.km > NEARBY_KM) return;
      const isBroken = (crisis.broken || []).includes(t.id), extra = det && det.found ? det.extraMin : 0, rep = isBroken ? REPLACE_DELAY : 0;
      out.push({ tid: t.id, board: boardAt(t, p.stop) + rep, arrive: arriveAt(t) + extra + rep, km: n.km, stopName: RL.R[rid].stops[n.i].name, ifReplaced: isBroken });
    });
    return out;
  };
  C.claudeContext = ({ crisis }, greedy) => {
    const blocked = new Set(C.blockedRoutes(crisis));
    const T2S = {}, S2T = {}; RL.TRIPS.forEach((t, i) => { T2S[t.id] = "T" + (i + 1); S2T["T" + (i + 1)] = t.id; });
    const P2S = {}, S2P = {}; greedy.order.forEach((p, i) => { P2S[p.id] = "S" + (i + 1); S2P["S" + (i + 1)] = p.id; });
    const own = {}; greedy.order.forEach((p) => (own[p.tripId] = own[p.tripId] || []).push(p));
    const ctx = {
      simulated: !!crisis.simulated,
      rules: { examBufferMin: EXAM_BUFFER, podSize: POD, replacementDelayMin: REPLACE_DELAY, goal: "1) fewest exam students late or without transport, 2) fewest students without transport" },
      resources: { spareBuses: crisis.spare || 0, autos: crisis.autos || 0 },
      surgePct: crisis.surgePct || 0,
      blockedRoad: crisis.blocked ? `${crisis.blocked.a.name} ↔ ${crisis.blocked.b.name}` : null,
      trips: RL.TRIPS.map((t) => {
        const rid = t.routeId, det = blocked.has(rid) ? crisis.detours?.[rid] : null, list = own[t.id] || [];
        return { id: T2S[t.id], bus: label(t), seats: t.capacity, broken: (crisis.broken || []).includes(t.id), blockedNoDetour: blocked.has(rid) && !(det && det.found), detourMin: det && det.found ? det.extraMin : 0,
          arrivesCollege: RL.fmt(arriveAt(t) + (det && det.found ? det.extraMin : 0)), riders: list.length, examRiders: list.filter((p) => p.exam).length };
      }),
      donorCandidates: (greedy.donorIds || []).map((id) => T2S[id]),
      students: greedy.order.map((p) => {
        const a = autoFor(p);
        return { id: P2S[p.id], exam: p.exam ? p.examTime : "", stop: p.stop.name, own: T2S[p.tripId],
          opts: optionsFor(p, crisis, blocked).map((o) => [T2S[o.tid], RL.fmt(o.board), RL.fmt(o.arrive), o.ifReplaced ? "ifReplaced" : o.km > NEAR_KM ? `nearby ${o.km.toFixed(1)} km` : ""]),
          auto: [RL.fmt(a.dep), RL.fmt(a.arr)] };
      }),
      greedy: {
        examMiss: greedy.after.examMiss, withoutTransport: greedy.after.stranded,
        busMoves: greedy.replacements.map((r) => ({ from: r.donor === "depot" ? "depot" : T2S[r.donor], to: T2S[r.trip] })),
        assign: Object.fromEntries(greedy.order.map((p) => { const r = greedy.results[p.id]; return [P2S[p.id], r.tid ? T2S[r.tid] : r.pod ? r.pod : ""]; })),
      },
    };
    // Claude's answer (short ids) → real ids we can store and share
    const toReal = (plan) => ({
      map: Object.fromEntries((plan.assignments || []).filter((a) => S2P[a.student]).map((a) => [S2P[a.student], a.bus ? S2T[a.bus] || "" : a.auto ? "auto:" + a.auto : ""])),
      busMoves: (plan.busMoves || []).map((m) => ({ from: m.from === "depot" ? "depot" : S2T[m.from] || m.from, to: S2T[m.to] || m.to, reason: m.reason || "" })),
    });
    return { ctx, toReal };
  };

  // ---------- v6: rebuild a full plan object from Claude's validated decisions (same shape as C.run) ----------
  C.applyClaude = ({ crisis }, greedy, cp) => {
    const blocked = new Set(C.blockedRoutes(crisis));
    const T = {};
    Object.entries(greedy.trips).forEach(([id, s]) => {
      const usable = !s.broken && (!s.blocked || !!s.detour || !!crisis.detours?.[s.trip.routeId]?.found);
      T[id] = { ...s, cap: usable ? s.trip.capacity : 0, usable, delay: s.detour, replacedBy: null, donatedTo: null, after: 0 };
    });
    const replacements = [];
    (cp.busMoves || []).forEach((m) => {
      const to = T[m.to]; if (!to) return;
      const fromLabel = m.from === "depot" ? "depot reserve bus" : T[m.from] ? `bus moved from ${label(T[m.from].trip)}` : "reserve bus";
      if (m.from !== "depot" && T[m.from]) { T[m.from].cap = 0; T[m.from].usable = false; T[m.from].donatedTo = m.to; }
      to.cap = to.trip.capacity; to.usable = true; to.delay += REPLACE_DELAY; to.replacedBy = fromLabel;
      replacements.push({ trip: m.to, label: label(to.trip), from: fromLabel + (m.reason ? ` (${m.reason})` : ""), donor: m.from });
    });
    const results = {}, pods = {}; const after = { examMiss: 0, stranded: 0, exam: greedy.before.exam, total: greedy.before.total, moved: 0, nearby: 0, auto: 0, late: 0 };
    // students who registered after Claude decided keep their on-device seat if that bus still has room
    const late = greedy.order.filter((p) => !(p.id in cp.map));
    const map = { ...cp.map };
    late.forEach((p) => { const g = greedy.results[p.id]; map[p.id] = g && g.tid ? g.tid : g && g.pod ? "" : ""; });
    const used = {}; Object.entries(map).forEach(([pid, v]) => { if (v && !v.startsWith("auto:")) used[v] = (used[v] || 0) + 1; });
    late.forEach((p) => { const v = map[p.id]; if (v && T[v] && used[v] > T[v].cap) { used[v]--; map[p.id] = ""; } });
    greedy.order.forEach((p) => {
      const v = map[p.id] || ""; const dl = p.exam ? RL.toMin(p.examTime) - EXAM_BUFFER : Infinity; let res;
      if (v.startsWith("auto:")) {
        const a = autoFor(p), id = v.slice(5); (pods[id] = pods[id] || { id, stop: p.stop, members: [], dep: a.dep }).members.push(p);
        res = { mode: "auto", pod: id, arrival: a.arr, board: a.dep }; after.auto++;
      } else if (v && T[v]) {
        const t = T[v].trip, n = nearestIdx(RL.R[t.routeId], p.stop);
        res = { mode: v === p.tripId ? "own" : n.km <= NEAR_KM ? "next" : "nearby", tid: v, arrival: arriveAt(t) + T[v].delay, board: boardAt(t, p.stop) + T[v].delay - T[v].detour, km: n.km, stopName: RL.R[t.routeId].stops[n.i].name };
        T[v].after++; if (res.mode === "next") after.moved++; if (res.mode === "nearby") after.nearby++;
      } else { res = { mode: "none" }; after.stranded++; }
      res.onTime = res.mode !== "none" && res.arrival <= dl;
      if (p.exam && !res.onTime) after.examMiss++;
      if (res.mode !== "none" && !p.exam && res.arrival > 9 * 60 + 30) after.late++;
      results[p.id] = { ...res, p };
    });
    return { ...greedy, trips: T, results, after, replacements, pods: Object.values(pods), autosUsed: Object.keys(pods).length, blockedRoutes: [...blocked], decidedBy: "claude" };
  };

  // ---------- one student's plan in plain words ----------
  C.personal = (plan, rid) => {
    const r = plan && plan.results[rid]; if (!r) return null;
    const p = r.p, orig = RL.T[p.tripId], st = plan.trips[p.tripId];
    const why = st.broken && !st.replacedBy ? `Your bus ${label(orig)} is broken down` : st.broken ? `Your bus ${label(orig)} broke down — a ${st.replacedBy.split(" (")[0]} replaces it` : st.blocked ? `Your route is affected by the road blockage${st.detour ? ` (detour +${st.detour} min)` : ""}` : `Your bus ${label(orig)} runs`;
    const exam = p.exam ? ` your ${p.examTime} exam` : "";
    if (r.mode === "none") return { level: "high", text: `${why}. No seat could be found${exam ? " before" + exam : ""} — contact the transport cell; you are on the priority list.` };
    if (r.mode === "auto") return { level: "high", text: `${why} → join shared-auto pod ${r.pod} at ${p.stop.name} at ${RL.fmt(r.board)}; you'll reach by ${RL.fmt(r.arrival)}${exam ? (r.onTime ? ", before" + exam : " — after" + exam + ", tell your exam cell") : ""}.` };
    const t = RL.T[r.tid];
    const where = r.mode === "nearby" ? ` from ${r.stopName} (${r.km.toFixed(1)} km away)` : "";
    const verb = r.mode === "own" ? (st.broken || st.blocked ? "→ your seat is reserved on" : "→ seat reserved on") : "→ take";
    return { level: st.broken || st.blocked || r.mode !== "own" ? "high" : "med", text: `${why} ${verb} ${label(t)}${where} at ${RL.fmt(r.board)}, you'll reach by ${RL.fmt(r.arrival)}${exam ? (r.onTime ? ", before" + exam : " — after" + exam + ", tell your exam cell") : ""}.` };
  };

  // ---------- simulated students for the demo (clearly flagged) ----------
  C.simRiders = (brokenIds, n = 120) => {
    let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const trips = RL.TRIPS.slice(); const exams = ["08:30", "08:45", "09:00", "09:15", "09:30", "09:45"];
    const out = [];
    for (let i = 0; i < n; i++) {
      // ~35% of simulated students ride the trips that break down, so the crisis really bites
      const pool = rnd() < 0.35 && brokenIds.length ? trips.filter((t) => brokenIds.includes(t.id)) : trips;
      const t = pool[Math.floor(rnd() * pool.length)]; const r = RL.R[t.routeId];
      const s = r.stops[Math.floor(rnd() * (r.stops.length - 1))];
      const exam = rnd() < 0.4;
      out.push({ routeId: t.routeId, time: t.time, stop: { name: s.name, lat: +(s.lat + (rnd() - 0.5) * 0.006).toFixed(5), lng: +(s.lng + (rnd() - 0.5) * 0.006).toFixed(5) }, exam, examTime: exam ? exams[Math.floor(rnd() * exams.length)] : null });
    }
    return out;
  };
})();
