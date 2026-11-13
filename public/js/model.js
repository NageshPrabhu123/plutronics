/* RouteLess AI engine — runs in the browser on REAL data only.
 *  1. Delay/cancel model : Bayesian (MAP) logistic regression. Starts from weak, documented priors and is
 *                          re-fitted on every real student report (rain at report time, market day, Monday,
 *                          exam week, first trip, route). With 0 reports it says so and uses priors only.
 *  2. Demand estimate    : students registered on each trip × weather/exam adjustment, bumped by "too full" reports
 *  3. Reliability score  : Beta(2,2)-smoothed on-time rate per route from real reports (last 30 days)
 *  4. Bus allocation     : greedy optimiser — spare / under-used buses → biggest risk-weighted shortfall
 *  5. Grouping           : registered riders on the same trip & nearby stops → pods of 4 */
(function () {
  const RL = window.RL;
  const sig = (z) => 1 / (1 + Math.exp(-z));

  // Weak priors (log-odds) — replaced by evidence as reports arrive. Base ≈ 25% disruption.
  const PRIOR = { bias: -1.1, rain: 1.0, market: 0.7, monday: 0.35, exam: 0.3, early: -0.3 };

  RL.buildTrips = (routes) => {
    RL.ROUTES = routes; RL.R = Object.fromEntries(routes.map((r) => [r.id, r]));
    RL.TRIPS = []; routes.forEach((r) => r.times.forEach((t, i) => RL.TRIPS.push({ id: `${r.id}|${t}`, routeId: r.id, time: t, early: i === 0 ? 1 : 0, capacity: r.capacity })));
    RL.T = Object.fromEntries(RL.TRIPS.map((t) => [t.id, t]));
    RL.FEATURES = ["bias", "Rain", "Market day", "Monday", "Exam week", "First trip", ...routes.map((r) => r.code)];
  };

  RL.reportFeatures = (r) => {
    const route = RL.R[r.routeId]; const dow = new Date(r.date + "T08:00:00+05:30").getDay();
    return { rain: r.rain >= 0.5 ? 1 : r.rain || 0, market: route && route.marketDay === dow ? 1 : 0, monday: dow === 1 ? 1 : 0, exam: r.exam || 0 };
  };

  RL.featurize = (tripId, c) => {
    const t = RL.T[tripId];
    return [1, c.rain, c.market, c.monday, c.exam, t ? t.early : 0, ...RL.ROUTES.map((r) => (t && r.id === t.routeId ? 1 : 0))];
  };

  function fitMAP(X, y, mu, tau = 3, iters = 300, lr = 0.6) {
    const d = mu.length, w = mu.slice(), n = X.length; if (!n) return w;
    for (let it = 0; it < iters; it++) {
      const g = new Array(d).fill(0);
      for (let i = 0; i < n; i++) { let z = 0; for (let j = 0; j < d; j++) z += w[j] * X[i][j]; const e = sig(z) - y[i]; for (let j = 0; j < d; j++) g[j] += e * X[i][j]; }
      for (let j = 0; j < d; j++) w[j] -= (lr * (g[j] + tau * (w[j] - mu[j]))) / (n + tau);
    }
    return w;
  }

  RL.Model = {
    w: [], mu: [], cancel: {}, n: 0, nByRoute: {}, trainedAt: null,
    train(reports) {
      this.mu = [PRIOR.bias, PRIOR.rain, PRIOR.market, PRIOR.monday, PRIOR.exam, PRIOR.early, ...RL.ROUTES.map(() => 0)];
      const X = [], y = []; this.nByRoute = {};
      reports.forEach((r) => {
        const tripId = `${r.routeId}|${r.time}`; if (!RL.T[tripId] || r.outcome === "full") return;
        X.push(RL.featurize(tripId, RL.reportFeatures(r))); y.push(r.outcome === "ontime" ? 0 : 1);
        this.nByRoute[r.routeId] = (this.nByRoute[r.routeId] || 0) + 1;
      });
      this.n = X.length; this.w = fitMAP(X, y, this.mu); this.trainedAt = new Date();
      RL.ROUTES.forEach((rt) => {
        const rs = reports.filter((x) => x.routeId === rt.id);
        const ns = rs.filter((x) => x.outcome === "noshow").length, lt = rs.filter((x) => x.outcome === "late").length;
        this.cancel[rt.id] = (ns + 1) / (ns + lt + 4); // Beta(1,3) prior ≈ 25% of disruptions are cancellations
      });
    },
    predict(tripId, c) {
      const x = RL.featurize(tripId, c); let z = 0; x.forEach((v, j) => (z += this.w[j] * v));
      const p = sig(z), t = RL.T[tripId], route = RL.R[t.routeId];
      const f = []; const add = (label, val) => f.push({ label, val });
      if (c.rain > 0.05) add(c.rain >= 0.5 ? "rain" : "chance of rain", this.w[1] * c.rain);
      if (c.market) add("market day on route", this.w[2]);
      if (c.monday) add("Monday rush", this.w[3]);
      if (c.exam) add("exam-week crowding", this.w[4]);
      if (t.early) add("first trip of the day", this.w[5]);
      const ri = 6 + RL.ROUTES.indexOf(route); if (this.nByRoute[route.id]) add("this route's track record", this.w[ri]);
      f.sort((a, b) => b.val - a.val);
      return { p, pCancel: p * this.cancel[route.id], factors: f, evidence: this.nByRoute[route.id] || 0 };
    },
  };

  RL.reasonText = (pred) => {
    const pos = pred.factors.filter((f) => f.val > 0.15);
    if (!pos.length) return pred.evidence ? "based on recent reports" : "no reports yet — prior estimate";
    return pos.slice(0, 3).map((f) => f.label).join(" + ");
  };

  RL.reliability = (reports, routeId, days = 30) => {
    const sk = RL.istDate(Date.now() - days * 864e5);
    const rs = reports.filter((r) => r.date >= sk && r.routeId === routeId && r.outcome !== "full");
    const ok = rs.filter((r) => r.outcome === "ontime").length, ns = rs.filter((r) => r.outcome === "noshow").length;
    if (!rs.length) return { score: null, grade: "–", reports: 0, onTime: 0, cancelled: 0, late: 0 };
    const score = Math.round((100 * (ok + 2)) / (rs.length + 4));
    const grade = score >= 85 ? "A" : score >= 72 ? "B" : score >= 60 ? "C" : score >= 45 ? "D" : "F";
    return { score, grade, reports: rs.length, onTime: ok, cancelled: ns, late: rs.length - ok - ns };
  };

  RL.demand = (tripId, c, riders, reports) => {
    const reg = riders.filter((r) => `${r.routeId}|${r.time}` === tripId).length;
    const t = RL.T[tripId];
    const recent = reports.filter((r) => `${r.routeId}|${r.time}` === tripId && r.date >= RL.istDate(Date.now() - 14 * 864e5));
    const fullShare = recent.length ? recent.filter((r) => r.outcome === "full").length / recent.length : 0;
    let d = Math.round(reg * (0.92 - 0.07 * c.rain + 0.06 * c.exam) + (c.market ? reg * 0.1 : 0));
    if (fullShare >= 0.3) d = Math.max(d, t.capacity + 5);
    return { demand: d, registered: reg, fullShare };
  };

  RL.allocate = (rows, spare) => {
    const donors = rows.filter((r) => r.registered > 0 && r.demand < r.capacity * 0.5).map((r) => ({ ...r, free: r.capacity - r.demand })).sort((a, b) => b.free - a.free);
    const need = rows.map((r) => { const effCap = r.capacity * (1 - r.pred.pCancel); return { ...r, effCap, short: r.demand - effCap, priority: r.demand - effCap + r.pred.p * 20 }; })
      .filter((r) => r.short > 3).sort((a, b) => b.priority - a.priority);
    return need.map((n) => {
      if (spare > 0) { spare--; return { ...n, action: "Deploy spare bus", from: "Depot reserve" }; }
      const d = donors.find((x) => x.trip.routeId !== n.trip.routeId || x.trip.time !== n.trip.time);
      if (d) { donors.splice(donors.indexOf(d), 1); return { ...n, action: "Re-assign bus", from: `${RL.R[d.trip.routeId].code} ${d.trip.time} (${d.demand}/${d.capacity})` }; }
      return { ...n, action: "Request extra bus from KSRTC", from: "no spare available" };
    });
  };

  RL.groupRiders = (tripId, riders, size = 4) => {
    const list = riders.filter((r) => `${r.routeId}|${r.time}` === tripId);
    const clusters = [];
    list.forEach((r) => { const c = clusters.find((k) => RL.haversine(k.stop, r.stop) < 1.2); if (c) c.members.push(r); else clusters.push({ stop: r.stop, members: [r] }); });
    const pods = [];
    clusters.forEach((c) => { for (let i = 0; i < c.members.length; i += size) pods.push({ id: `P${pods.length + 1}`, stop: c.stop, members: c.members.slice(i, i + size) }); });
    return pods;
  };
})();
