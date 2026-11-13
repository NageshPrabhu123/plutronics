/* RouteLess — UI controller (live data only).
 * NOTE: device prefs live in `P` — never name it `L`, that is Leaflet's global. */
(function () {
  const RL = window.RL;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => Math.round(p * 100);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- device-local prefs ----------
  const KEY = "routeless.v2";
  let P; try { P = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { P = {}; }
  P = Object.assign({ profile: { name: "", stop: null, arrive: "08:45", tripId: "" }, clientId: "c" + Math.random().toString(36).slice(2) + Date.now().toString(36), pin: "", role: "student", dismissed: [], posted: [], registered: "" }, P);
  const saveP = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch {} };
  saveP();

  let DB = { routes: [], reports: [], alerts: [], overrides: {}, riders: [], operators: [], config: { examWeek: false, spare: 0 }, today: RL.istDate(), storage: null, adminLocked: false };
  let STOPS = [], weather = { ok: false, rain: 0, prob: null }, ROWS = {}, online = false;
  const W = { rain: "live", day: "today" };
  RL.buildTrips([]); RL.Model.train([]);

  // ---------- helpers ----------
  const selDow = () => (W.day === "today" ? RL.istDow() : +W.day);
  const isToday = () => W.day === "today";
  const rainVal = () => (W.rain === "live" ? (weather.ok ? weather.rain : 0) : +W.rain);
  function ctxFor(tripId) {
    const t = RL.T[tripId], r = RL.R[t.routeId], dow = selDow();
    return { rain: rainVal(), market: r.marketDay === dow ? 1 : 0, monday: dow === 1 ? 1 : 0, exam: DB.config.examWeek ? 1 : 0 };
  }
  const tripLabel = (t) => (t && RL.R[t.routeId] ? `${RL.R[t.routeId].code} · ${t.time}` : "—");
  const nearestIdx = (route, p) => { let bi = -1, bd = 1e9; route.stops.forEach((s, i) => { const d = RL.haversine(s, p); if (d < bd) { bd = d; bi = i; } }); return { i: bi, km: bd }; };
  const depAt = (t, p) => { const r = RL.R[t.routeId]; const i = p ? nearestIdx(r, p).i : 0; return RL.toMin(t.time) + (r.offsets[i] || 0); };
  const arrAt = (t) => { const r = RL.R[t.routeId]; return RL.toMin(t.time) + (r.offsets[r.offsets.length - 1] || 0); };
  const routesNear = (p, km = 1.5) => (p ? RL.ROUTES.filter((r) => { const n = nearestIdx(r, p); return n.km <= km && n.i < r.stops.length - 1; }) : []);
  const tripsNear = (p, km) => { const ids = new Set(routesNear(p, km).map((r) => r.id)); return RL.TRIPS.filter((t) => ids.has(t.routeId)); };
  const riskCls = (p) => (p >= 0.6 ? "bad" : p >= 0.35 ? "warn" : "ok");
  const STATUS_CLS = { Available: "ok", Delayed: "warn", Cancelled: "bad", Full: "full", Unknown: "info", "Broken down": "bad", "Replacement bus": "warn", Detour: "warn", "Road blocked": "bad", "Bus moved": "warn" };
  let stopsReady = Promise.resolve(); // set at boot: the one in-flight OpenStreetMap stops request
  let PLAN = null, GREEDY = null, CLAUDE = null; // Exam Day Crisis: live plan (null when off), on-device plan, Claude's plan
  const decidedBy = () => (PLAN && PLAN.decidedBy === "claude" ? "Decided by Claude" : "Decided by on-device optimiser");
  const crisisOn = () => !!(DB.crisis && DB.crisis.active);
  // v8: a bus that broke down on the way triggers re-planning even without Exam Day Crisis mode
  const midwayList = () => (DB.crisis && DB.crisis.midway) || [];
  const planOn = () => crisisOn() || midwayList().length > 0;
  const planInput = () => ({ riders: DB.riders, crisis: crisisOn() ? DB.crisis : { ...DB.crisis, broken: [], surgePct: 0, blocked: null, detours: {}, spare: DB.config.spare || 0 } });
  const gmaps = (p) => `https://www.google.com/maps/dir/?api=1&origin=${p.lat},${p.lng}&destination=${RL.COLLEGE.lat},${RL.COLLEGE.lng}&travelmode=transit`;
  const todayReports = () => DB.reports.filter((r) => r.date === DB.today);
  // copy column headers into each cell's data-label, so tables can stack as cards on phones
  const labelTable = (tbl) => {
    const head = tbl.querySelector("tr"); if (!head || !head.querySelector("th")) return;
    head.classList.add("tr-head"); const labels = [...head.cells].map((c) => c.textContent.trim());
    [...tbl.rows].slice(1).forEach((r) => [...r.cells].forEach((c, i) => c.setAttribute("data-label", labels[i] || "")));
  };
  const keepSel = (sel, html) => { const v = sel.value; sel.innerHTML = html; if ([...sel.options].some((o) => o.value === v)) sel.value = v; };

  // ---------- compute ----------
  function liveStatus(t, pred, dem) {
    const k = `${t.routeId}|${t.time}`;
    const cs = PLAN && isToday() ? PLAN.trips[k] : null;
    if (cs) {
      const sim = DB.crisis.simulated ? " (simulated)" : "";
      if (cs.midway) return { s: cs.replacedBy ? "Replacement bus" : "Broken down", src: `broke down on the way ${cs.midway.place} at ${RL.fmt(cs.midway.at)}${cs.replacedBy ? ` — rescue bus, ${PLAN.repDelay[k]} min late` : ""}${sim}`, live: true };
      if (cs.broken && cs.replacedBy) return { s: "Replacement bus", src: `broke down — ${cs.replacedBy.split(" (")[0]}, +15 min${sim}`, live: true };
      if (cs.broken) return { s: "Broken down", src: `Exam Day Crisis${sim}`, live: true };
      if (cs.donatedTo) return { s: "Bus moved", src: `bus sent to ${tripLabel(RL.T[cs.donatedTo])}; riders re-seated${sim}`, live: true };
      if (cs.blocked) return cs.detour ? { s: "Detour", src: `road flooded — detour +${cs.detour} min${sim}`, live: true } : { s: "Road blocked", src: `road flooded, no detour${sim}`, live: true };
    }
    if (isToday() && DB.overrides[k]) return { s: DB.overrides[k], src: "Transport office", live: true };
    const todays = isToday() ? todayReports().filter((r) => r.routeId === t.routeId && r.time === t.time).sort((a, b) => a.ts - b.ts).slice(-6) : [];
    if (todays.length) {
      const cnt = {}; todays.forEach((r, i) => (cnt[r.outcome] = (cnt[r.outcome] || 0) + 1 + i * 0.01)); // ties → most recent
      const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
      return { s: { ontime: "Available", late: "Delayed", noshow: "Cancelled", full: "Full" }[top], src: `${todays.length} student report${todays.length > 1 ? "s" : ""} today`, live: true };
    }
    if (pred.p >= 0.55) return { s: "Delayed", src: "AI forecast", live: false };
    if (dem.registered && dem.demand > t.capacity) return { s: "Full", src: "AI forecast (crowded)", live: false };
    return { s: "Unknown", src: "no report yet", live: false };
  }
  function compute() {
    ROWS = {};
    PLAN = null; GREEDY = null; CLAUDE = null;
    if (planOn() && RL.TRIPS.length) {
      try {
        const input = planInput();
        GREEDY = PLAN = RL.Crisis.run(input);
        if (DB.crisis.claude) CLAUDE = RL.Crisis.applyClaude(input, GREEDY, DB.crisis.claude);
        if (DB.crisis.decision === "claude" && CLAUDE) PLAN = CLAUDE; // the plan every device shows
      } catch (e) { console.error("crisis plan", e); }
    }
    RL.TRIPS.forEach((t) => {
      const c = ctxFor(t.id); const pred = RL.Model.predict(t.id, c); const dem = RL.demand(t.id, c, DB.riders, DB.reports);
      ROWS[t.id] = { trip: t, route: RL.R[t.routeId], c, pred, ...dem, capacity: t.capacity, status: liveStatus(t, pred, dem) };
    });
  }
  function rankOptions(p) {
    const target = RL.toMin(P.profile.arrive || "08:45");
    return tripsNear(p).map((t) => {
      const row = ROWS[t.id], arr = arrAt(t), dep = depAt(t, p);
      let score = row.pred.p * 100 + (arr > target ? 150 + (arr - target) * 3 : (target - arr) / 2) + (row.demand > row.capacity ? 20 : 0);
      if (row.status.live && row.status.s === "Cancelled") score += 400;
      return { t, row, dep, arr, score };
    }).sort((a, b) => a.score - b.score);
  }

  // ---------- data ----------
  function ingest(d) {
    DB = Object.assign({ routes: [], reports: [], alerts: [], overrides: {}, riders: [], operators: [], config: { examWeek: false, spare: 0 }, crisis: { active: false, broken: [], detours: {} } }, d);
    if (d && d.myRid) { P.myRid = d.myRid; saveP(); }
    RL.buildTrips(DB.routes); RL.Model.train(DB.reports); compute();
    online = true;
    $("#liveChip").textContent = `● live · ${DB.routes.length} routes · ${DB.reports.length} reports`;
    $("#liveChip").style.background = "rgba(34,197,94,.35)";
  }
  async function refresh() {
    try {
      ingest(await RL.api.get());
    } catch {
      online = false; $("#liveChip").textContent = "● offline · retrying"; $("#liveChip").style.background = "rgba(220,38,38,.55)";
      compute();
    }
    renderAll();
  }
  async function post(body) {
    try { ingest(await RL.api.post(body)); }
    catch (e) {
      if (e.status === 401 && ME && !RL.session.get()) { logout(); openLogin(ME.role, "Your session expired. Please log in again."); }
      else if (e.status === 401) openLogin(/admin/i.test(e.message) ? "admin" : "student", e.message);
      throw e;
    }
    renderAll(); return DB;
  }

  // ---------- v9: login (email + password for students, ADMIN_ID / ADMIN_PASSWORD for the transport cell) ----------
  let ME = RL.session.get();
  const isStudent = () => !!(ME && ME.role === "student");
  const isAdmin = () => !!(ME && ME.role === "admin");
  // the rider registration belongs to the account that made it
  if (P.regUser !== (ME && ME.id)) { P.registered = ""; P.myRid = null; P.regUser = ME ? ME.id : null; saveP(); }
  let lgRole = "student", lgMode = "login";
  function renderUserChip() {
    const el = $("#userChip");
    if (!ME) { el.className = "chip userchip guest"; el.innerHTML = `🆘 Emergency access <button type="button" id="ucLogin">Log in</button> <button type="button" id="ucExit">Exit</button>`; $("#ucLogin").onclick = () => openLogin("student"); $("#ucExit").onclick = () => setMode("welcome"); }
    else { el.className = "chip userchip"; el.innerHTML = `${ME.role === "admin" ? `🚌 Transport cell (${esc(ME.id)})` : `👤 ${esc(ME.name)} · ${esc(ME.id)} · Student`} <button type="button" id="ucLogout">Log out</button>`; $("#ucLogout").onclick = logout; }
    // students' name comes from their account
    if (isStudent()) { $("#pName").value = ME.name; $("#pName").disabled = true; P.profile.name = ME.name; } else $("#pName").disabled = false;
  }
  function setLgUi() {
    const m = $("#loginModal");
    m.classList.toggle("signup", lgRole === "student" && lgMode === "signup"); m.classList.toggle("admin", lgRole === "admin");
    $$("[data-lg]").forEach((b) => b.classList.toggle("on", b.dataset.lg === lgRole));
    $("#loginTitle").textContent = lgRole === "admin" ? "Transport cell login" : lgMode === "signup" ? "Student sign-up" : "Student login";
    $("#lgIdLabel").textContent = lgRole === "admin" ? "Admin ID" : "Email";
    $("#lgId").type = lgRole === "admin" ? "text" : "email";
    $("#lgId").autocomplete = lgRole === "admin" ? "username" : "email";
    $("#lgId").placeholder = lgRole === "admin" ? "Admin ID" : "you@college.edu";
    $("#lgPass").autocomplete = lgMode === "signup" ? "new-password" : "current-password";
    $("#lgPass").placeholder = lgMode === "signup" ? "At least 6 characters" : "";
    $("#lgName").required = lgRole === "student" && lgMode === "signup";
    $("#lgSubmit").textContent = lgMode === "signup" && lgRole === "student" ? "Create account" : "Log in";
    $("#lgToggle").textContent = lgMode === "signup" ? "Already registered? Log in" : "New student? Sign up with your email";
  }
  function openLogin(role = "student", msg = "") {
    lgRole = role; lgMode = "login"; setLgUi();
    $("#lgMsg").className = "lgmsg"; $("#lgMsg").textContent = msg; $("#lgPass").value = "";
    $("#loginModal").classList.remove("hidden"); setTimeout(() => $("#lgId").focus(), 50);
  }
  const closeLogin = () => $("#loginModal").classList.add("hidden");
  async function submitLogin(e) {
    e.preventDefault();
    const body = { action: lgRole === "student" && lgMode === "signup" ? "signup" : "login", role: lgRole, id: $("#lgId").value.trim(), password: $("#lgPass").value, name: $("#lgName").value.trim() };
    if (body.action === "signup" && body.password.length < 6) { $("#lgMsg").textContent = "Password must be at least 6 characters."; return; }
    $("#lgSubmit").disabled = true; $("#lgMsg").className = "lgmsg ok"; $("#lgMsg").textContent = body.action === "signup" ? "Creating your account…" : "Checking…";
    try {
      const j = await RL.api.auth(body);
      RL.session.set(j.token); ME = RL.session.get(); aiAvailable = null;
      if (P.regUser !== ME.id) { P.registered = ""; P.myRid = null; P.regUser = ME.id; saveP(); }
      $("#lgPass").value = ""; closeLogin(); renderUserChip(); setMode("app");
      await refresh(); await setRole(isAdmin() ? "admin" : "student");
    } catch (er) { $("#lgMsg").className = "lgmsg"; $("#lgMsg").textContent = er.message; }
    $("#lgSubmit").disabled = false;
  }
  function logout() {
    RL.session.clear(); ME = null; aiAvailable = null; P.registered = ""; P.myRid = null; P.regUser = null; saveP();
    renderUserChip(); setRole("student"); setMode("welcome"); refresh();
  }
  // front page → (login) full app, or (no login) emergency access with the Alternatives tab only
  function setMode(m) {
    if (ME) m = "app";
    try { m === "emergency" ? sessionStorage.setItem("routeless.emergency", "1") : sessionStorage.removeItem("routeless.emergency"); } catch {}
    document.body.classList.toggle("mode-welcome", m === "welcome");
    document.body.classList.toggle("mode-emergency", m === "emergency");
    if (m === "emergency") { showTab("alt"); $("#altStop").value = P.profile.stop ? P.profile.stop.name : ""; }
    else if (m === "app" && !isAdmin()) showTab("home");
    window.scrollTo(0, 0);
  }
  const startMode = () => { let e = false; try { e = sessionStorage.getItem("routeless.emergency") === "1"; } catch {} return ME ? "app" : e ? "emergency" : "welcome"; };
  function resolveStop(text) {
    text = (text || "").trim().toLowerCase(); if (!text) return null;
    return STOPS.find((s) => s.name.toLowerCase() === text) || STOPS.find((s) => s.name.toLowerCase().startsWith(text)) || STOPS.find((s) => s.name.toLowerCase().includes(text)) || null;
  }
  async function resolveOrGeocode(text) {
    const s = resolveStop(text); if (s) return s;
    try { const g = await RL.geocode(text + ", Dakshina Kannada"); return g ? { id: "geo", name: text, lat: g.lat, lng: g.lng } : null; } catch { return null; }
  }

  // ---------- HOME ----------
  function renderHome() {
    const p = P.profile.stop;
    $("#fromName").textContent = p ? p.name : "your stop";
    if (p) { $("#gmapsLink").href = gmaps(p); $("#gmapsLink").classList.remove("hidden"); } else $("#gmapsLink").classList.add("hidden");
    const opts = rankOptions(p);
    if (opts.length && !opts.some((o) => o.t.id === P.profile.tripId)) { P.profile.tripId = opts[0].t.id; saveP(); }
    $("#pTrip").innerHTML = opts.length ? opts.slice().sort((a, b) => a.dep - b.dep).map((o) => `<option value="${esc(o.t.id)}" ${o.t.id === P.profile.tripId ? "selected" : ""}>${esc(o.row.route.code)} · ${RL.fmt(o.dep)} from your stop</option>`).join("") : `<option value="">— no registered bus near this stop —</option>`;
    $("#riderBtn").textContent = !isStudent() ? "🔒 Log in to register as a rider" : P.registered && P.registered === P.profile.tripId ? "✔ Registered (tap to remove)" : "✅ I ride this bus";
    const hero = $("#forecastHero");
    if (!p) {
      hero.className = "hero"; hero.innerHTML = `<div class="big">Pick your bus stop to get today's forecast.</div><div class="sub">${STOPS.length ? STOPS.length + " real bus stops loaded from OpenStreetMap. Type your stop above or tap a dot on the map." : "Loading real bus stops from OpenStreetMap…"}</div>`;
      $("#options").innerHTML = `<div class="empty">No stop selected yet.</div>`; renderMap(); return;
    }
    if (!opts.length) {
      hero.className = "hero"; hero.innerHTML = `<div class="big">No registered bus route passes ${esc(p.name)} yet.</div>
        <div class="sub">RouteLess only shows buses entered by the college transport cell (Admin tab), each with its source.</div>
        <div class="rec">🗺️ <a href="${gmaps(p)}" target="_blank" rel="noopener" style="color:#fff">See every bus Google Maps knows from ${esc(p.name)} →</a><br>👩‍💼 Admin → "Load starter routes" or "Add a real bus route".</div>`;
      $("#options").innerHTML = `<div class="empty">No routes within 1.5 km of this stop.</div>`; renderMap(); return;
    }
    const my = ROWS[P.profile.tripId], best = opts[0]; const dep = depAt(my.trip, p);
    const day = isToday() ? "today" : "on " + RL.DAYS[selDow()];
    hero.className = "hero " + (my.pred.p >= 0.6 ? "risk-high" : my.pred.p >= 0.35 ? "risk-med" : "");
    hero.innerHTML = `
      <div class="big">${pct(my.pred.p)}% chance the ${RL.fmt(dep)} ${esc(my.route.code)} is late or doesn't come ${day} — ${esc(RL.reasonText(my.pred))}.</div>
      <div class="sub">${my.pred.evidence ? `Learned from <b>${my.pred.evidence}</b> real reports on this route` : "No reports on this route yet — prior estimate; it sharpens with every tap in Report"} · rain forecast ${W.rain === "live" ? (weather.ok ? weather.prob + "%" : "n/a") : "what-if " + pct(+W.rain) + "%"} · status: <b>${my.status.s}</b> (${esc(my.status.src)})${my.registered ? ` · ${my.registered} registered riders, ${my.capacity} seats` : ""}</div>
      <div class="why">${my.pred.factors.map((f) => `<span>${f.val >= 0 ? "▲" : "▼"} ${esc(f.label)} ${f.val >= 0 ? "+" : ""}${f.val.toFixed(2)}</span>`).join("")}</div>
      <div class="rec">${best.t.id === my.trip.id ? `✅ This is your best option ${day}.` : `💡 <b>Better ${day}:</b> ${esc(best.row.route.code)} at ${RL.fmt(best.dep)} — ${pct(best.row.pred.p)}% risk, reaches college ${RL.fmt(best.arr)}.`}
        ${my.pred.p >= 0.5 ? `<br>🛺 Have a backup ready: <a href="#" data-goto="alt" style="color:#fff">see alternatives →</a>` : ""}</div>`;
    $("#options").innerHTML = opts.map((o, i) => {
      const rel = RL.reliability(DB.reports, o.t.routeId);
      return `<div class="opt ${i === 0 ? "best" : ""}"><div class="bar" style="background:${routeColor(o.t.routeId)}"></div>
        <div><div class="t">${RL.fmt(o.dep)} → ${RL.fmt(o.arr)} · ${esc(o.row.route.code)} ${i === 0 ? '<span class="pill p-info">AI pick</span>' : ""}</div>
        <div class="meta">${esc(o.row.route.operator)} · ${o.row.registered ? `${o.row.registered} riders registered` : "no riders registered"} · ${esc(RL.reasonText(o.row.pred))}</div></div>
        <div style="text-align:right"><span class="pill p-${riskCls(o.row.pred.p)}">${pct(o.row.pred.p)}% risk</span><br>
        <span class="grade g-${rel.score == null ? "C" : rel.grade}" style="${rel.score == null ? "background:#94a3b8" : ""}" title="${rel.score == null ? "No reports yet" : "Reliability " + rel.score + "/100 from " + rel.reports + " reports"}">${rel.grade}</span> <span class="pill p-${STATUS_CLS[o.row.status.s]}">${o.row.status.s}</span></div></div>`;
    }).join("");
    $$("[data-goto]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); showTab(a.dataset.goto); }));
    renderMap();
  }

  // ---------- MAP ----------
  const PALETTE = ["#e4572e", "#2e86ab", "#7b2cbf", "#17a34a", "#f59e0b", "#db2777", "#0891b2", "#65a30d", "#9333ea", "#ea580c"];
  const routeColor = (id) => PALETTE[Math.max(0, RL.ROUTES.findIndex((r) => r.id === id)) % PALETTE.length];
  let map, stopLayer, routeLayer, meMarker, routeSig = "", crisisLayer, crisisSig = "";
  function renderMap() {
    if (!window.L) return;
    if (!map) {
      map = L.map("map", { scrollWheelZoom: false }).setView([12.88, 75.05], 10);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 18 }).addTo(map);
      L.marker([RL.COLLEGE.lat, RL.COLLEGE.lng], { icon: L.divIcon({ html: "🎓", className: "", iconSize: [26, 26] }) }).addTo(map).bindPopup(`<b>${RL.COLLEGE.name}</b>`);
      stopLayer = L.layerGroup().addTo(map); routeLayer = L.layerGroup().addTo(map);
      map.on("popupopen", (e) => { const b = e.popup.getElement().querySelector("[data-pick]"); if (b) b.onclick = () => { setStop(STOPS.find((s) => s.id === b.dataset.pick)); map.closePopup(); }; });
    }
    if (stopLayer.getLayers().length !== STOPS.length) {
      stopLayer.clearLayers();
      STOPS.forEach((s) => L.circleMarker([s.lat, s.lng], { radius: s.station ? 8 : 6, color: "#ffffff", weight: 2, fillColor: s.station ? "#b45309" : "#0f766e", fillOpacity: 0.95 }).addTo(stopLayer)
        .bindPopup(`<b>${esc(s.name)}</b><br><button data-pick="${s.id}">Set as my stop</button>`));
    }
    const sel = RL.T[P.profile.tripId]?.routeId || "";
    const sig = RL.ROUTES.map((r) => r.id).join() + "|" + sel;
    if (sig !== routeSig) {
      routeSig = sig; routeLayer.clearLayers();
      RL.ROUTES.forEach((r) => {
        const g = r.geometry && r.geometry.length ? r.geometry : r.stops.map((s) => [s.lat, s.lng]);
        L.polyline(g, { color: routeColor(r.id), weight: r.id === sel ? 7 : 4, opacity: r.id === sel ? 0.95 : 0.55 }).addTo(routeLayer).bindTooltip(r.code);
      });
    }
    // Exam Day Crisis overlay: flooded spot + detour
    if (!crisisLayer) crisisLayer = L.layerGroup().addTo(map);
    const csig = JSON.stringify([crisisOn(), DB.crisis?.blocked, Object.keys(DB.crisis?.detours || {}), midwayList()]);
    if (csig !== crisisSig) {
      crisisSig = csig; crisisLayer.clearLayers();
      midwayList().forEach((m) => { if (RL.T[m.tripId]) L.marker([m.lat, m.lng], { icon: L.divIcon({ html: "🛠", className: "", iconSize: [28, 28] }) }).addTo(crisisLayer).bindTooltip(`${tripLabel(RL.T[m.tripId])} broke down ${m.place} at ${RL.fmt(m.at)}`); });
      if (crisisOn() && DB.crisis.blocked) {
        const b = DB.crisis.blocked, s = b.spot || { lat: (b.a.lat + b.b.lat) / 2, lng: (b.a.lng + b.b.lng) / 2 };
        L.marker([s.lat, s.lng], { icon: L.divIcon({ html: "🌊", className: "", iconSize: [28, 28] }) }).addTo(crisisLayer).bindTooltip(`Flooded road: ${b.a.name} ↔ ${b.b.name}`);
        const d = Object.values(DB.crisis.detours || {}).find((x) => x.found && x.geometry && x.geometry.length);
        if (d) L.polyline(d.geometry, { color: "#dc2626", weight: 5, dashArray: "8 6" }).addTo(crisisLayer).bindTooltip(`Detour +${d.extraMin} min`);
      }
    }
    if (meMarker) meMarker.remove(); meMarker = null;
    if (P.profile.stop) meMarker = L.marker([P.profile.stop.lat, P.profile.stop.lng], { icon: L.divIcon({ html: "📍", className: "", iconSize: [26, 26] }) }).addTo(map).bindTooltip("My stop");
    $("#mapLegend").innerHTML = RL.ROUTES.map((r) => `<span><i style="background:${routeColor(r.id)}"></i>${esc(r.code)}</span>`).join("") || '<span class="muted">🟢 bus stop · 🟠 bus station (real OpenStreetMap data). Click a dot to set it as your stop.</span>';
  }
  function setStop(s) {
    if (!s) return; P.profile.stop = { id: s.id, name: s.name, lat: s.lat, lng: s.lng }; P.profile.tripId = ""; saveP();
    $("#pStop").value = s.name; showStopInfo();
    if (map) map.setView([s.lat, s.lng], 12);
    compute(); renderAll(); loadWeather();
  }
  function showStopInfo() {
    const s = P.profile.stop; $("#stopInfo").textContent = s ? `📍 ${s.name} (${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}) · ${RL.haversine(s, RL.COLLEGE).toFixed(1)} km from college` : "";
  }

  // ---------- STATUS ----------
  function renderStatus() {
    if (!RL.TRIPS.length) { $("#statusList").innerHTML = `<div class="empty">No bus routes registered yet. The transport cell can add them in the Admin tab.</div>`; return; }
    $("#statusList").innerHTML = RL.TRIPS.slice().sort((a, b) => a.time.localeCompare(b.time)).map((t) => {
      const row = ROWS[t.id]; const load = row.registered ? Math.round((100 * row.demand) / row.capacity) : null;
      const col = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", full: "var(--full)", info: "var(--line)" }[STATUS_CLS[row.status.s] || "info"];
      return `<div class="st" style="border-left-color:${col}">
        <h4><span>${esc(row.route.code)} · ${t.time}</span><span class="pill p-${STATUS_CLS[row.status.s]}">${row.status.s}</span></h4>
        <div class="muted small">${row.route.stops.map((s) => esc(s.name)).join(" → ")}</div>
        ${load != null ? `<div class="meter"><i style="width:${Math.min(100, load)}%;background:${load > 100 ? "var(--bad)" : load > 80 ? "var(--warn)" : "var(--ok)"}"></i></div><div class="small">Est. crowd ${load}% (${row.demand}/${row.capacity})</div>` : ""}
        <div class="small">Delay risk <b>${pct(row.pred.p)}%</b> · ${row.pred.evidence} reports on route</div>
        <div class="small muted">${row.status.live ? "🟢 Live: " : "🔮 "}${esc(row.status.src)}</div></div>`;
    }).join("");
  }

  // ---------- REPORT ----------
  function renderReport() {
    // v9: only logged-in students can report (the server enforces this too)
    $("#reportGate").classList.toggle("hidden", isStudent()); $("#reportBody").classList.toggle("hidden", !isStudent());
    const near = new Set(tripsNear(P.profile.stop, 3).map((t) => t.id));
    const list = RL.TRIPS.slice().sort((a, b) => (near.has(b.id) - near.has(a.id)) || a.time.localeCompare(b.time));
    const sel = $("#rTrip"); const had = sel.value;
    sel.innerHTML = list.length ? list.map((t) => `<option value="${esc(t.id)}">${esc(tripLabel(t))}</option>`).join("") : `<option value="">No routes registered yet</option>`;
    // follow "My usual bus" unless the student picked another bus here by hand
    sel.value = sel.dataset.touched && [...sel.options].some((o) => o.value === had) ? had : RL.T[P.profile.tripId] ? P.profile.tripId : sel.options[0]?.value || "";
    $$(".rb").forEach((b) => (b.disabled = !list.length));
    const ic = { ontime: "✅", late: "⏱️", noshow: "❌", full: "🈵" };
    const tr = todayReports().slice().sort((a, b) => b.ts - a.ts);
    $("#todayReports").innerHTML = tr.length ? tr.slice(0, 20).map((r) => `<div class="small" style="padding:4px 0">${ic[r.outcome]} ${esc(RL.R[r.routeId]?.code || "deleted route")} · ${r.time} <span class="muted">· ${esc(r.by)} · ${new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>`).join("") : '<p class="muted">No reports yet today. Be the first.</p>';
  }
  async function submitReport(outcome) {
    const tripId = $("#rTrip").value; const t = RL.T[tripId]; if (!t) return;
    const before = RL.reliability(DB.reports, t.routeId);
    try {
      await post({ action: "report", routeId: t.routeId, time: t.time, outcome, rain: weather.ok ? weather.rain : 0, clientId: P.clientId, name: P.profile.name });
    } catch (e) { $("#reportMsg").innerHTML = `<div class="note">Could not save (${esc(e.message)}). Check your connection and try again.</div>`; return; }
    const rel = RL.reliability(DB.reports, t.routeId);
    const same = todayReports().filter((r) => r.routeId === t.routeId && r.time === t.time);
    const ns = same.filter((r) => r.outcome === "noshow").length, fl = same.filter((r) => r.outcome === "full").length;
    if (ns >= 2) autoAlert("high", t.routeId, `${ns} students report ${tripLabel(t)} did NOT come today. Use alternatives or your travel pod.`, `auto-${DB.today}-${tripId}-noshow`);
    if (fl >= 2) autoAlert("med", t.routeId, `${tripLabel(t)} reported full today. Next bus or shared transport advised.`, `auto-${DB.today}-${tripId}-full`);
    $("#reportMsg").innerHTML = `<div class="toast">Saved — AI retrained on ${RL.Model.n} real reports. ${esc(RL.R[t.routeId].code)} reliability: ${before.score ?? "–"} → <b>${rel.score ?? "–"}/100 (${rel.grade})</b> from ${rel.reports} reports. One report per bus per day from this phone; tapping again replaces it.</div>`;
  }

  // ---------- ALTERNATIVES ----------
  async function renderAlt() {
    const p = P.profile.stop;
    if (!p) { $("#altBody").innerHTML = `<div class="empty">${document.body.classList.contains("mode-emergency") ? "Type your stop above, or tap 📍 Use my location." : "Set your bus stop in Route Finder first."}</div>`; return; }
    const my = ROWS[P.profile.tripId];
    const others = rankOptions(p).filter((o) => o.t.id !== P.profile.tripId).slice(0, 4);
    const nearby = RL.ROUTES.filter((r) => { const n = nearestIdx(r, p); return n.km > 1.5 && n.km <= 4 && n.i < r.stops.length - 1; })
      .flatMap((r) => { const n = nearestIdx(r, p); return r.times.map((tm) => ({ r, s: r.stops[n.i], km: n.km, row: ROWS[`${r.id}|${tm}`], dep: RL.toMin(tm) + (r.offsets[n.i] || 0) })); })
      .sort((a, b) => a.row.pred.p - b.row.pred.p).slice(0, 4);
    const ops = DB.operators.map((o) => ({ ...o, km: o.lat ? RL.haversine(p, o) : null })).sort((a, b) => (a.km ?? 99) - (b.km ?? 99));
    $("#altBody").innerHTML = `
      ${my ? `<p>Your bus: <b>${esc(my.route.code)} · ${RL.fmt(depAt(my.trip, p))}</b> <span class="pill p-${riskCls(my.pred.p)}">${pct(my.pred.p)}% risk</span> <span class="pill p-${STATUS_CLS[my.status.s]}">${my.status.s}</span></p>` : ""}
      <div class="alt"><div><b>🗺️ Every bus Google Maps knows from ${esc(p.name)}</b><span class="muted small">Public-transport directions to ${esc(RL.COLLEGE.name)}</span></div><a href="${gmaps(p)}" target="_blank" rel="noopener"><button>Open</button></a></div>
      <h3>🚌 Other registered buses from your stop</h3>
      ${others.map((o) => `<div class="alt"><div><b>${esc(o.row.route.code)} at ${RL.fmt(o.dep)}</b><span class="muted small">arrives ${RL.fmt(o.arr)} · ${esc(o.row.status.s)}</span></div><span class="pill p-${riskCls(o.row.pred.p)}">${pct(o.row.pred.p)}% risk</span></div>`).join("") || '<p class="muted small">None registered.</p>'}
      <h3>🚶 Buses from a nearby stop (1.5–4 km)</h3>
      ${nearby.map((n) => `<div class="alt"><div><b>${esc(n.r.code)} from ${esc(n.s.name)} at ${RL.fmt(n.dep)}</b><span class="muted small">${n.km.toFixed(1)} km away</span></div><span class="pill p-${riskCls(n.row.pred.p)}">${pct(n.row.pred.p)}% risk</span></div>`).join("") || '<p class="muted small">None registered.</p>'}
      <h3>🛺 Verified local transport (added by transport cell)</h3>
      ${ops.map((o) => `<div class="alt"><div><b>${esc(o.type)} · ${esc(o.name)}</b><span class="muted small">${esc(o.area)}${o.km != null ? ` · ${o.km.toFixed(1)} km` : ""}${o.cost ? " · " + esc(o.cost) : ""}</span> <span class="verified">✔ Verified</span></div>${o.phone ? `<a href="tel:${esc(o.phone.replace(/\s/g, ""))}"><button>📞 Call</button></a>` : ""}</div>`).join("") || '<p class="muted small">None added yet.</p>'}
      <h3>🚕 Taxi / auto stands & bus stations near you (OpenStreetMap)</h3><div id="taxiList"><p class="muted small">Loading…</p></div>`;
    try {
      const tx = await RL.loadTaxiStands(p);
      const el = $("#taxiList"); if (el) el.innerHTML = tx.map((x) => `<div class="alt"><div><b>${esc(x.name)}</b><span class="muted small">${esc(x.type)} · ${x.km.toFixed(1)} km</span></div><a href="https://www.google.com/maps/dir/?api=1&destination=${x.lat},${x.lng}&travelmode=walking" target="_blank" rel="noopener"><button class="ghost">Directions</button></a></div>`).join("") || '<p class="muted small">None mapped on OpenStreetMap within 4 km.</p>';
    } catch { const el = $("#taxiList"); if (el) el.innerHTML = '<p class="muted small">OpenStreetMap lookup unavailable right now.</p>'; }
  }

  // ---------- GROUPS ----------
  function renderGroups() {
    const sel = $("#gTrip");
    keepSel(sel, RL.TRIPS.length ? RL.TRIPS.map((t) => `<option value="${esc(t.id)}">${esc(tripLabel(t))}</option>`).join("") : `<option value="">No routes yet</option>`);
    if (!sel.dataset.touched && RL.T[P.profile.tripId]) sel.value = P.profile.tripId;
    const tripId = sel.value; if (!tripId || !ROWS[tripId]) { $("#groupBody").innerHTML = `<div class="empty">No bus routes registered yet.</div>`; return; }
    const row = ROWS[tripId]; const pods = RL.groupRiders(tripId, DB.riders);
    const total = pods.reduce((s, g) => s + g.members.length, 0);
    $("#groupBody").innerHTML = `
      <p>${total} registered student${total === 1 ? "" : "s"} on this bus → <b>${pods.length} pod${pods.length === 1 ? "" : "s"}</b>. Delay risk <span class="pill p-${riskCls(row.pred.p)}">${pct(row.pred.p)}%</span>
      ${pods.length && (row.pred.p >= 0.45 || row.status.s === "Cancelled") ? `<button id="activate">🚨 Activate backup plan</button>` : ""}</p>
      ${!total ? `<div class="empty">No students registered on this bus yet. Tap "I ride this bus" in Route Finder.</div>` : ""}
      <div class="groups">${pods.map((g) => `<div class="grp"><b>Pod ${g.id}</b> · near ${esc(g.stop.name)}<ul>${g.members.map((m) => `<li>${esc(m.name)} <span class="muted small">(${esc(m.stop.name)})</span></li>`).join("")}</ul></div>`).join("")}</div>`;
    const btn = $("#activate");
    if (btn) btn.onclick = () => { autoAlert("med", RL.T[tripId].routeId, `Backup plan active for ${tripLabel(RL.T[tripId])}: ${pods.length} pod(s), meet at your stop 10 min before departure and share an auto.`, `auto-${DB.today}-${tripId}-pods`); showTab("alerts"); };
  }

  // ---------- ALERTS ----------
  async function autoAlert(level, scope, text, key) {
    if (!ME) return; // guests can't post (server would answer 401)
    if (P.posted.includes(key) || DB.alerts.some((a) => a.key === key)) return;
    P.posted.push(key); P.posted = P.posted.slice(-200); saveP();
    try { await post({ action: "autoAlert", level, scope, text, key }); } catch {}
  }
  let seenAlerts = null;
  function notify(text) { try { if ("Notification" in window && Notification.permission === "granted") new Notification("RouteLess alert", { body: text }); } catch {} }
  function riskAlerts() {
    if (!online || !isToday() || W.rain !== "live") return;
    Object.values(ROWS).forEach((r) => { if (r.pred.p >= 0.7 && r.pred.evidence >= 5) autoAlert("med", r.trip.routeId, `${pct(r.pred.p)}% chance ${r.route.code} ${r.trip.time} is late today (${RL.reasonText(r.pred)}). Leave early or check alternatives.`, `auto-${DB.today}-${r.trip.id}-risk`); });
    if (weather.ok && weather.prob >= 70) autoAlert("med", "all", `Heavy rain likely this morning (${weather.prob}% chance, 6–9 am). Expect delays on rural routes.`, `auto-${DB.today}-wx`);
  }
  function renderAlerts() {
    keepSel($("#aScope"), `<option value="all">All students</option>` + RL.ROUTES.map((r) => `<option value="${r.id}">${esc(r.code)} riders</option>`).join(""));
    const myRoute = RL.T[P.profile.tripId]?.routeId;
    const list = DB.alerts || [];
    const forMe = (a) => a.scope === "all" || a.scope === myRoute || a.level === "high";
    if (seenAlerts) list.filter((a) => !seenAlerts.has(a.ts) && forMe(a)).forEach((a) => notify(a.text));
    seenAlerts = new Set(list.map((a) => a.ts));
    $("#alertList").innerHTML = list.map((a) => `<div class="al ${a.level}">${a.scope === myRoute ? "📍 " : ""}${esc(a.text)}<small>${a.scope === "all" ? "All students" : esc(RL.R[a.scope]?.code || "route")} · ${a.auto ? "auto (crowd/AI)" : "transport office"} · ${new Date(a.ts).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}</small></div>`).join("") || '<p class="muted">No alerts in the last 3 days.</p>';
    // while the red crisis banner shows, crisis alerts stay in the Alerts tab only (no second banner on phones)
    const mine = list.filter((a) => forMe(a) && !P.dismissed.includes(a.ts) && !(a.crisis && planOn()));
    const cnt = $("#alertCount"); cnt.textContent = mine.length; cnt.classList.toggle("hidden", !mine.length);
    const top = mine.find((a) => a.level === "high") || mine[0]; const b = $("#alertBanner");
    if (top) { b.className = "banner " + top.level; b.innerHTML = `<span>🚨 ${esc(top.text)}</span><button title="Dismiss">✕</button>`; b.querySelector("button").onclick = () => { P.dismissed.push(top.ts); P.dismissed = P.dismissed.slice(-200); saveP(); renderAlerts(); }; }
    else b.className = "banner hidden";
  }

  // ---------- ADMIN ----------
  const charts = {};
  function chart(id, cfg) { try { if (charts[id]) charts[id].destroy(); if (window.Chart) charts[id] = new Chart($("#" + id), cfg); } catch (e) { console.warn("chart", id, e); } }
  let newStops = [];
  function renderAdmin() {
    if (!document.body.classList.contains("admin") || !$("#tab-admin").classList.contains("on")) return;
    const sk = { upstash: ["ok", "✔ Shared cloud database (Upstash Redis) connected — every student sees the same live data."], file: ["ok", "✔ Database file data/db.json on this server — shared by everyone using it."], ephemeral: ["", "⚠ No permanent database on this deployment. Connect Upstash Redis in Vercel (Storage → Upstash for Redis) so reports are kept."] }[DB.storage] || ["", "⚠ Server offline — showing last loaded data."];
    $("#storageNote").innerHTML = `<div class="note ${online ? sk[0] : ""}">${online ? sk[1] : "⚠ Server offline — showing last loaded data."}${online ? ` · Logged in as transport cell (${esc(ME ? ME.id : "")}).` : ""}</div>`;
    // v9: registered students (email, name, date; never any password data)
    const studs = DB.students || [];
    $("#studentTable").innerHTML = studs.length ? `<tr><th>Email</th><th>Name</th><th>Registered</th><th></th></tr>` + studs.map((s) => `<tr><td><b>${esc(s.email)}</b></td><td>${esc(s.name)}</td><td>${new Date(s.createdAt).toLocaleDateString()}</td><td><button data-delstu="${esc(s.email)}">Remove</button></td></tr>`).join("") : `<tr><td class="muted">No students have signed up yet.</td></tr>`;
    labelTable($("#studentTable"));
    $$("[data-delstu]").forEach((b) => (b.onclick = async () => { if (confirm(`Remove student ${b.dataset.delstu}? Their account and rider registration are deleted; they can sign up again.`)) { try { await post({ action: "deleteStudent", email: b.dataset.delstu }); } catch (e) { alert(e.message); } } }));
    const rows = Object.values(ROWS);
    $("#kpis").innerHTML = [[DB.routes.length, "registered routes"], [RL.TRIPS.length, "morning trips"], [DB.riders.length, "registered riders"], [DB.reports.length, "real reports (120 d)"], [todayReports().length, "reports today"], [rows.filter((r) => r.pred.p >= 0.6).length, "high-risk trips"]]
      .map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`).join("");
    if ($("#nMarket").options.length < 2) $("#nMarket").innerHTML += RL.DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join("");
    $("#nStops").innerHTML = newStops.map((s, i) => `<span>${i + 1}. ${esc(s.name)}<b data-rm="${i}">✕</b></span>`).join("") + `<span>🎓 ${esc(RL.COLLEGE.name)}</span>`;
    $$("[data-rm]").forEach((x) => (x.onclick = () => { newStops.splice(+x.dataset.rm, 1); renderAdmin(); }));

    $("#routeTable").innerHTML = DB.routes.length ? `<tr><th>Route</th><th>Operator</th><th>Stops</th><th>Departures</th><th>Trip time</th><th>Reports</th><th>Reliability</th><th>Source</th><th></th></tr>` + DB.routes.map((r) => {
      const rel = RL.reliability(DB.reports, r.id);
      return `<tr><td><b>${esc(r.code)}</b>${r.addedBy === "ai" ? ' <span class="pill p-info">AI-found</span>' : ""}${r.sample ? ' <span class="pill p-warn">sample timings</span>' : ""}</td><td>${esc(r.operator)}</td><td style="white-space:normal;max-width:280px">${r.stops.map((s) => esc(s.name)).join(" → ")}</td><td>${r.times.join(", ")}</td><td>${r.offsets[r.offsets.length - 1] || "?"} min</td><td>${RL.Model.nByRoute[r.id] || 0}</td><td>${rel.score == null ? "–" : rel.score + " (" + rel.grade + ")"}</td><td style="white-space:normal;max-width:200px">${r.source ? (/^https?:/.test(r.source) ? `<a href="${esc(r.source)}" target="_blank" rel="noopener">link</a>` : esc(r.source)) : "–"}</td><td><button data-del="${r.id}">Delete</button></td></tr>`;
    }).join("") : `<tr><td class="muted">No routes yet. Use "Load starter routes", add one above, or try AI route discovery.</td></tr>`;
    labelTable($("#routeTable"));
    $$("[data-del]").forEach((b) => (b.onclick = async () => { if (confirm("Delete this route? Its reports stay in the database.")) { try { await post({ action: "deleteRoute", routeId: b.dataset.del }, { admin: true }); } catch (e) { alert(e.message); } } }));

    const rels = RL.ROUTES.map((r) => ({ r, ...RL.reliability(DB.reports, r.id) }));
    chart("chRel", { type: "bar", data: { labels: rels.map((x) => x.r.code), datasets: [{ label: "Reliability /100", data: rels.map((x) => x.score), backgroundColor: rels.map((x) => (x.score == null ? "#94a3b8" : x.score >= 72 ? "#16a34a" : x.score >= 55 ? "#f59e0b" : "#dc2626")) }] }, options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100 } } } });
    const sorted = rows.slice().sort((a, b) => a.trip.time.localeCompare(b.trip.time));
    chart("chDemand", { type: "bar", data: { labels: sorted.map((r) => `${r.route.code.slice(0, 16)} ${r.trip.time}`), datasets: [{ label: "Est. riders (registered)", data: sorted.map((r) => r.demand), backgroundColor: sorted.map((r) => (r.demand > r.capacity ? "#dc2626" : "#14b8a6")) }, { label: "Seats", data: sorted.map((r) => r.capacity), type: "line", borderColor: "#64748b", pointRadius: 0, borderDash: [5, 4] }] } });
    chart("chW", { type: "bar", data: { labels: RL.FEATURES.slice(1), datasets: [{ label: "Learned", data: RL.Model.w.slice(1).map((x) => +x.toFixed(2)), backgroundColor: "#0f766e" }, { label: "Prior", data: RL.Model.mu.slice(1), backgroundColor: "#cbd5e1" }] }, options: { indexAxis: "y" } });
    $("#modelInfo").textContent = RL.Model.n ? `Fitted on ${RL.Model.n} real reports at ${RL.Model.trainedAt.toLocaleTimeString()}. Learned weights move away from the grey prior as evidence grows. Rain currently multiplies the odds of a late bus by ×${Math.exp(RL.Model.w[1]).toFixed(1)}.` : "No reports yet — the model is using its prior only. Learned bars separate from the grey ones as students report.";

    if (document.activeElement !== $("#spare")) $("#spare").value = DB.config.spare;
    $("#examWeek").checked = !!DB.config.examWeek;
    const recs = RL.allocate(rows.filter((r) => r.registered), +DB.config.spare || 0);
    $("#allocBody").innerHTML = recs.length ? recs.map((r) => `<div class="rec"><b>${esc(r.action)} → ${esc(r.route.code)} ${r.trip.time}</b> <span class="pill p-bad">short ~${Math.round(r.short)} seats</span><br><span class="small muted">${r.registered} registered riders → est. ${r.demand}; ${r.capacity} seats × (1 − ${pct(r.pred.pCancel)}% cancel risk) = ${Math.round(r.effCap)} effective. Source: ${esc(r.from)}.</span></div>`).join("") : `<p class="muted">${DB.riders.length ? "✅ Capacity covers estimated demand on every trip." : "Needs registered riders — students tap “I ride this bus”."}</p>`;

    $("#tripTable").innerHTML = sorted.length ? `<tr><th>Bus</th><th>Time</th><th>Riders</th><th>Est. demand</th><th>Delay risk</th><th>Cancel risk</th><th>Reports</th><th>Status</th><th>Override</th></tr>` + sorted.map((r) => `<tr><td>${esc(r.route.code)}</td><td>${r.trip.time}</td><td>${r.registered}</td><td>${r.demand}/${r.capacity}</td><td><span class="pill p-${riskCls(r.pred.p)}">${pct(r.pred.p)}%</span></td><td>${pct(r.pred.pCancel)}%</td><td>${r.pred.evidence}</td><td><span class="pill p-${STATUS_CLS[r.status.s]}">${r.status.s}</span></td>
      <td><select data-ov="${esc(r.trip.id)}"><option value="">auto</option>${["Available", "Delayed", "Cancelled", "Full"].map((s) => `<option ${DB.overrides[r.trip.id] === s ? "selected" : ""}>${s}</option>`).join("")}</select></td></tr>`).join("") : `<tr><td class="muted">No trips yet.</td></tr>`;
    labelTable($("#tripTable"));
    $$("[data-ov]").forEach((s) => (s.onchange = async () => {
      const t = RL.T[s.dataset.ov];
      try {
        await post({ action: "override", routeId: t.routeId, time: t.time, status: s.value }, { admin: true });
        if (s.value === "Cancelled" || s.value === "Delayed") await post({ action: "alert", level: s.value === "Cancelled" ? "high" : "med", scope: t.routeId, text: `${tripLabel(t)} is ${s.value.toUpperCase()} today (transport office).` }, { admin: true });
      } catch (e) { alert(e.message); }
    }));
    keepSel($("#evRoute"), RL.ROUTES.map((r) => `<option value="${r.id}">${esc(r.code)}</option>`).join("") || `<option value="">No routes</option>`);
    $("#opList").innerHTML = DB.operators.map((o) => `<div class="alt"><div><b>${esc(o.type)} · ${esc(o.name)}</b><span class="muted small">${esc(o.area)} · ${esc(o.phone)} · ${esc(o.cost)}</span></div><button data-delop="${o.id}" class="ghost">Remove</button></div>`).join("") || '<p class="muted small">No verified operators yet.</p>';
    $$("[data-delop]").forEach((b) => (b.onclick = () => post({ action: "deleteOperator", id: b.dataset.delop }, { admin: true }).catch((e) => alert(e.message))));
  }
  async function saveRoute() {
    const msg = $("#nMsg"); msg.textContent = "Calculating road route…";
    try {
      const code = $("#nCode").value.trim();
      const times = $("#nTimes").value.split(/[,\s]+/).map((x) => x.trim().replace(".", ":")).filter(Boolean).map((x) => (x.length === 4 ? "0" + x : x));
      if (!code || newStops.length < 1 || !times.length) { msg.textContent = "Need a name, at least 1 stop and departure times (HH:MM)."; return; }
      const stops = newStops.concat([{ name: RL.COLLEGE.name, lat: RL.COLLEGE.lat, lng: RL.COLLEGE.lng }]);
      const rr = await RL.roadRoute(stops);
      await post({ action: "addRoute", route: { code, operator: $("#nOp").value, capacity: +$("#nCap").value, marketDay: $("#nMarket").value, times, stops, offsets: rr.offsets, geometry: rr.geometry, source: $("#nSrc").value, addedBy: $("#nSrc").dataset.ai ? "ai" : "admin" } }, { admin: true });
      msg.textContent = `✔ Saved (${rr.km ?? "?"} km, ${rr.offsets[rr.offsets.length - 1]} min by bus).`; newStops = []; ["#nCode", "#nTimes", "#nSrc"].forEach((s) => ($(s).value = "")); delete $("#nSrc").dataset.ai; renderAdmin();
    } catch (e) { msg.textContent = "✖ " + e.message; }
  }

  // Starter routes: real places, real coordinates (OpenStreetMap/Nominatim when reachable),
  // real road times (OSRM). Departure times are SAMPLES for the demo — marked as such.
  const STARTER = [
    { code: "Puttur – Mangaluru (sample)", operator: "KSRTC", marketDay: null, times: ["06:45", "07:25"], stops: [["Puttur", 12.7598, 75.2016], ["Kalladka", 12.8607, 75.1155], ["B C Road", 12.8797, 75.0337], ["Farangipete", 12.8733, 74.957]] },
    { code: "Vitla – Mangaluru (sample)", operator: "Private", marketDay: null, times: ["07:00", "07:40"], stops: [["Vitla", 12.765, 75.101], ["Kalladka", 12.8607, 75.1155], ["B C Road", 12.8797, 75.0337], ["Farangipete", 12.8733, 74.957]] },
    { code: "Moodbidri – Mangaluru (sample)", operator: "Private", marketDay: null, times: ["06:55", "07:35"], stops: [["Moodbidri", 13.0679, 74.9949], ["Kaikamba", 12.9533, 74.9531], ["Gurupura", 12.9365, 74.9325], ["Padil", 12.8743, 74.8936]] },
    { code: "B.C. Road – Mangaluru (sample)", operator: "City bus", marketDay: null, times: ["07:20", "07:50", "08:10"], stops: [["B C Road", 12.8797, 75.0337], ["Farangipete", 12.8733, 74.957]] },
  ];
  async function loadStarter() {
    const msg = $("#starterMsg"); const have = new Set(DB.routes.map((r) => r.code));
    const todo = STARTER.filter((s) => !have.has(s.code));
    if (!todo.length) { msg.textContent = "Starter routes are already loaded."; return; }
    try {
      for (const [i, s] of todo.entries()) {
        msg.textContent = `Adding ${i + 1}/${todo.length}: ${s.code} — routing on real roads…`;
        // 1) real OSM stop whose NAME matches the place (within 8 km of the hint), 2) nearest OSM stop within 1.5 km, 3) hint coordinates
        const stops = s.stops.map(([name, lat, lng]) => {
          const hint = { lat, lng }, key = name.toLowerCase().replace(/[^a-z]/g, "");
          const byName = STOPS.filter((x) => x.name.toLowerCase().replace(/[^a-z]/g, "").includes(key) && RL.haversine(x, hint) < 8).sort((a, b) => (b.station - a.station) || RL.haversine(a, hint) - RL.haversine(b, hint))[0];
          if (byName) return { name: byName.name, lat: byName.lat, lng: byName.lng };
          const near = STOPS.map((x) => ({ x, d: RL.haversine(x, hint) })).sort((a, b) => a.d - b.d)[0];
          return near && near.d < 1.5 ? { name: `${name} (${near.x.name})`, lat: near.x.lat, lng: near.x.lng } : { name, lat, lng };
        }).concat([{ name: RL.COLLEGE.name, lat: RL.COLLEGE.lat, lng: RL.COLLEGE.lng }]);
        const rr = await RL.roadRoute(stops);
        await post({ action: "addRoute", route: { code: s.code, operator: s.operator, capacity: 55, marketDay: s.marketDay, times: s.times, stops, offsets: rr.offsets, geometry: rr.geometry, source: "Sample timings for demo — not an official timetable. Verify with the depot before relying on them.", sample: true, addedBy: "admin" } }, { admin: true });
        await sleep(300);
      }
      msg.textContent = `✔ Loaded ${todo.length} starter route(s). Timings are samples — edit or replace them with real ones.`;
    } catch (e) { msg.textContent = "✖ " + e.message; }
  }
  async function discover() {
    const from = $("#dFrom").value.trim(); if (!from) return;
    $("#dOut").innerHTML = `<p class="muted small">Claude is searching the web for buses from ${esc(from)}… (20–60 s)</p>`;
    try {
      if (!(await aiReady())) throw new Error("no key");
      const r = await fetch("api/assistant", { method: "POST", headers: { "Content-Type": "application/json", ...RL.authHeaders() }, body: JSON.stringify({ mode: "discover", from, to: RL.COLLEGE.name + ", Mangaluru" }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status);
      const list = j.services || [];
      $("#dOut").innerHTML = list.length ? list.map((s, i) => `<div class="disc"><b>${esc(s.code)}</b> · ${esc(s.operator)}<br>${esc((s.via || []).join(" → "))}<br>Departures: ${esc((s.departures || []).join(", ") || s.frequency || "not found")}<br>Source: ${s.source ? `<a href="${esc(s.source)}" target="_blank" rel="noopener">${esc(s.source)}</a>` : "–"}<br><button data-use="${i}">Review & add</button></div>`).join("") : `<p class="muted small">No reliable sources found for ${esc(from)}. Add the route manually.</p>`;
      $$("[data-use]").forEach((b) => (b.onclick = async () => {
        const s = list[+b.dataset.use]; b.textContent = "Matching stops…";
        $("#nCode").value = s.code || ""; $("#nOp").value = /ksrtc/i.test(s.operator) ? "KSRTC" : /city/i.test(s.operator) ? "City bus" : "Private";
        $("#nTimes").value = (s.departures || []).join(", "); $("#nSrc").value = s.source || ""; $("#nSrc").dataset.ai = "1";
        newStops = [];
        for (const name of (s.via || []).slice(0, -1)) { const st = await resolveOrGeocode(name); if (st) newStops.push({ name: st.name, lat: st.lat, lng: st.lng }); await sleep(1100); }
        b.textContent = "Loaded into the form ↖ check & save"; renderAdmin();
      }));
    } catch (e) { $("#dOut").innerHTML = `<div class="note">AI route discovery needs ANTHROPIC_API_KEY on the server (${esc(e.message)}).</div>`; }
  }

  // ---------- AI assistant ----------
  function aiContext() {
    const p = P.profile.stop;
    return {
      now: new Date().toString(), weather: weather.ok ? { rainProbability6to9am: weather.prob, precipMm: weather.mm, tempC: weather.temp } : "unavailable",
      student: { name: P.profile.name || "student", stop: p?.name || "not set", mustReachBy: P.profile.arrive, usualBus: tripLabel(RL.T[P.profile.tripId]) },
      googleMapsTransitLink: p ? gmaps(p) : null,
      busesFromMyStop: rankOptions(p).map((o) => ({ bus: o.row.route.code, operator: o.row.route.operator, timingsAreSamples: !!o.row.route.sample, departsMyStop: RL.fmt(o.dep), arrivesCollege: RL.fmt(o.arr), delayOrCancelRiskPct: pct(o.row.pred.p), basedOnReports: o.row.pred.evidence, reasons: RL.reasonText(o.row.pred), status: o.row.status.s, statusSource: o.row.status.src, registeredRiders: o.row.registered, seats: o.row.capacity })),
      routeReliability: RL.ROUTES.map((r) => ({ bus: r.code, ...RL.reliability(DB.reports, r.id) })),
      verifiedOperators: DB.operators.map(({ id, ...o }) => o), activeAlerts: (DB.alerts || []).slice(0, 5).map((a) => a.text),
    };
  }
  function localAnswer(q) {
    q = q.toLowerCase(); const p = P.profile.stop; const o = rankOptions(p); const my = ROWS[P.profile.tripId];
    if (!p) return "Set your bus stop in Route Finder first.";
    if (!o.length) return `No registered bus passes ${p.name} yet. Open Google Maps transit for all known buses: ${gmaps(p)}`;
    if (/reliab|worst|least|score/.test(q)) {
      const r = RL.ROUTES.map((x) => ({ x, ...RL.reliability(DB.reports, x.id) })).filter((x) => x.score != null).sort((a, b) => a.score - b.score);
      return r.length ? "Route reliability (last 30 days, real reports):\n" + r.map((x) => `• ${x.x.code}: ${x.score}/100 (${x.grade}) from ${x.reports} reports`).join("\n") : "No reports yet, so no reliability scores.";
    }
    if (/doesn|not come|didn|alternat|backup|miss|cancel/.test(q)) return `If your bus doesn't come:\n1. Next registered bus: ${o.filter((x) => x.t.id !== P.profile.tripId).slice(0, 2).map((x) => `${x.row.route.code} at ${RL.fmt(x.dep)} (${pct(x.row.pred.p)}% risk)`).join(", ") || "none"}\n2. Verified operators: ${DB.operators.map((x) => `${x.type} ${x.name} ${x.phone}`).join("; ") || "none added yet"}\n3. All buses on Google Maps: ${gmaps(p)}\n4. Tap "Didn't come" in Report so others are warned.`;
    if (/why|risk|late|chance/.test(q) && my) return `${pct(my.pred.p)}% chance your ${my.route.code} is late or cancelled — ${RL.reasonText(my.pred)}. Based on ${my.pred.evidence} real reports.`;
    return `Best bus: ${o[0].row.route.code} at ${RL.fmt(o[0].dep)} from ${p.name}, reaching college ${RL.fmt(o[0].arr)} — ${pct(o[0].row.pred.p)}% risk (${RL.reasonText(o[0].row.pred)}).`;
  }
  let aiAvailable = null; // checked once, so a server without a key never produces failing requests
  async function aiReady() {
    if (!ME) return false; // guests: on-device answers only
    if (aiAvailable === null) { try { aiAvailable = !!(await (await fetch("api/assistant", { cache: "no-store" })).json()).available; } catch { aiAvailable = false; } }
    return aiAvailable;
  }
  async function callAI(mode, payload) {
    if (!(await aiReady())) throw new Error(ME ? "Cloud AI not configured (no ANTHROPIC_API_KEY on the server)" : "Log in to use Claude");
    const res = await fetch("api/assistant", { method: "POST", headers: { "Content-Type": "application/json", ...RL.authHeaders() }, body: JSON.stringify({ mode, ...payload }) });
    const j = await res.json().catch(() => ({})); if (!res.ok || !j.answer) throw new Error(j.error || "ai " + res.status); return j;
  }
  function addMsg(cls, text, src) {
    const d = document.createElement("div"); d.className = "msg " + cls; d.textContent = text;
    if (src) { const s = document.createElement("span"); s.className = "src"; s.textContent = src; d.appendChild(s); }
    $("#chat").appendChild(d); $("#chat").scrollTop = 1e9; return d;
  }
  async function ask(q) {
    if (!q.trim()) return; addMsg("u", q); const pending = addMsg("a", "Thinking…");
    try { const j = await callAI("chat", { question: q, context: aiContext() }); pending.remove(); addMsg("a", j.answer, "Claude · " + (j.model || "Anthropic API")); }
    catch { pending.remove(); addMsg("a", localAnswer(q), ME ? "On-device assistant (cloud AI unavailable)" : "On-device assistant · log in to ask Claude"); }
  }
  function evidenceStats(rid) {
    const r = RL.R[rid]; const rep = DB.reports.filter((x) => x.routeId === rid);
    const rainy = rep.filter((x) => x.rain >= 0.5 && x.outcome !== "full"), dry = rep.filter((x) => x.rain < 0.5 && x.outcome !== "full");
    const bad = (a) => (a.length ? Math.round((100 * a.filter((x) => x.outcome !== "ontime").length) / a.length) : null);
    return { route: r.code, operator: r.operator, stops: r.stops.map((s) => s.name), departures: r.times, seatsPerTrip: r.capacity, registeredRiders: DB.riders.filter((x) => x.routeId === rid).length,
      reliability30d: RL.reliability(DB.reports, rid, 30), reliability120d: RL.reliability(DB.reports, rid, 120), tooFullReports: rep.filter((x) => x.outcome === "full").length,
      daysWithReports: new Set(rep.map((x) => x.date)).size, rainyDayProblemPct: bad(rainy), dryDayProblemPct: bad(dry), rainyReports: rainy.length, dryReports: dry.length };
  }
  function letterTemplate(e) {
    const r = e.reliability120d;
    return `To,\nThe Depot Manager, KSRTC Mangaluru Division\n\nSubject: Request for additional bus service on ${e.route}\n\nRespected Sir/Madam,\n\nStudents of ${RL.COLLEGE.name} have been recording, through the RouteLess app, whether the ${e.route} bus (${e.stops.join(" – ")}) arrives on time.\n\n• ${r.reports} student reports over ${e.daysWithReports} day(s): ${r.onTime} on time, ${r.late} late, ${r.cancelled} did not arrive (reliability ${r.score ?? "–"}/100).\n• ${e.tooFullReports} reports of the bus being too full to board; ${e.registeredRiders} students registered on this route.\n${e.rainyDayProblemPct != null ? `• On rainy mornings ${e.rainyDayProblemPct}% of trips were late or missed (${e.rainyReports} reports), versus ${e.dryDayProblemPct ?? "–"}% on dry mornings.\n` : ""}\nWe request (1) an additional or standby morning trip, (2) priority deployment on rainy and market days, and (3) prior notice to the college when a trip is cancelled.\n\nYours faithfully,\nStudent Transport Committee, ${RL.COLLEGE.name}`;
  }

  // ---------- weather ----------
  async function loadWeather() {
    weather = await RL.fetchWeather(P.profile.stop || undefined);
    $("#weatherChip").textContent = weather.ok ? `${weather.prob >= 50 ? "🌧️" : weather.prob >= 20 ? "🌦️" : "☀️"} ${weather.prob}% rain 6–9am · ${Math.round(weather.temp)}°C` : "☁️ weather offline";
    compute(); renderAll();
  }

  // ---------- EXAM DAY CRISIS (Surprise Hurdle) ----------
  let CD = null, cdDirty = false, lastExplain = "";
  const clone = (o) => JSON.parse(JSON.stringify(o || {}));
  // admin's working copy of the crisis; follows the server until the admin edits something
  function draft() {
    if (!CD || !cdDirty) CD = Object.assign({ active: false, simulated: false, broken: [], surgePct: 40, autos: 10, spare: 0, blocked: null, detours: {} }, clone(DB.crisis));
    CD.broken = (CD.broken || []).filter((id) => RL.T[id]);
    return CD;
  }
  const segKey = (b) => (b && b.a && b.b ? [b.a.name, b.b.name].sort().join("⇄") : "");
  const tripName = (id) => (RL.T[id] ? tripLabel(RL.T[id]) : id);

  function renderCrisisAdmin() {
    if (!document.body.classList.contains("admin") || !$("#tab-admin").classList.contains("on")) return;
    const c = draft();
    $("#crisisState").textContent = crisisOn() ? (DB.crisis.simulated ? "ACTIVE · simulated" : "ACTIVE") : midwayList().length ? "bus broke down on the way" : "off";
    $("#crisisState").className = "pill " + (planOn() ? "p-bad" : "p-info");
    // live results right under the buttons (on phones the full plan is far below the settings)
    $("#crisisSummary").innerHTML = planOn() && PLAN ? `<div class="metrics compact">
      <div class="metric"><span>📝 Would miss their exam</span><b><span class="${PLAN.before.examMiss ? "bad" : "good"}">${PLAN.before.examMiss}</span><span class="arrow">→</span><span class="${PLAN.after.examMiss ? "bad" : "good"}">${PLAN.after.examMiss}</span></b></div>
      <div class="metric"><span>🚶 Without transport</span><b><span class="${PLAN.before.stranded ? "bad" : "good"}">${PLAN.before.stranded}</span><span class="arrow">→</span><span class="${PLAN.after.stranded ? "bad" : "good"}">${PLAN.after.stranded}</span></b></div>
    </div><p class="small"><b>${PLAN.decidedBy === "claude" ? "🤖" : "⚙️"} ${decidedBy()}</b> · <a href="#crisisPlan">full plan ↓</a></p>` : "";
    $("#cBroken").innerHTML = RL.TRIPS.length ? RL.TRIPS.map((t) => `<label><input type="checkbox" data-brk="${esc(t.id)}" ${c.broken.includes(t.id) ? "checked" : ""}/> ${esc(tripLabel(t))} <span class="muted small">${esc(RL.R[t.routeId].operator)}</span></label>`).join("") : '<p class="muted small">No routes yet. "Simulate exam day crisis" loads the starter routes first.</p>';
    $$("[data-brk]").forEach((x) => (x.onchange = () => { cdDirty = true; const id = x.dataset.brk; c.broken = x.checked ? [...new Set([...c.broken, id])] : c.broken.filter((b) => b !== id); renderCrisisPlan(); }));
    [["#cSurge", "surgePct"], ["#cSpare", "spare"], ["#cAutos", "autos"]].forEach(([id, f]) => { if (document.activeElement !== $(id)) $(id).value = c[f] ?? 0; });
    keepSel($("#cBlock"), `<option value="">— no road blocked —</option>` + RL.Crisis.segments().map((s) => `<option value="${esc(s.key)}">${esc(s.label)} (${s.routes.length} route${s.routes.length > 1 ? "s" : ""})</option>`).join(""));
    if (!cdDirty) $("#cBlock").value = segKey(c.blocked);
    renderMidwayAdmin(); renderDetourInfo(); renderCrisisPlan();
  }

  // ---------- v8: buses that break down ON THE WAY ----------
  const segOptions = (tripId) => { const r = RL.R[RL.T[tripId].routeId]; return r.stops.slice(0, -1).map((s, k) => `<option value="${k}">between ${esc(s.name)} and ${esc(r.stops[k + 1].name)}</option>`).join(""); };
  async function withStand(m) { // nearest real auto/taxi stand to the breakdown spot (OpenStreetMap)
    try { const st = (await RL.loadTaxiStands(m, 6)).find((x) => x.type !== "Bus station"); if (st) return { ...m, standName: st.name, standKm: +st.km.toFixed(1) }; } catch {}
    return { ...m, standName: "", standKm: null };
  }
  async function saveMidway(list) {
    // publish immediately (works with or without Exam Day Crisis); an older Claude decision is stale now
    await post({ action: "crisis", op: "set", crisis: { ...clone(DB.crisis), midway: list, decision: "greedy", claude: null, decisionNote: list.length ? "Re-planned by the on-device optimiser after a breakdown on the way." : "" } }, { admin: true });
    if (CD) CD.midway = clone(list);
  }
  async function midwayAlert(m) {
    const t = RL.T[m.tripId]; if (!t) return;
    try { await RL.api.post({ action: "alert", crisis: true, level: "high", scope: t.routeId, text: `🛠 ${tripLabel(t)} broke down ON THE WAY ${m.place} at ${RL.fmt(m.at)}${DB.crisis.simulated ? " (SIMULATED)" : ""}. Students on board: stay together at the bus — your rescue plan is in RouteLess. Students at later stops: check your new plan.` }); } catch {}
  }
  function renderMidwayAdmin() {
    const box = $("#cMidway"); if (!box) return;
    const list = midwayList().filter((m) => RL.T[m.tripId]);
    const reports = (DB.breakdownReports || []).filter((r) => RL.T[r.tripId] && !list.some((m) => m.tripId === r.tripId));
    const byTrip = {}; reports.forEach((r) => (byTrip[r.tripId] = byTrip[r.tripId] || []).push(r));
    box.innerHTML = (list.map((m, i) => {
      const s = PLAN && PLAN.trips[m.tripId], onb = PLAN ? PLAN.stranded.filter((p) => p.tripId === m.tripId) : [];
      return `<div class="alt"><div><b>🛠 ${esc(tripName(m.tripId))}</b> broke down ${esc(m.place)} at ${RL.fmt(m.at)}<br><span class="muted small">${esc(m.source || "transport cell")} · ${onb.length} stranded on board · ${s && s.replacedBy ? `rescue: ${esc(s.replacedBy.replace("rescue: ", "").split(" (")[0])}, ${PLAN.repDelay[m.tripId]} min late` : "no rescue bus free; riders re-seated / autos"}${m.standName ? ` · nearest auto stand: ${esc(m.standName)} (${m.standKm} km)` : ""}</span></div><button class="ghost" data-mwdel="${i}">Remove</button></div>`;
    }).join("") || '<p class="muted small">No breakdowns on the way. Students report them from the Report tab; 2 reports confirm one automatically.</p>')
      + Object.entries(byTrip).map(([tid, rs]) => `<div class="alt"><div><b>⚠️ ${esc(tripName(tid))}</b>: ${rs.length} student report(s) ${esc(rs[0].place)} at ${RL.fmt(rs[0].at)}<br><span class="muted small">unconfirmed: needs 2 phones, or confirm it yourself</span></div><button data-mwok="${esc(tid)}">Confirm</button></div>`).join("");
    $$("[data-mwdel]").forEach((b) => (b.onclick = async () => { const l = clone(midwayList()); l.splice(+b.dataset.mwdel, 1); try { await saveMidway(l); } catch (e) { alert(e.message); } }));
    $$("[data-mwok]").forEach((b) => (b.onclick = async () => {
      const rs = byTrip[b.dataset.mwok]; const m = await withStand({ ...rs[0], tripId: b.dataset.mwok, source: `confirmed by transport cell (${rs.length} report)` });
      try { await saveMidway([...clone(midwayList()), m]); await midwayAlert(m); } catch (e) { alert(e.message); }
    }));
    keepSel($("#mwTrip"), RL.TRIPS.map((t) => `<option value="${esc(t.id)}">${esc(tripLabel(t))}</option>`).join("") || `<option value="">No routes</option>`);
    if ($("#mwTrip").value && $("#mwSeg").dataset.trip !== $("#mwTrip").value) { $("#mwSeg").innerHTML = segOptions($("#mwTrip").value); $("#mwSeg").dataset.trip = $("#mwTrip").value; $("#mwTime").value = RL.fmt(RL.Crisis.midwayAt($("#mwTrip").value, 0).at).padStart(5, "0"); }
  }
  // breakdown time: "now" if the bus is running right now, else when it was scheduled to be at that spot
  const nowOrScheduled = (tid, sched) => { const t = RL.T[tid], now = RL.istNowMin(); return now >= RL.toMin(t.time) - 5 && now <= arrAt(t) + 60 ? now : sched; };
  // student on the bus: "it broke down on the way" (GPS first, "between which stops" as fallback)
  async function reportBreakdown(segK) {
    const tid = $("#rTrip").value, t = RL.T[tid]; if (!t) return;
    let m = null;
    if (segK == null) {
      $("#reportMsg").innerHTML = '<div class="toast">📍 Getting your location…</div>';
      const pos = await new Promise((res) => { if (!navigator.geolocation) return res(null); navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { timeout: 8000, maximumAge: 60000 }); });
      if (pos) { const loc = RL.Crisis.locateOnRoute(tid, pos); if (loc.offRouteKm <= 5) m = { lat: +pos.lat.toFixed(5), lng: +pos.lng.toFixed(5), place: loc.place, after: loc.after, at: nowOrScheduled(tid, RL.Crisis.midwayAt(tid, loc.after).at) }; }
      if (!m) {
        $("#bdSeg").innerHTML = segOptions(tid); $("#bdForm").classList.remove("hidden");
        $("#reportMsg").innerHTML = `<div class="note">${pos ? "Your location is more than 5 km from this bus route" : "Location is not available"}, so pick where it broke down.</div>`; return;
      }
    } else { m = RL.Crisis.midwayAt(tid, segK); m.at = nowOrScheduled(tid, m.at); delete m.tripId; }
    try { await post({ action: "breakdown", routeId: t.routeId, time: t.time, clientId: P.clientId, name: P.profile.name, ...m }); }
    catch (e) { $("#reportMsg").innerHTML = `<div class="note">Could not send (${esc(e.message)}). Try again, or call the transport cell.</div>`; return; }
    $("#bdForm").classList.add("hidden");
    const confirmed = midwayList().some((x) => x.tripId === tid);
    $("#reportMsg").innerHTML = `<div class="toast">🛠 Breakdown reported ${esc(m.place)} at ${RL.fmt(m.at)}. ${confirmed ? "Confirmed: everyone on this bus now has a rescue plan (red banner at the top)." : "It is confirmed as soon as one more student on the bus reports it, or the transport cell confirms it. Stay together at the bus."}</div>`;
  }
  async function addMidway() {
    const tid = $("#mwTrip").value; if (!RL.T[tid]) return;
    let m = RL.Crisis.midwayAt(tid, +$("#mwSeg").value || 0);
    if ($("#mwTime").value) m.at = RL.toMin($("#mwTime").value);
    m = await withStand({ ...m, source: "transport cell" });
    try { await saveMidway([...clone(midwayList()).filter((x) => x.tripId !== tid), m]); await midwayAlert(m); } catch (e) { alert(e.message); }
  }
  function renderDetourInfo() {
    const c = draft(); if (!c.blocked) { $("#cDetour").innerHTML = ""; return; }
    const ids = RL.Crisis.blockedRoutes(c);
    $("#cDetour").innerHTML = `🌊 Flooded: <b>${esc(c.blocked.a.name)} ↔ ${esc(c.blocked.b.name)}</b>. Routes on this road: ${ids.map((id) => esc(RL.R[id].code)).join(", ") || "none"}.<br>` +
      ids.map((id) => { const d = c.detours?.[id]; return !d ? `… ${esc(RL.R[id].code)}: press "Find detour"` : d.found ? `✔ ${esc(RL.R[id].code)}: detour found (${esc(d.via)}) <b>+${d.extraMin} min</b>, +${d.extraKm} km` : `✖ ${esc(RL.R[id].code)}: no detour; its students go to the nearest other route or a shared auto`; }).join("<br>");
  }
  async function findDetour() {
    const c = draft(); if (!c.blocked) return;
    $("#cDetour").innerHTML = "Asking OSRM for roads around the flood…";
    const ids = RL.Crisis.blockedRoutes(c); c.detours = {}; cdDirty = true;
    try {
      const d = await RL.Crisis.findDetour(c.blocked.a, c.blocked.b); c.blocked.spot = d.spot;
      ids.forEach((id) => (c.detours[id] = { found: d.found, extraMin: d.extraMin, extraKm: d.extraKm, via: d.via, geometry: d.geometry || [] }));
    } catch { ids.forEach((id) => (c.detours[id] = { found: false, extraMin: 0, extraKm: 0, via: "" })); }
    renderDetourInfo(); renderCrisisPlan();
  }
  function renderCrisisPlan() {
    const el = $("#crisisPlan"); const c = draft();
    if (!RL.TRIPS.length) { el.innerHTML = ""; return; }
    const live = planOn() && !cdDirty;
    let pl; try { pl = live && PLAN ? PLAN : RL.Crisis.run({ riders: DB.riders, crisis: c }); } catch (e) { console.error("crisis preview", e); el.innerHTML = '<div class="note">The plan could not be computed.</div>'; return; }
    window.__lastPlan = pl;
    const b = pl.before, a = pl.after;
    if (!b.total) { el.innerHTML = '<div class="empty">No riders registered yet. Students tap "I ride this bus", or press "Simulate exam day crisis" to add 120 simulated students.</div>'; return; }
    const m = (x, y, lbl) => `<div class="metric"><span>${lbl}</span><b><span class="${x ? "bad" : "good"}">${x}</span><span class="arrow">→</span><span class="${y ? "bad" : "good"}">${y}</span></b><span>without plan → with plan</span></div>`;
    const sim = DB.riders.filter((r) => r.sim).length;
    const ex = pl.examStudents.slice(0, 12).map((p) => {
      const r = pl.results[p.id];
      const where = r.mode === "none" ? "no seat found" : r.mode === "auto" ? `shared auto ${r.pod}` : `${tripName(r.tid)}${r.mode === "nearby" ? ` from ${r.stopName}` : ""}`;
      return `<tr><td>${esc(p.name)}${p.sim ? ' <span class="sim-tag">sim</span>' : ""}</td><td>${p.examTime}</td><td>${esc(where)}</td><td>${r.arrival ? RL.fmt(r.arrival) : "–"}</td><td>${r.onTime ? "✅" : "⚠️"}</td></tr>`;
    }).join("");
    el.innerHTML = `<h4>Crisis plan ${live ? `· LIVE (every student sees it) · <span class="pill ${pl.decidedBy === "claude" ? "p-full" : "p-info"}">${pl.decidedBy === "claude" ? "🤖 Decided by Claude" : "⚙️ Decided by on-device optimiser"}</span>` : "· preview (press Activate to publish)"}</h4>
      <p class="small muted">${b.total} students: ${b.total - pl.surgeAdded - sim} registered${sim ? `, <span class="sim-tag">${sim} simulated</span>` : ""}, +${pl.surgeAdded} from the ${c.surgePct}% surge. ${b.exam} have an exam today.</p>
      <div class="metrics">${m(b.examMiss, a.examMiss, "📝 Students who would miss their exam")}${m(b.stranded, a.stranded, "🚶 Students left without transport")}</div>
      ${live ? compareHtml() : ""}
      <ul class="planlist small">
        ${pl.replacements.map((r) => `<li>🔧 <b>${esc(r.label)}</b> broke down → ${esc(r.from)} (+15 min)</li>`).join("")}
        ${c.broken.filter((id) => !pl.replacements.some((r) => r.trip === id)).map((id) => `<li>❌ <b>${esc(tripName(id))}</b> broke down, no bus left to replace it; its riders are re-seated</li>`).join("")}
        ${pl.blockedRoutes.map((id) => { const d = c.detours?.[id]; return `<li>🌊 <b>${esc(RL.R[id].code)}</b> ${d && d.found ? `takes the detour, +${d.extraMin} min` : "cannot pass the flooded road; its riders are moved"}</li>`; }).join("")}
        <li>🔁 ${a.moved} students moved to another bus at their stop, ${a.nearby} to a bus at a nearby stop (≤4 km)</li>
        <li>🛺 ${pl.autosUsed} shared-auto pod(s) of up to 4 used (${a.auto} students), out of ${c.autos} autos available</li>
        <li>📝 Exam students seated first, earliest exam first${a.examMiss ? `; ${a.examMiss} still at risk (no seat reaches college in time)` : ", and all reach college in time"}</li>
        ${a.late ? `<li>⏱ ${a.late} students without exams are transported but arrive later</li>` : ""}
      </ul>
      <div class="tablewrap"><table id="crisisTable"><tr><th>Bus</th><th>Status</th><th>Seats</th><th>Seated before</th><th>Seated after</th><th>Reaches college</th></tr>
      ${Object.values(pl.trips).sort((x, y) => x.trip.time.localeCompare(y.trip.time)).map((s) => `<tr><td>${esc(tripLabel(s.trip))}</td><td>${s.broken ? (s.replacedBy ? "🔧 replaced" : "❌ broken down") : s.donatedTo ? "↪ bus moved" : s.blocked ? (s.detour ? `🌊 detour +${s.detour} min` : "🌊 blocked") : "✅ running"}</td><td>${s.cap}</td><td>${s.before}</td><td>${s.after}</td><td>${s.cap ? RL.fmt(RL.toMin(s.trip.time) + (RL.R[s.trip.routeId].offsets.slice(-1)[0] || 0) + s.delay) : "–"}</td></tr>`).join("")}</table></div>
      ${ex ? `<h4>Exam students in priority order (first 12 of ${pl.examStudents.length})</h4><div class="tablewrap"><table id="examTable"><tr><th>Student</th><th>Exam</th><th>Plan</th><th>Reaches</th><th>In time</th></tr>${ex}</table></div>` : ""}
      <div class="row gap"><button id="explainBtn">🤖 Explain this plan</button></div><div id="explainOut" class="letter"></div>`;
    labelTable($("#crisisTable")); if ($("#examTable")) labelTable($("#examTable"));
    $("#explainOut").textContent = lastExplain;
    $("#explainBtn").onclick = explainPlan;
    if ($("#askClaudeBtn")) $("#askClaudeBtn").onclick = async () => { $("#askClaudeBtn").disabled = true; await decideWithClaude(); };
  }
  // v6: greedy vs Claude, side by side; the chosen one is marked
  function compareHtml() {
    const c = DB.crisis, meta = c.claudeMeta, chosen = PLAN && PLAN.decidedBy === "claude" ? "claude" : "greedy";
    const nums = (pl) => pl ? `<div class="cmpnum">📝 Missing their exam: <b>${pl.before.examMiss} → ${pl.after.examMiss}</b></div><div class="cmpnum">🚶 Without transport: <b>${pl.before.stranded} → ${pl.after.stranded}</b></div>
      <div class="small muted">Bus moves: ${pl.replacements.map((r) => `${esc(r.label)} ← ${esc(r.from.split(" (")[0])}`).join("; ") || "none"} · ${pl.autosUsed} shared-auto pod(s)</div>` : "";
    let claudeBody;
    if (!meta) claudeBody = `<p class="small muted">${claudeBusy ? "🤖 Claude is deciding…" : aiAvailable === false ? "No ANTHROPIC_API_KEY on the server, so Claude was not asked." : "Not asked yet."}</p>`;
    else if (!meta.ok) claudeBody = `<p class="small"><b>✖ Claude's plan failed the safety check</b>, so it was not used:</p><ul class="small">${meta.errors.slice(0, 5).map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
    else claudeBody = nums(CLAUDE) + (meta.reasons.length ? `<p class="small"><b>Claude's reasons</b></p><ul class="small">${meta.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "") + `<p class="small muted">✔ Passed the server safety check (seats, broken buses, exam students)${meta.structured ? " · structured JSON output" : ""}.</p>`;
    return `<div class="decision">${chosen === "claude" ? "🤖" : "⚙️"} <b>${chosen === "claude" ? "Decided by Claude" : "Decided by on-device optimiser"}</b>${c.decisionNote ? ": " + esc(c.decisionNote) : ""}</div>
      <div class="cmpgrid">
        <div class="cmp ${chosen === "greedy" ? "chosen" : ""}"><h4>⚙️ On-device optimiser (greedy) ${chosen === "greedy" ? '<span class="pill p-ok">used</span>' : ""}</h4>${nums(GREEDY)}</div>
        <div class="cmp ${chosen === "claude" ? "chosen" : ""}"><h4>🤖 Claude${meta?.model ? ` (${esc(meta.model)})` : ""} ${chosen === "claude" ? '<span class="pill p-ok">used</span>' : ""}</h4>${claudeBody}</div>
      </div>
      <div class="row gap"><button id="askClaudeBtn" ${claudeBusy ? "disabled" : ""}>🤖 ${meta ? "Ask Claude to decide again" : "Ask Claude to decide"}</button></div>`;
  }
  let claudeBusy = false;
  async function decideWithClaude() {
    if (!planOn() || !RL.TRIPS.length || claudeBusy) return;
    const input = planInput();
    const greedy = RL.Crisis.run(input);
    const save = (patch) => post({ action: "crisis", op: "set", crisis: { ...clone(DB.crisis), ...patch } }, { admin: true });
    if (!(await aiReady())) { await save({ decision: "greedy", decisionNote: "No ANTHROPIC_API_KEY on the server, so the on-device optimiser decided.", claude: null, claudeMeta: null }); return; }
    claudeBusy = true; $("#cMsg").textContent = "🤖 Claude is deciding the crisis plan (this can take 30–90 s)…"; renderCrisisPlan();
    try {
      const { ctx, toReal } = RL.Crisis.claudeContext(input, greedy);
      let j;
      try {
        // server gives Claude 50 s; the browser waits at most 58 s (Vercel stops functions at 60 s)
        const r = await fetch("api/assistant", { method: "POST", headers: { "Content-Type": "application/json", ...RL.authHeaders() }, body: JSON.stringify({ mode: "crisis", context: ctx }), signal: AbortSignal.timeout(58000) });
        j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      } catch (e) {
        if (e.name === "TimeoutError" || e.name === "AbortError" || /HTTP 504/.test(e.message)) {
          await save({ decision: "greedy", decisionNote: "Claude did not answer in time, so the on-device optimiser decided.", claude: null, claudeMeta: { ok: false, errors: ["Claude did not answer within the time limit"], reasons: [], model: "" } });
          $("#cMsg").textContent = "Claude timed out: using the on-device plan."; return;
        }
        await save({ decision: "greedy", decisionNote: `Claude API error: ${String(e.message).slice(0, 200)} So the on-device optimiser decided.`, claude: null, claudeMeta: { ok: false, errors: ["Claude API error: " + String(e.message).slice(0, 200)], reasons: [], model: "" } });
        $("#cMsg").textContent = "Claude unavailable: using the on-device plan."; return;
      }
      const meta = { model: j.model || "", ok: !!j.ok, errors: j.check?.errors || [], reasons: j.reasons || [], structured: !!j.structured, at: Date.now() };
      if (j.timeout) {
        await save({ decision: "greedy", decisionNote: `${meta.errors[0] || "Claude did not answer in time"}, so the on-device optimiser decided.`, claude: null, claudeMeta: meta });
        $("#cMsg").textContent = "Claude timed out: using the on-device plan."; return;
      }
      if (!j.ok) {
        await save({ decision: "greedy", decisionNote: `Claude's plan failed the safety check (${meta.errors[0] || "invalid reply"}), so the on-device optimiser decided.`, claude: null, claudeMeta: meta });
        $("#cMsg").textContent = "Claude's plan was rejected by the safety check: using the on-device plan."; return;
      }
      const cp = toReal(j.plan); const cl = RL.Crisis.applyClaude(input, greedy, cp);
      const g = greedy.after, a = cl.after; meta.examMiss = a.examMiss; meta.stranded = a.stranded;
      const claudeWins = a.examMiss < g.examMiss || (a.examMiss === g.examMiss && a.stranded <= g.stranded);
      await save({ decision: claudeWins ? "claude" : "greedy", claude: cp, claudeMeta: meta,
        decisionNote: claudeWins
          ? (a.examMiss < g.examMiss ? `Claude's plan leaves fewer students missing their exam (${a.examMiss} vs ${g.examMiss}).` : `Both plans leave ${a.examMiss} student(s) missing their exam; Claude's leaves ${a.stranded} without transport vs ${g.stranded}, so Claude's plan is used.`)
          : `The on-device plan does better (missing exam ${g.examMiss} vs ${a.examMiss}, without transport ${g.stranded} vs ${a.stranded}), so it is used.` });
      $("#cMsg").textContent = claudeWins ? "✔ Claude's plan is live." : "✔ Compared: the on-device plan is better and stays live.";
    } finally { claudeBusy = false; renderCrisisPlan(); }
  }
  async function applyCrisis() {
    // a changed situation invalidates Claude's old decision: publish the on-device plan first, then ask Claude
    // keep breakdowns students confirmed meanwhile (union by trip; the admin's own entries win)
    const mwMerged = Object.values(Object.fromEntries([...midwayList(), ...(draft().midway || [])].map((m) => [m.tripId, m])));
    const c = Object.assign(draft(), { active: true, decision: "greedy", decisionNote: "", claude: null, claudeMeta: null, midway: mwMerged });
    $("#cMsg").textContent = "Publishing the plan…";
    try {
      await post({ action: "crisis", op: "set", crisis: c }, { admin: true });
      cdDirty = false; await crisisAlerts();
      $("#cMsg").textContent = "✔ Crisis plan is live: every student sees their personal plan.";
      await decideWithClaude();
    } catch (e) { $("#cMsg").textContent = "✖ " + e.message; }
  }
  async function crisisAlerts() {
    if (!PLAN) return; const c = DB.crisis; const sim = c.simulated ? " (SIMULATED DRILL)" : "";
    const msgs = [{ level: "high", scope: "all", text: `🚨 Exam Day Crisis${sim}: buses have been re-planned. Open RouteLess for your personal plan. Students with exams are seated first.` }];
    c.broken.forEach((id) => { const t = RL.T[id]; if (!t) return; const rep = PLAN.replacements.find((r) => r.trip === id);
      msgs.push({ level: "high", scope: t.routeId, text: `${tripLabel(t)} has BROKEN DOWN${sim}. ${rep ? `A ${rep.from.split(" (")[0]} replaces it (+15 min).` : "Riders are moved to other buses or shared autos."} Check your plan.` }); });
    PLAN.blockedRoutes.forEach((id) => { const d = c.detours?.[id];
      msgs.push({ level: "high", scope: id, text: `Road flooded between ${c.blocked.a.name} and ${c.blocked.b.name}${sim}. ${RL.R[id].code}: ${d && d.found ? `detour adds about ${d.extraMin} min` : "cannot pass; you are re-routed"}. Check your plan.` }); });
    for (const m of msgs) { try { await RL.api.post({ action: "alert", crisis: true, ...m }); } catch {} }
    await refresh();
  }
  async function simulateCrisis() {
    const msg = $("#simMsg"); $("#simBtn").disabled = true;
    try {
      if (!DB.routes.length) {
        msg.textContent = "Loading the starter routes first…";
        if (!STOPS.length) await stopsReady; // reuse the stop list the app is already loading (no 2nd Overpass call)
        await loadStarter();
      }
      if (!RL.TRIPS.length) throw new Error("No routes available");
      const ksrtc = RL.TRIPS.filter((t) => /ksrtc/i.test(RL.R[t.routeId].operator));
      const broken = [...ksrtc, ...RL.TRIPS.filter((t) => !ksrtc.includes(t))].slice(0, 2).map((t) => t.id);
      msg.textContent = "Adding 120 simulated students (40% with exams)…";
      await post({ action: "crisis", op: "simulate", simRiders: RL.Crisis.simRiders(broken, 120) }, { admin: true });
      const segs = RL.Crisis.segments();
      const seg = segs.find((s) => /b ?c road|bantwal/i.test(s.label) && /farang/i.test(s.label)) || segs[0];
      cdDirty = false; CD = Object.assign(draft(), { broken, surgePct: 40, autos: 10, spare: 1, simulated: true, blocked: seg ? { a: seg.a, b: seg.b } : null, detours: {} }); cdDirty = true;
      if (seg) { msg.textContent = "Flooding a road and asking OSRM for a detour…"; await findDetour(); }
      // v8: one more bus breaks down ON THE WAY: the busiest trip that is still running, between its 2nd and 3rd stop
      const blockedNow = new Set(RL.Crisis.blockedRoutes(CD));
      const count = (id) => DB.riders.filter((r) => `${r.routeId}|${r.time}` === id).length;
      const cand = RL.TRIPS.filter((t) => !broken.includes(t.id) && !blockedNow.has(t.routeId) && RL.R[t.routeId].stops.length >= 3).sort((a, b) => count(b.id) - count(a.id))[0]
        || RL.TRIPS.filter((t) => !broken.includes(t.id)).sort((a, b) => count(b.id) - count(a.id))[0];
      let mwSim = null;
      if (cand) {
        msg.textContent = "Breaking one bus down on the way and finding the nearest auto stand…";
        const r = RL.R[cand.routeId]; mwSim = await withStand({ ...RL.Crisis.midwayAt(cand.id, r.stops.length >= 4 ? 1 : 0), source: "simulated" });
        CD.midway = [mwSim];
      }
      msg.textContent = "Publishing the crisis plan…";
      await applyCrisis();
      if (mwSim) await midwayAlert(mwSim);
      msg.textContent = "✔ Simulated crisis is live. All simulated data is labelled.";
    } catch (e) { msg.textContent = "✖ " + e.message; }
    $("#simBtn").disabled = false;
  }
  async function resetCrisis() {
    try {
      const was = planOn();
      await post({ action: "crisis", op: "reset" }, { admin: true }); cdDirty = false; CD = null; lastExplain = "";
      if (was) { try { await RL.api.post({ action: "alert", level: "low", scope: "all", text: "✅ The Exam Day Crisis is over. Normal timetable restored." }); } catch {} await refresh(); }
      $("#simMsg").textContent = "Crisis reset; simulated students removed.";
    } catch (e) { $("#simMsg").textContent = "✖ " + e.message; }
  }
  function localExplain(x) {
    const mw = (x.brokeDownOnTheWay || []).map((m) => `${m.bus} broke down on the way ${m.where} at ${m.at} with ${m.strandedOnBoard} students on board; ${m.pickedUp} of them are picked up at the spot${m.rescue ? ` (${m.rescue.replace("rescue: ", "").split(" (")[0]})` : ""}.`).join(" ");
    return `${x.simulated ? "SIMULATED DRILL. " : ""}${mw ? mw + "\n" : ""}${x.brokenTrips.length} bus trip(s) broke down before leaving (${x.brokenTrips.join(", ") || "none"}), demand rose ${x.surgePct}%${x.blockedRoad ? ` and the road ${x.blockedRoad} is flooded` : ""}.
What the plan does: ${x.replacements.length ? x.replacements.map((r) => `${r.label} is covered by a ${r.from.split(" (")[0]}`).join("; ") + ". " : "No replacement bus was available. "}${x.detours.length ? x.detours.map((d) => d.found ? `${d.route} takes a detour (+${d.extraMin} min)` : `${d.route} cannot pass, so its riders are moved`).join("; ") + ". " : ""}Exam students are seated first, earliest exam first; the others take the next bus at their stop or at a nearby stop, and ${x.autosUsed} shared-auto pod(s) of 4 cover the rest.
Result: students missing an exam ${x.before.examMiss} → ${x.after.examMiss}; students left without transport ${x.before.stranded} → ${x.after.stranded}.
${x.after.examMiss ? `Still at risk: ${x.after.examMiss} exam student(s). Ask the exam cell for a short grace period and send one more auto or van to their stops.` : "Every exam student reaches college in time."} ${x.after.stranded ? `Arrange ${Math.ceil(x.after.stranded / 4)} more autos for the ${x.after.stranded} students still without transport.` : ""}`;
  }
  async function explainPlan() {
    const pl = window.__lastPlan; if (!pl) return; const c = draft();
    const x = { simulated: !!c.simulated, before: pl.before, after: pl.after, replacements: pl.replacements, brokenTrips: c.broken.map(tripName), blockedRoad: c.blocked ? `${c.blocked.a.name} ↔ ${c.blocked.b.name}` : null,
      detours: pl.blockedRoutes.map((id) => ({ route: RL.R[id].code, found: !!c.detours?.[id]?.found, extraMin: c.detours?.[id]?.extraMin || 0 })), surgePct: c.surgePct, autosUsed: pl.autosUsed, autosAvailable: c.autos,
      brokeDownOnTheWay: (pl.midway || []).map((m) => { const st = pl.stranded.filter((p) => p.tripId === m.tripId); return { bus: tripName(m.tripId), where: m.place, at: RL.fmt(m.at), strandedOnBoard: st.length, pickedUp: st.filter((p) => pl.results[p.id]?.mode !== "none").length, rescue: pl.trips[m.tripId]?.replacedBy || null }; }) };
    $("#explainOut").textContent = "Explaining…";
    try { const j = await callAI("explain", { context: x }); lastExplain = j.answer + "\n\n— explained by Claude (" + (j.model || "Anthropic API") + ")"; }
    catch { lastExplain = localExplain(x) + "\n\n— on-device explanation (cloud AI not configured)"; }
    $("#explainOut").textContent = lastExplain;
  }
  function renderCrisisBanner() {
    const el = $("#crisisBanner");
    if (!planOn() || !PLAN) { el.className = "banner crisis hidden"; return; }
    const mine = P.registered && P.myRid ? RL.Crisis.personal(PLAN, P.myRid) : null;
    let txt;
    if (mine) txt = mine.text;
    else {
      const st = PLAN.trips[P.profile.tripId];
      txt = (st ? (st.midway ? `Your usual bus ${tripLabel(st.trip)} broke down on the way ${st.midway.place} at ${RL.fmt(st.midway.at)}${st.replacedBy ? `; a rescue bus continues the route about ${PLAN.repDelay[st.trip.id]} min late` : ""}.` : st.broken ? `Your usual bus ${tripLabel(st.trip)} has broken down${st.replacedBy ? "; a replacement runs +15 min" : ""}.` : st.blocked ? `Your route is hit by the flooded road${st.detour ? ` (detour +${st.detour} min)` : ""}.` : `Your usual bus ${tripLabel(st.trip)} is running.`) + " " : "")
        + `Tap "I ride this bus" (tick "I have an exam today") to get a reserved seat in the plan.`;
    }
    const n = PLAN.stranded.length, onRoad = n ? ` · ${n} student${n > 1 ? "s" : ""} stranded on the road, ${n - PLAN.stranded.filter((p) => PLAN.results[p.id]?.mode === "none").length} with a pickup` : "";
    const title = crisisOn() ? `🚨 <b>EXAM DAY CRISIS${DB.crisis.simulated ? " · SIMULATED DRILL" : ""}</b>` : `🛠 <b>BUS BROKE DOWN ON THE WAY${DB.crisis.simulated ? " · SIMULATED" : ""}</b>`;
    el.className = "banner crisis";
    el.innerHTML = `${title}: students at risk of missing an exam ${PLAN.before.examMiss} → ${PLAN.after.examMiss} after re-planning${esc(onRoad)} · <b>${PLAN.decidedBy === "claude" ? "🤖" : "⚙️"} ${decidedBy()}</b>.<span class="cb-plan">${esc(txt)}</span>`;
  }

  // ---------- render & events ----------
  function safe(fn, name) { try { fn(); } catch (e) { console.error("render " + name, e); } }
  function renderAll() {
    safe(renderHome, "home"); safe(renderStatus, "status"); safe(renderReport, "report"); safe(renderGroups, "groups"); safe(renderAlerts, "alerts"); safe(renderAdmin, "admin");
    safe(renderCrisisBanner, "crisisBanner"); safe(renderCrisisAdmin, "crisisAdmin");
    if ($("#tab-alt").classList.contains("on")) renderAlt().catch((e) => console.error("render alt", e));
    safe(riskAlerts, "riskAlerts");
  }
  function showTab(name) {
    $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    const active = $(`#tabs button[data-tab="${name}"]`); // keep the active tab visible in the scrollable strip on phones
    if (active) $("#tabs").scrollTo({ left: active.offsetLeft - ($("#tabs").clientWidth - active.offsetWidth) / 2, behavior: "smooth" });
    $$(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + name));
    if (name === "admin") { safe(renderAdmin, "admin"); safe(renderCrisisAdmin, "crisisAdmin"); } if (name === "alt") renderAlt().catch((e) => console.error(e));
    if (name === "home" && map) setTimeout(() => map.invalidateSize(), 50);
  }
  async function setRole(r) {
    if (r === "admin" && !isAdmin()) { openLogin("admin", ME ? "The Admin view needs a transport cell login." : ""); r = "student"; }
    P.role = r; saveP(); document.body.classList.toggle("admin", r === "admin");
    $$(".role button[data-role]").forEach((b) => b.classList.toggle("on", b.dataset.role === r)); // not the login modal's tabs
    if (r === "admin") showTab("admin"); else if ($("#tab-admin").classList.contains("on")) showTab("home");
  }

  function wire() {
    $("#pName").value = P.profile.name; $("#pArrive").value = P.profile.arrive; if (P.profile.stop) $("#pStop").value = P.profile.stop.name; showStopInfo();
    $("#wDay").innerHTML = `<option value="today">Today</option>` + [1, 2, 3, 4, 5, 6].map((d) => `<option value="${d}">Next ${RL.DAYS[d]}</option>`).join("");
    $("#pStop").onchange = async (e) => { const s = await resolveOrGeocode(e.target.value); if (s) setStop(s); else $("#stopInfo").textContent = "Couldn't find that place — try a nearby bus stop name or tap a dot on the map."; };
    $("#pTrip").onchange = (e) => { P.profile.tripId = e.target.value; saveP(); delete $("#rTrip").dataset.touched; delete $("#gTrip").dataset.touched; compute(); renderAll(); };
    $("#pName").onchange = (e) => { P.profile.name = e.target.value.trim(); saveP(); };
    $("#pArrive").onchange = (e) => { P.profile.arrive = e.target.value || "08:45"; saveP(); renderAll(); };
    $("#wRain").onchange = (e) => { W.rain = e.target.value; compute(); renderAll(); };
    $("#wDay").onchange = (e) => { W.day = e.target.value; compute(); renderAll(); };
    const riderPayload = (t) => ({ action: "rider", clientId: P.clientId, name: P.profile.name || "Student", routeId: t.routeId, time: t.time, stop: P.profile.stop, exam: !!P.profile.exam, examTime: P.profile.examTime || "09:30" });
    $("#riderBtn").onclick = async () => {
      if (!isStudent()) return openLogin("student", "Log in with your student email to register as a rider.");
      const t = RL.T[P.profile.tripId]; if (!t || !P.profile.stop) return alert("Choose your stop and bus first.");
      const removing = P.registered === P.profile.tripId;
      try { await post(removing ? { action: "rider", clientId: P.clientId } : riderPayload(t)); P.registered = removing ? "" : P.profile.tripId; saveP(); renderAll(); }
      catch (e) { alert("Could not save: " + e.message); }
    };
    // exam today? (priority in Exam Day Crisis plans) — re-saves the rider if already registered
    $("#pExam").checked = !!P.profile.exam; $("#pExamTime").value = P.profile.examTime || "09:30";
    const examUi = () => $(".examtime").classList.toggle("off", !$("#pExam").checked);
    const examChange = async () => {
      P.profile.exam = $("#pExam").checked; P.profile.examTime = $("#pExamTime").value || "09:30"; saveP(); examUi();
      const t = RL.T[P.profile.tripId];
      if (t && P.registered === P.profile.tripId && P.profile.stop) { try { await post(riderPayload(t)); } catch (e) { alert("Could not save: " + e.message); } }
    };
    $("#pExam").onchange = examChange; $("#pExamTime").onchange = examChange; examUi();
    // Exam Day Crisis (admin)
    $("#simBtn").onclick = simulateCrisis;
    $("#crisisResetBtn").onclick = resetCrisis;
    $("#cApply").onclick = applyCrisis;
    $("#cDetourBtn").onclick = findDetour;
    [["#cSurge", "surgePct"], ["#cSpare", "spare"], ["#cAutos", "autos"]].forEach(([id, f]) => ($(id).onchange = () => { draft()[f] = Math.max(0, +$(id).value || 0); cdDirty = true; renderCrisisPlan(); }));
    $("#cBlock").onchange = async () => {
      const c = draft(); cdDirty = true; c.detours = {};
      const s = RL.Crisis.segments().find((x) => x.key === $("#cBlock").value);
      c.blocked = s ? { a: s.a, b: s.b } : null; renderDetourInfo(); renderCrisisPlan();
      if (s) await findDetour();
    };
    $$("#tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
    $$(".role button[data-role]").forEach((b) => (b.onclick = () => setRole(b.dataset.role))); // [data-role]: the login modal's tabs use .role too
    $$(".rb[data-out]").forEach((b) => (b.onclick = () => submitReport(b.dataset.out)));
    // v8: broke down on the way
    $("#bdBtn").onclick = () => reportBreakdown(null);
    $("#bdSend").onclick = () => reportBreakdown(+$("#bdSeg").value || 0);
    $("#mwAdd").onclick = addMidway;
    $("#mwTrip").onchange = () => { delete $("#mwSeg").dataset.trip; renderMidwayAdmin(); };
    $("#rTrip").onchange = () => { $("#rTrip").dataset.touched = "1"; };
    $("#gTrip").onchange = () => { $("#gTrip").dataset.touched = "1"; renderGroups(); };
    $("#askForm").onsubmit = (e) => { e.preventDefault(); const q = $("#askInput").value; $("#askInput").value = ""; ask(q); };
    $$(".suggest button").forEach((b) => (b.onclick = () => ask(b.textContent)));
    $("#alertForm").onsubmit = async (e) => { e.preventDefault(); try { await post({ action: "alert", level: $("#aLevel").value, scope: $("#aScope").value, text: $("#aText").value.trim() }, { admin: true }); $("#aText").value = ""; } catch (er) { alert(er.message); } };
    $("#notifBtn").onclick = async () => { if (!("Notification" in window)) return alert("Notifications not supported on this browser."); const p = await Notification.requestPermission(); $("#notifBtn").textContent = p === "granted" ? "🔔 Notifications on" : "🔕 Notifications blocked"; };
    $("#nStopAdd").onclick = async () => { const s = await resolveOrGeocode($("#nStop").value); if (!s) return alert("Stop not found"); newStops.push({ name: s.name, lat: s.lat, lng: s.lng }); $("#nStop").value = ""; renderAdmin(); };
    $("#nSave").onclick = saveRoute;
    $("#starterBtn").onclick = loadStarter;
    $("#dBtn").onclick = discover;
    const saveCfg = () => post({ action: "config", config: { spare: +$("#spare").value || 0, examWeek: $("#examWeek").checked } }, { admin: true }).catch((e) => alert(e.message));
    $("#spare").onchange = saveCfg; $("#examWeek").onchange = saveCfg;
    $("#oSave").onclick = async () => {
      const area = $("#oArea").value.trim(); const s = area ? await resolveOrGeocode(area) : null;
      try { await post({ action: "addOperator", op: { name: $("#oName").value, type: $("#oType").value, phone: $("#oPhone").value, area, cost: $("#oCost").value, lat: s?.lat, lng: s?.lng } }, { admin: true }); ["#oName", "#oPhone", "#oArea", "#oCost"].forEach((x) => ($(x).value = "")); } catch (e) { alert(e.message); }
    };
    $("#evBtn").onclick = async () => {
      const rid = $("#evRoute").value; if (!rid || !RL.R[rid]) return; const e = evidenceStats(rid); $("#evOut").textContent = "Drafting with Claude…";
      try { const j = await callAI("letter", { context: { college: RL.COLLEGE.name, evidence: e } }); $("#evOut").textContent = j.answer + "\n\n— drafted by Claude (" + (j.model || "Anthropic API") + ") from real report data"; }
      catch { $("#evOut").textContent = letterTemplate(e) + "\n\n— generated on-device from real report data"; }
    };
  }

  // ---------- boot ----------
  // v9 login wiring
  $$("[data-lg]").forEach((b) => (b.onclick = () => { lgRole = b.dataset.lg; lgMode = "login"; $("#lgMsg").textContent = ""; setLgUi(); }));
  $("#lgToggle").onclick = (e) => { e.preventDefault(); lgMode = lgMode === "signup" ? "login" : "signup"; $("#lgMsg").textContent = ""; setLgUi(); };
  $("#loginForm").onsubmit = submitLogin;
  $("#loginClose").onclick = closeLogin;
  $("#loginModal").onclick = (e) => { if (e.target.id === "loginModal") closeLogin(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLogin(); });
  $("#gateLogin").onclick = () => openLogin("student");
  // welcome page choices
  $$("[data-wl]").forEach((b) => (b.onclick = () => (b.dataset.wl === "emergency" ? setMode("emergency") : openLogin(b.dataset.wl))));
  // emergency access: pick where you are (typed stop or GPS → nearest real stop)
  $("#altStop").onchange = async (e) => { const s = await resolveOrGeocode(e.target.value); if (s) { setStop(s); $("#altStopInfo").textContent = `📍 ${s.name}`; renderAlt(); } else $("#altStopInfo").textContent = "Couldn't find that place. Try a nearby bus stop name."; };
  $("#altGps").onclick = () => {
    if (!navigator.geolocation) { $("#altStopInfo").textContent = "Location isn't available on this device: type your stop."; return; }
    $("#altStopInfo").textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition((p) => {
      const me = { lat: p.coords.latitude, lng: p.coords.longitude };
      const s = STOPS.slice().sort((a, b) => RL.haversine(a, me) - RL.haversine(b, me))[0];
      if (!s) { $("#altStopInfo").textContent = "Bus stops are still loading; try again in a moment."; return; }
      setStop(s); $("#altStop").value = s.name; $("#altStopInfo").textContent = `📍 Nearest stop: ${s.name} (${RL.haversine(s, me).toFixed(1)} km)`; renderAlt();
    }, () => { $("#altStopInfo").textContent = "Location permission denied: type your stop instead."; }, { timeout: 8000 });
  };
  renderUserChip();
  wire(); renderAll();
  addMsg("a", "Hi! Set your bus stop, then ask me which bus to take, why it's risky, or what to do if it doesn't come.");
  // stops: bundled OpenStreetMap snapshot first (instant dots), then live Overpass data replaces it when reachable
  const useStops = (s) => { if (!s || !s.length) return; STOPS = s; $("#stopList").innerHTML = s.map((x) => `<option value="${esc(x.name)}">`).join(""); renderAll(); };
  const snapshotReady = RL.loadStopsSnapshot().then((s) => { if (!STOPS.length) useStops(s); }).catch(() => {});
  stopsReady = Promise.all([snapshotReady, RL.loadStops().then(useStops).catch(() => {})]).then(() => {
    if (!STOPS.length) $("#stopInfo").textContent = "OpenStreetMap stops couldn't load — you can still type a village name.";
  });
  snapshotReady.then(() => { stopsReady = Promise.resolve(); }); // simulate/starter routes only need some stops
  loadWeather();
  setMode(startMode());
  refresh().then(() => { setRole(P.role === "admin" && isAdmin() ? "admin" : "student"); setMode(startMode()); });
  setInterval(refresh, 20000);
})();
