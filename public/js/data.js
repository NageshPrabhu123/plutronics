/* RouteLess — live data layer. NO synthetic data:
 *  - bus stops      : OpenStreetMap (Overpass API), live
 *  - place search   : OpenStreetMap Nominatim, live
 *  - road routing   : OSRM (real road geometry + driving time between stops)
 *  - weather        : Open-Meteo, live
 *  - routes, reports, riders, alerts : shared RouteLess database (/api/data), entered by real users */
(function () {
  const RL = (window.RL = window.RL || {});
  RL.DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Destination college (real coordinates — Sahyadri College of Engineering & Management, Adyar)
  RL.COLLEGE = { name: "Sahyadri College, Adyar", lat: 12.8669, lng: 74.9254 };
  RL.BBOX = [12.55, 74.75, 13.2, 75.45]; // Dakshina Kannada belt (S, W, N, E)

  RL.haversine = (a, b) => {
    const R = 6371, toR = (d) => (d * Math.PI) / 180;
    const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  RL.toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  RL.fmt = (m) => { m = Math.round(m); const h = Math.floor(m / 60) % 24, mm = ((m % 60) + 60) % 60; return `${h}:${String(mm).padStart(2, "0")}`; };
  RL.istDate = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  RL.istDow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).getDay();
  RL.istNowMin = () => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })); return d.getHours() * 60 + d.getMinutes(); };

  const cacheGet = (k, maxAgeMs) => { try { const c = JSON.parse(localStorage.getItem(k)); if (c && Date.now() - c.t < maxAgeMs) return c.v; } catch {} return null; };
  const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), v })); } catch {} };

  async function overpass(q) {
    const hosts = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
    for (const h of hosts) {
      try { const r = await fetch(h, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(25000) }); if (r.ok) return await r.json(); } catch {}
    }
    throw new Error("Overpass unavailable");
  }

  // Real bus stops & stations from OpenStreetMap (cached 24 h)
  RL.loadStops = async () => {
    const c = cacheGet("routeless.osmstops", 864e5); if (c) return c;
    const [s, w, n, e] = RL.BBOX;
    const j = await overpass(`[out:json][timeout:60];(node["highway"="bus_stop"](${s},${w},${n},${e});node["amenity"="bus_station"](${s},${w},${n},${e});node["public_transport"="platform"]["bus"="yes"](${s},${w},${n},${e}););out;`);
    const seen = new Set(), stops = [];
    j.elements.forEach((x) => {
      const name = (x.tags && (x.tags.name || x.tags["name:en"])) || null; if (!name) return;
      const key = name.toLowerCase().replace(/bus (stop|stand|station|shelter)/g, "").trim() + Math.round(x.lat * 200) + Math.round(x.lon * 200);
      if (seen.has(key)) return; seen.add(key);
      stops.push({ id: "osm" + x.id, name, lat: x.lat, lng: x.lon, station: x.tags.amenity === "bus_station" });
    });
    stops.sort((a, b) => a.name.localeCompare(b.name));
    cacheSet("routeless.osmstops", stops); return stops;
  };

  // Real taxi / auto-rickshaw stands near a point (OSM), cached 24 h
  RL.loadTaxiStands = async (p, km = 4) => {
    const k = `routeless.taxi.${p.lat.toFixed(3)},${p.lng.toFixed(3)}`; const c = cacheGet(k, 864e5); if (c) return c;
    const j = await overpass(`[out:json][timeout:30];(node["amenity"="taxi"](around:${km * 1000},${p.lat},${p.lng});node["amenity"="bus_station"](around:${km * 1000},${p.lat},${p.lng}););out;`);
    const v = j.elements.map((x) => ({ name: (x.tags && x.tags.name) || (x.tags.amenity === "taxi" ? "Taxi / auto stand" : "Bus station"), type: x.tags.amenity === "taxi" ? "Taxi / auto stand" : "Bus station", lat: x.lat, lng: x.lon, km: RL.haversine(p, { lat: x.lat, lng: x.lon }) })).sort((a, b) => a.km - b.km).slice(0, 6);
    cacheSet(k, v); return v;
  };

  // Place search (village name → coordinates) via Nominatim
  RL.geocode = async (q) => {
    const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&viewbox=${RL.BBOX[1]},${RL.BBOX[2]},${RL.BBOX[3]},${RL.BBOX[0]}&bounded=1&q=${encodeURIComponent(q)}`;
    const j = await (await fetch(u, { headers: { "Accept-Language": "en" }, signal: AbortSignal.timeout(10000) })).json();
    return j[0] ? { name: q, lat: +j[0].lat, lng: +j[0].lon } : null;
  };

  // Road geometry + cumulative minutes between ordered points (OSRM). Bus ≈ 1.35× car time.
  RL.roadRoute = async (pts) => {
    try {
      const u = `https://router.project-osrm.org/route/v1/driving/${pts.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(";")}?overview=simplified&geometries=geojson`;
      const j = await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json();
      const rt = j.routes[0]; let acc = 0; const offsets = [0];
      rt.legs.forEach((l) => { acc += (l.duration / 60) * 1.35 + 1; offsets.push(Math.round(acc)); });
      return { geometry: rt.geometry.coordinates.map(([a, b]) => [+b.toFixed(5), +a.toFixed(5)]), offsets, km: Math.round(rt.distance / 1000) };
    } catch {
      let acc = 0; const offsets = [0];
      for (let i = 1; i < pts.length; i++) { acc += ((RL.haversine(pts[i - 1], pts[i]) * 1.3) / 30) * 60 + 1; offsets.push(Math.round(acc)); }
      return { geometry: pts.map((p) => [p.lat, p.lng]), offsets, km: null };
    }
  };

  // Live weather for the morning commute (Open-Meteo)
  RL.fetchWeather = async (p = { lat: 12.87, lng: 74.99 }) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lng}&hourly=precipitation_probability,precipitation,temperature_2m&current=precipitation,temperature_2m&timezone=Asia%2FKolkata&forecast_days=1`;
    try {
      const j = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json();
      const idx = j.hourly.time.map((t, i) => [t, i]).filter(([t]) => +t.slice(11, 13) >= 6 && +t.slice(11, 13) <= 9).map(([, i]) => i);
      const prob = Math.max(...idx.map((i) => j.hourly.precipitation_probability[i] ?? 0));
      const mm = idx.reduce((s, i) => s + (j.hourly.precipitation[i] || 0), 0);
      const nowRain = j.current?.precipitation || 0;
      return { ok: true, prob, mm: Math.round(mm * 10) / 10, temp: j.current?.temperature_2m, nowRain, rain: Math.min(1, Math.max(prob / 100, mm > 0.5 || nowRain > 0.2 ? 1 : 0)) };
    } catch { return { ok: false, prob: null, mm: 0, temp: null, rain: 0 }; }
  };

  // Shared database
  RL.api = {
    async get() { const r = await fetch("api/data", { cache: "no-store" }); if (!r.ok) throw new Error("api " + r.status); return r.json(); },
    async post(body) {
      const r = await fetch("api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "api " + r.status); return j;
    },
  };
})();
