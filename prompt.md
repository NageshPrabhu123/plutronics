# prompt.md — RouteLess: The Last Mile

**Event:** Aerophilia 2K26 · Prompt Battle
**Challenge:** ROUTELESS: THE LAST MILE (AI-powered rural transportation)
**Team member:** K. Nagesh Prabhu
**AI tool used to build:** Claude Code (desktop app), model **Claude Opus 5.5** (`claude-opus-5-5`)
**Date:** 13 Nov 2026

This file records every prompt we gave the AI, how the prompts changed over three iterations, which APIs the app uses, and every bug found and fixed.

---

## 1. Problem statement given to the AI (summary of the PDF)

> In many rural villages, students depend on a limited number of government buses to reach school and college. What happens when buses are unavailable, routes are disrupted, or demand exceeds capacity? Use AI tools and prompt engineering to build a solution: smart transportation platform, bus allocation, route optimisation, demand prediction, simulation, or something new. Judged on prompt quality, prompt iterations, AI utilisation, creativity, problem solving, debugging, adaptability to the surprise challenge and quality of the working solution. Submit a deployed link and a public GitHub repo.

---

## 2. Prompts (exact text, in order)

### Prompt 1: Feature brainstorm (team chat, 10:40)

```
Smart Route Finder	Finds suitable bus routes to college
AI Demand Prediction	Estimates student demand by route
Live Bus Status	Available, delayed, cancelled or full
Alternative Transport	Suggests alternative routes and verified transport options
Smart Bus Allocation	Recommends where additional buses are needed
Student Grouping	Identifies students travelling on similar routes
Admin Dashboard	Displays routes, demand and bus capacity
Emergency Alerts	Notifies students about disruptions
```

### Prompt 2: The core idea (10:41)

```
Students often wait an hour for a bus that never arrives. Students tap "bus came / didn't come,"
and the AI learns each route's reliability and forecasts "78% chance the 7:40 bus is late today —
rain + market day." It also shows a reliability score per route, which officials can use as
evidence to argue for more buses.
```

### Prompt 3: Build instruction to Claude Code (with the PDF attached), iteration v0

```
@PromptBattle_Aerophilia2K26.pdf
[Prompt 1 + Prompt 2 pasted]
I have provided you the problem statement pdf and you have to build a complete application (app)
before 2:15 hrs. This is a prompt battle competition and you can use any api etc but mention the
prompt i gave and api you used in the prompt.md (everything must be written in prompt.md)
```

**Result of v0:** a working app with every feature, but it ran on a **synthetic dataset**: invented bus codes, 140 days of generated reports and invented phone numbers.

### Prompt 4: "No fake data" (iteration v1, with a screenshot of the forecast card circled)

```
this is fake data right i want the real app and it must get all bus. bus name must be real name
and no fake data. there must be live data
```

**How the AI responded:**
- **Checked what real data exists.** It queried OpenStreetMap (Overpass) for the Mangaluru belt and found real bus stops, but only one mapped bus route. KSRTC and private operators publish no open live-GPS or timetable API.
- **Moved to live sources and real user input:**
  - real OSM bus stops, loaded live;
  - real road routing (OSRM);
  - live weather (Open-Meteo);
  - a shared database where the transport cell enters real routes and students submit real reports;
  - **AI route discovery**, where Claude with web search finds real bus services and cites its sources;
  - a Google Maps transit link from each student's stop for "every bus".
- **Changed the model:** it became a **Bayesian (MAP) logistic regression** that starts from weak priors and learns only from real reports. It shows "prior estimate" until there is evidence.
- **Stopped halfway:** this rewrite was cut off before `app.js` was replaced (see v2).

### Prompt 5: Fix and finish (iteration v2)

```
v2: the app crashes on load, please fix it and finish it. We have about 1.5 hours left.

I think the last rewrite stopped halfway. index.html, data.js, model.js and the api files are
the new version, but app.js is still the old one. It calls things like RL.dateKey, RL.V and
RL.HISTORY_REPORTS that don't exist anymore, so nothing shows up.

Please:
1. Rewrite app.js so it works with the new files. Don't change the overall design. Keep all
   the features: route finder, live status, report, alternatives, groups, alerts, Ask AI and
   admin.
2. Make sure no tab crashes when there are no routes or reports yet. Just show a simple
   message.
3. Add a "Load starter routes" button in Admin with 3–4 routes between real places (Puttur,
   Vitla, B.C. Road, Moodbidri → Sahyadri College). Mark the timings as samples, and don't
   make up phone numbers.
4. Refresh the data every 20 seconds. If the server is down, show "offline" instead of
   breaking.
5. Test everything yourself: load the starter routes, send a few reports, change rain and day,
   and check that the numbers update. Fix every console error.
6. Update README and prompt.md with this prompt and the bugs you fix.

It's done when I can open the app fresh, load the starter routes, pick my stop, see the
forecast, report my bus and see it change, with no errors.

You do everything step by step
```

**Why this prompt worked better:**
- It named the exact broken state: which files were new and which were old.
- It listed the missing symbols (`RL.dateKey`, `RL.V`, `RL.HISTORY_REPORTS`).
- It set limits: keep the design and keep every feature.
- It asked for honest starter data: real places, sample timings, no phone numbers.
- It gave a testable "done" definition.

**Result of v2:** the app worked end to end: fresh start → starter routes → pick stop → forecast → report → forecast changes, with no console errors (bugs 8–16 below).

### Prompt 6: Make it ready to submit (iteration v3)

```
v3: the app works now. No new features, just make it ready to submit.

1. Check it on a phone-size screen (about 375px wide). Fix anything that overflows,
   is cut off or is hard to tap, especially the tabs, the forecast card and the tables.
2. Make sure it deploys on Vercel as it is: both api functions work, it runs fine without
   ANTHROPIC_API_KEY, and data is saved in Upstash Redis when the KV env vars are set.
3. Don't set an ADMIN_PIN, so the judges can open the Admin tab.

4. Update prompt.md: add the result of v3, this prompt, and any bugs you fix.
   Update the README with the live link once I give it to you.
```

**Result of v3:**
- **Phone (375px):** every tab measured has no horizontal page scroll, no element past the screen edge, and no tap target under 40px (tabs are 44px). The header shrank from 187px to 87px. Tables show as labelled cards.
- **Desktop (1280px):** unchanged.
- **Vercel:** a test harness called both API functions the way Vercel does, against a stand-in Upstash REST server. All 12 checks passed, including a simulated Upstash outage that left the stored data intact.
- **Admin:** stays open, with no `ADMIN_PIN`.

### Prompts used inside the app (sent to Claude by `api/assistant.js`)

**Student assistant (system prompt):**
```
You are RouteLess, a transport assistant for rural college students in Dakshina Kannada (Mangaluru
region), India, who depend on KSRTC and private buses. You receive LIVE JSON from the RouteLess app:
bus routes registered by the college transport cell, real student "bus came / didn't come" reports,
AI delay forecasts (logistic regression trained on those reports + live rain forecast), live
statuses, registered riders, route reliability scores and verified alternative transport.
Rules:
- Ground every claim in the JSON. Quote exact times, risk percentages and reliability grades, and
  say how many real reports a number is based on. Never invent buses, timings, phone numbers or
  numbers. If the data has no route or no reports, say so plainly and suggest the Google Maps
  transit link or adding the route.
- Be short and practical: a student is reading this on a phone at a bus stop. Plain text, no
  markdown headings, at most ~120 words unless asked for more.
- Give a concrete recommendation and one fallback. Safety first: prefer verified options and
  travelling in groups early morning or in heavy rain.
- If the student writes in Kannada, reply in simple Kannada.
```

**Evidence letter for officials:**
```
Using ONLY the evidence JSON above (real student reports collected by RouteLess), draft a formal,
polite letter from the college's Student Transport Committee to the KSRTC Depot Manager, Mangaluru
Division, requesting additional or standby buses on this route. Cite the reliability score, number
of student reports, late and non-arrival counts, crowding reports and the rainy-vs-dry comparison
if present. If the sample is small, say so honestly. Propose 3 specific, low-cost actions. Plain
text, under 280 words.
```

**AI route discovery (Claude + web search tool):**
```
System: You research REAL bus services in Dakshina Kannada, Karnataka, India for a student transport
app. Use web search. Only report services you found evidence for on the web (KSRTC timetables, news,
bus-timing sites, forums). Never invent route numbers or timings. If timings are unknown, leave
departures empty.
User: Find real bus services (KSRTC and private) that students can take from "<village>" to
"<college>" in the morning. Reply with ONLY a JSON array … {code, operator, via[], departures[],
frequency, source URL} … Return [] if nothing reliable is found. Max 6 items.
```
An admin always reviews AI-found routes in the "Add route" form before saving, and the route keeps an "AI-found" tag and its source link.

---

## 3. Debugging log (all iterations)

| # | Iteration | What we saw | Fix |
|---|---|---|---|
| 1 | v0 | The 24 km/h bus speed made the 7:40 bus miss the 8:45 college start. | Realistic speeds, and timetable moved earlier. (Timings now come from OSRM road times.) |
| 2 | v0 | Old trip IDs saved in the browser crashed training. | Drop unknown trip IDs on load. |
| 3 | v0 | The report toast showed "45 → 45" because the "before" score was read after adding the report. | Read the score before posting. |
| 4 | v0 | A tie between "on time" and "didn't come" reports showed **Available**. | Ties are broken by recency. |
| 5 | v0 | High alerts on other routes never reached the banner. | High alerts now go to everyone. |
| 6 | v0 | An LLM called from the browser would leak the API key. | Claude sits behind `/api/assistant`, a serverless function. |
| 7 | v1 | The user pointed out the data was fake. | Rebuilt on live OSM, OSRM and Open-Meteo data, a shared database and real reports. No synthetic data is left. |
| 8 | v1 → v2 | **The app crashed on load:** the rewrite stopped halfway, and the old `app.js` called the removed `RL.dateKey`, `RL.V` and `RL.HISTORY_REPORTS`. | Rewrote `app.js` against the new data, model and API layer. |
| 9 | v2 | The unfinished draft of `app.js` named the local prefs object `L`, which would have **overwritten Leaflet's global `L`** and broken the map. | Renamed it to `P`, with a comment warning against reuse. |
| 10 | v2 | Tabs could throw on an empty database (no routes, trips or riders). | Every tab has an empty-state message, and each render runs inside `safe()`, so one failing tab cannot blank the page. |
| 11 | v2 | The "● live · N reports" chip only updated on the 20 s poll, so it showed 0 just after a report. | The chip now updates whenever new data arrives (`ingest`). |
| 12 | v2 | Without `ANTHROPIC_API_KEY`, every Ask AI or letter request logged a **501 console error**. | `GET /api/assistant` reports `{available}` once, and the app then uses the on-device assistant without failing requests. |
| 13 | v2 | Server down: the app had to keep working. | Tested by stopping the server: the chip shows "● offline · retrying", the last data stays on screen, and it recovers automatically. |
| 14 | v2 | **Wrong starter coordinate:** Farangipete was hard-coded about 2.6 km off, so a student at the real Farangipete stop saw "No registered bus route". | Starter stops are now matched **by name to real OSM stops** (within 8 km of a rough hint), then by distance, with corrected hints. |
| 15 | v2 | The Report tab kept the first bus in its list instead of the student's own bus, so a report counted against a different trip. | The Report and Groups tabs follow "My usual bus" unless the student changes them by hand. |
| 16 | v2 | Admin re-rendering every 20 s reset dropdowns while you were using them. | `keepSel()` keeps the current choice when lists re-render. |
| 17 | v3 | **Phone:** the header wrapped into 4 rows (187px tall). | Brand and Student/Admin toggle share row 1, the two status chips sit on row 2, and the subtitle is hidden: 87px. |
| 18 | v3 | **Phone:** the admin tables were 1,092px wide in a 310px box, and narrow wrapped columns made each row extremely tall. | Below 640px every table row becomes a stacked card. `labelTable()` copies column headers into `data-label`, and CSS shows them as labels. |
| 19 | v3 | **Phone:** inputs and buttons were 33–37px tall, below a comfortable finger tap. The tab strip showed a scrollbar. | Inputs and buttons are at least 44px (16px font, which also stops iOS zooming on focus), tabs are 44px, and the strip scrollbar is hidden. |
| 20 | v3 | **Phone:** the active tab (e.g. Admin) could sit off-screen in the scrollable tab strip. | `showTab()` scrolls the active tab to the centre of the strip. |
| 21 | v3 | The forecast headline repeated the route name: "…Puttur – Mangaluru (sample) is late … — Puttur – Mangaluru (sample) track record". | The reason now reads "this route's track record". The headline is also smaller on phones. |
| 22 | v3 | **Data-loss risk:** if an Upstash read failed (network blip or rate limit), `load()` returned an *empty* database, and the next report would have saved it **over all existing data**. | A failed read now throws, and `/api/data` returns 503 (the app shows "offline · retrying"). Only "key not set yet" or "file not created yet" count as empty. A simulated outage test confirms nothing is overwritten. |
| 23 | v3 | The whole database is one Redis value, so it could grow past Upstash's request-size limit. | Keep only the newest 5,000 reports (about 0.75 MB). |
| 24 | v3 | Vercel defaults: AI route discovery (web search) can take 20–60 s, and `"node": ">=18"` triggers a version warning. | `vercel.json` gives `api/assistant.js` `maxDuration: 60` (and `api/data.js` 15). Node is pinned to `22.x`. |
| 25 | v3 | The PIN warning in Admin sounded like an error to judges. | It now reads "Admin is open (no ADMIN_PIN set)…". Leaving it open is deliberate so the judges can use Admin. |

**v3 Vercel-readiness test** (a stand-in Upstash REST server, with handlers called as Vercel calls them: `req.body` pre-parsed, `VERCEL=1`, and no `ANTHROPIC_API_KEY` or `ADMIN_PIN`), 12/12 passing:
1. GET on an empty database goes through Upstash (`storage: "upstash"`, `adminLocked: false`).
2. Adding a route without a PIN works, and the `sample` flag is kept.
3. A report is saved.
4. The device `clientId` is not exposed publicly.
5. GET reads back what was saved.
6. Every Upstash call sends the Bearer token.
7. During an outage, POST returns 503.
8. During an outage, GET returns 503.
9. The stored database is unchanged after the outage.
10. The data is intact after the outage.
11. The assistant answers GET with `available: false`.
12. The assistant answers POST with 501, which the app never triggers because it checks `available` first.

**Final acceptance test (all passing, no console errors):**
1. Fresh browser and empty database: every tab shows a simple empty-state message.
2. Admin → **Load starter routes**: 4 routes saved, snapped to real OSM stops (e.g. "B C Road Bus Station", "Kaikamba Market Bus Stop"), with OSRM road times.
3. Pick the stop "Farangipete": 7 options, and the forecast reads "25% chance the 8:31 Puttur – Mangaluru (sample) is late… — no reports yet — prior estimate."
4. What-if: heavy rain moves a forecast from 20% to 40%; heavy rain on a Monday moves it to 49%.
5. Report "Didn't come": the forecast goes from 25% to 34%, the status becomes "Cancelled (1 student report today)", and reliability becomes 40/100 (F). With 2 "didn't come" reports the emergency banner fires automatically.
6. Rider registration, then Groups shows the pod; an admin override sets "Delayed" and sends an alert; the evidence letter is generated; Alternatives shows the Google Maps link, other buses and OSM taxi stands.
7. Server stopped: "offline · retrying". Server restarted: "live" again.

---

## 🚨 Surprise Hurdle: The Exam Day Crisis (v5 + v6)

**The surprise brief (PDF, 100 minutes):** on an exam day, two government buses break down, student demand rises 40%, a road between two villages floods, and several students have exams within 2 hours. Adapt RouteLess to reallocate buses, suggest other routes, put exam students first, use resources efficiently, and minimise the number of students who don't reach college on time.

### Prompt 7: v5, Exam Day Crisis mode (exact text)

```
v5 – SURPRISE HURDLE: Exam Day Crisis (PDF attached). We have 100 minutes.
Build it on top of the current app. Don't change the existing features or design.

Add a "🚨 Exam Day Crisis" mode that handles all 4 problems in the PDF:

1. Bus breakdown: in Admin, the transport cell can mark any 2+ trips as "Broken down".
   Those buses get 0 seats.
2. Demand surge: a "Demand +__%" box (default 40%) that multiplies the demand on every trip.
3. Road blockage: the admin picks a blocked road between two stops (e.g. B C Road →
   Farangipete). Every route that uses that road is flagged. Find a detour with OSRM
   (alternatives=true, pick the one that avoids the blocked spot) and show the extra minutes.
   If there's no detour, send those students to the nearest other route or a shared auto.
4. Exam students: when a student taps "I ride this bus", they can tick "I have an exam today"
   and enter the exam time. These students get top priority.

Then make a "Crisis plan" optimiser:
- Fill the available seats with exam students first (earliest exam first), then everyone else.
- Move spare and under-used buses to replace the broken ones.
- For students who still don't fit, suggest the next bus, a nearby-stop bus or a pod of 4 in
  a shared auto.
- Show before vs after: "students who would miss their exam: X → Y" and "students left
  without transport: X → Y". The goal is to make Y as small as possible.

Also add:
- A one-click "Simulate exam day crisis" button for the demo. It breaks 2 KSRTC trips,
  sets +40%, blocks one road and adds about 120 simulated students (40% with exams within
  2 hours). Label all of it "simulated" and add a "Reset crisis" button.
- When crisis mode is on, show a red banner to all students with their personal plan
  ("Your bus is broken down → take X at 7:40, you'll reach by 8:20, before your 9:30 exam").
  Send alerts automatically to the affected routes.
- Save the crisis state on the server (api/data.js, admin action "crisis") so every device
  sees the same plan.
- An optional "Explain this plan" button that uses Claude, with an on-device fallback.

Test it yourself: run the simulation, check the numbers go down after the plan, check the
student banner, reset, and fix all console errors. Then push to GitHub and add this prompt,
how it works, and any bugs to a "Surprise Hurdle" section in prompt.md.
```

### Prompt 8: v6, Claude decides the crisis plan (exact text, sent while v5 was being tested)

```
v6: use Claude for the crisis decisions.

The API key is in .env as ANTHROPIC_API_KEY. Don't print it, don't put it in any frontend
file and don't commit it. Make server.js load .env when running locally. On Vercel it comes
from the environment variables.

Add a new mode "crisis" to api/assistant.js:
1. The browser sends the crisis situation as JSON: broken buses, the demand surge, the
   blocked road and detour times, each trip's seats and riders, exam students with stop and
   exam time, spare buses, and the greedy plan we already compute.
2. Claude looks at it and decides: which bus replaces each broken one, which trips get the
   extra buses, which students move to which bus or shared auto, and who gets priority.
   It must reply with ONLY JSON: { assignments, busMoves, reasons, studentsMissingExam,
   studentsWithoutTransport }.
3. The server checks Claude's plan before using it: no bus over its seats, no broken bus
   used, every exam student either placed or listed. If the check fails or there's no key,
   use our greedy plan instead and say so.
4. In Admin, show the greedy plan and Claude's plan side by side with the before/after
   numbers. Pick whichever leaves fewer students missing their exam, and show Claude's
   reasons in plain English.
5. Show "Decided by Claude" or "Decided by on-device optimiser" on the plan and in the
   student banner.

Test it with the "Simulate exam day crisis" button, both with and without the key. Then
add this prompt and the result to prompt.md.
```

### How it works

**Shared state.** The admin action `crisis` (`api/data.js`, ops `set` / `simulate` / `reset`) stores the crisis on the server:
- broken trips, surge %, spare buses, available shared autos;
- the blocked road and OSRM detours;
- which plan was chosen (`decision`) and Claude's validated decisions.

Every device rebuilds **the same plan** from that state (`public/js/crisis.js`, deterministic). Simulated students are stored with `sim: true` and labelled "sim" everywhere. "Reset" removes them along with the crisis alerts.

**The 4 problems:**

| Problem | What RouteLess does |
|---|---|
| Bus breakdown | The admin ticks any trips as broken; they get 0 seats. Live Status shows **Broken down**, or **Replacement bus** once a bus is moved onto it. |
| Demand surge | `Demand +%` (default 40) adds that many extra riders to **every** trip. |
| Road blockage | The admin picks a road between two consecutive stops. Every route using it is flagged. **OSRM** `alternatives=3` is asked for a route avoiding the flooded spot (more than 0.8 km from the midpoint of the main road). If none avoids it, a **via-point detour** 2.8–5 km either side is tried. The extra minutes are shown. With no detour, the route can't be used, and its students go to other routes or shared autos. The map shows 🌊 and the red dashed detour. |
| Exam students | "📝 I have an exam today" plus an exam time sits next to "I ride this bus". These students are seated first, earliest exam first, and must reach college 10 min before the exam. |

**On-device optimiser (greedy).**
1. **"Before"** = no plan: everyone waits for their own bus, first come first served.
2. **Replacing broken buses:** depot spare buses first, then *donor* trips. A donor is an under-used trip (<40% full, no exam students) whose riders fit on its route's other trips. The trips with the most and earliest exam students are replaced first, at +15 min.
3. **Seating:** every student in priority order takes the first of these that reaches college in time:
   1. their own bus;
   2. another bus at their stop (≤1.5 km);
   3. a bus at a nearby stop (≤4 km);
   4. a **shared-auto pod of 4**. Exam students' autos leave as early as needed, never before 06:00, and are limited by the number of autos available.
   
   If nothing reaches college in time, the earliest transport is used.

**Claude decides (v6).**
1. The browser builds a compact context for Claude:
   - short ids (T1…, S1…) for trips and students;
   - each trip's seats, broken / blocked-no-detour status, detour minutes, riders and exam riders;
   - spare buses, autos and **donorCandidates**;
   - for each student, their exam time, stop and **only the options they can physically use**: `[trip, board, arrive, note]`, where `ifReplaced` marks broken trips (counted with +15 min) and `nearby x km` marks a different stop. Their auto times are included too;
   - the greedy plan and its results, as the baseline to beat.
   
   For the 120-student simulation this is 169 students (with the surge) and about 42 KB of JSON.
2. **The request:** `api/assistant.js` mode **`crisis`** calls `claude-opus-5-5` (streamed, effort `medium`, structured JSON output with a schema, refusal fallback). If the API rejects the output format, it retries with "JSON only" instructions.
3. **Server safety check** (`api/_crisisCheck.js`), before anything is used:
   - depot buses ≤ spare;
   - only allowed donors; moves only onto broken trips, at most once each;
   - only reachable buses for each student;
   - **no bus over its seats**;
   - **no broken bus used unless replaced**;
   - autos ≤ available, pods ≤ 4;
   - **every exam student placed or listed** as missing their exam.
   
   The server **recomputes** the numbers itself; Claude's own counts are never trusted.
4. **Choosing a plan:** the browser rebuilds Claude's plan and compares it with the greedy plan. **The one with fewer students missing their exam wins**; on a tie, fewer students without transport wins; on a full tie, Claude's plan is used because it explains its choices. If the check fails, the API errors, or there is no key, **the greedy plan is used, and the reason is shown**.
5. **Display:** Admin shows both plans side by side (before → after numbers, bus moves, autos), Claude's reasons in plain English, and the safety-check result. The plan header and every student's red banner say **"🤖 Decided by Claude"** or **"⚙️ Decided by on-device optimiser"**. Students who register after Claude decided keep their on-device seat if that bus still has room.

**Key handling:**
- **Local:** `env.js`, imported first in `server.js`, loads `.env` with `process.loadEnvFile`.
- **Vercel:** the key comes from the project's environment variables.
- **Never exposed:** the key is never printed, appears in no frontend file (a source scan found no key material), and `.env` is git-ignored.

### Results

**v5, simulated crisis (no key):**
- **The crisis:** 2 KSRTC trips broken, +40%, the B C Road ↔ Farangipete road flooded.
- **Detour:** OSRM found a via-point detour, +22 min / +11.8 km.
- **Students:** 120 simulated students, +49 surge riders, 49 with exams.
- **Plan:** the depot bus replaces Puttur 07:25, 52 students move bus, and 2 shared-auto pods are used.

| | Without plan | With plan |
|---|---|---|
| 📝 Students who would miss their exam | **26** | **0** |
| 🚶 Students left without transport | **80** | **0** |

A registered student on the broken Puttur 06:45 with a 09:00 exam saw: *"Your bus Puttur – Mangaluru (sample) 06:45 is broken down → take B.C. Road – Mangaluru (sample) 07:20 at 7:20, you'll reach by 7:59, before your 09:00 exam."* Reset cleared everything. The console was clean.

**v6, tested both ways:**

**Without the key** (second server on :5174 that ignores `.env`):
- **Decision:** "⚙️ Decided by on-device optimiser: No ANTHROPIC_API_KEY on the server…", on the plan and in the banner. Claude's column says it was not asked.
- **Numbers:** 26 → 0, 80 → 0.

**With the key** (`.env` loaded): the key was read and the request was sent, but the Anthropic account has **no credit**. The API answered `400 "Your credit balance is too low to access the Anthropic API"`. The app did exactly what was asked: it kept the greedy plan live and showed "Claude API error: … So the on-device optimiser decided." **Claude's actual decision could not be observed** until credits are added.

**Claude path verified without calling Claude.** A Node test ran the real browser code on the saved crisis:
- **Valid answer:** a Claude-format answer passes the server check, and the server's numbers equal the greedy ones (0/0).
- **Rebuild:** `applyClaude` reproduces them and is labelled `decidedBy: claude`.
- **Rule violations rejected:** over capacity ("T7 over capacity: 87/55 seats"), a broken bus without a replacement, a dropped exam student, 60 autos when 10 exist, a bus that doesn't stop near the student, a fake donor, and a non-JSON reply.

**UI with a stand-in reply** (marked `MOCK FOR TEST` in this browser tab only):
- **Valid reply:** "🤖 Decided by Claude", the reasons, and the side-by-side view. 169 decisions were saved on the server. A fresh device showed the Claude-decided banner, and a student registering afterwards got a valid personal plan.
- **Failed safety check:** the greedy plan was used and the errors were listed.

The test data was then reset.

### Bugs found and fixed during the Surprise Hurdle

| # | Bug | Fix |
|---|---|---|
| 26 | v5 test: 8 exam students were still at risk although 10 autos were free. The shared auto could leave at most 2 hours before the exam, too late from far stops like Puttur (about 40 km). | An exam student's auto leaves as early as needed (never before 06:00): exam misses 8 → **0**. |
| 27 | `crisis.js` counted "moved" students with a leftover `&& false` condition. | Counts `mode === "next"`. |
| 28 | Old red crisis alerts would stay in the banner after "Reset crisis". | Crisis alerts are tagged `crisis: true`, and reset deletes them before posting one "crisis is over" alert. |
| 29 | **Simulate hung forever** on a fresh origin: it started a second OpenStreetMap stops request while the first was still loading, and no external request had a timeout. | Simulate waits for the stops request already in flight (`stopsReady`). Every Overpass, OSRM and Nominatim call has a timeout (10–25 s) and falls back. |
| 30 | **Claude was never called:** the SDK refuses a *non-streaming* request with `max_tokens: 32000` ("Streaming is required for operations that may take longer than 10 minutes"). | The crisis request is streamed: `messages.stream(...).finalMessage()`. |
| 31 | Any 400 error (even "credit balance too low") triggered a pointless second "no-schema" request, and the saved reason was cut off mid-sentence. | The schema-less retry happens only when the 400 is about the output format. The server returns the API's plain message (`apiMessage`), and the note shows it in full. |
| 32 | The new crisis card made the page 709px wide on phones: long road names in the blocked-road dropdown widened the grid column. | `minmax(0,1fr)` columns, `min-width:0` on grid cells, and the dropdown capped at 100%: back to 375px. |
| 33 | Claude's plan only covers students registered when it decided; a later student would have had "no seat". | Late registrations keep their on-device seat if that bus still has room. |

### Still open
- **Claude's real decisions:** add credit to the Anthropic account, then press **Admin → 🤖 Ask Claude to decide** (or "Simulate exam day crisis") to see Claude's own plan, reasons and comparison. Everything around the call is built and tested.

---

## v7: Ready for judges

### Prompt 9 (exact text)

```
v7: last step, no new features. Get it live and ready for judges.

1. Push everything to GitHub main. Double-check that .env and node_modules are NOT pushed.
2. Make sure it deploys on Vercel. If maxDuration 300 isn't allowed on our plan, lower it,
   and make the Claude crisis call fall back to the optimiser on a timeout instead of
   failing.
3. Check the crisis card, the before/after numbers and the student banner on a phone-size
   screen.
4. At the top of the README, add "Demo in 2 minutes": Load starter routes → pick a stop →
   report a bus → Simulate exam day crisis → show before/after → show the student banner
   → Reset.
5. Add this prompt to prompt.md.
```

### What changed and why

| # | Problem | Fix |
|---|---|---|
| 34 | `maxDuration: 300` is only allowed on some Vercel plans or with Fluid Compute; 60 s works everywhere. | `vercel.json`: `api/assistant.js` uses **60 s**. |
| 35 | A Claude crisis decision could take longer than the function may run, ending in a hard failure. | The server gives Claude **50 s** (one `AbortController` deadline covering both attempts, no SDK retries) and then replies `{ok:false, timeout:true}`. The browser waits at most 58 s; on a timeout or a Vercel 504 it keeps the optimiser's plan and shows *"Claude did not answer in time, so the on-device optimiser decided."* |
| 36 | Re-listing all 169 students made Claude's answer long and slow. | Claude now lists **only the students it seats differently from the greedy plan**; everyone else keeps their greedy seat. The server merges the two (`mergeWithGreedy`) and runs the **same full safety check** on the merged plan. Effort `low`, `max_tokens` 16 000. |
| 37 | On a phone, the before → after numbers were about two screens below the crisis settings. | A compact **before → after + "Decided by …"** summary now sits right under the Simulate/Reset buttons. |
| 38 | On a phone, the crisis banner and a crisis alert banner stacked, taking about 230px. | While the red crisis banner shows, crisis alerts stay in the Alerts tab instead of a second banner. |

### Tests (all passing)
- **Timeout:** the real `api/assistant.js` handler was pointed (via `ANTHROPIC_BASE_URL`, dummy key) at a stand-in API that never answers. It returned `HTTP 200 {ok:false, timeout:true}` "Claude did not answer within 50 s" after **50 s**, inside Vercel's 60 s.
- **Merge:** a changed student moves, untouched students keep their greedy seat, and the merged plan passes the safety check.
- **Regression:** the Vercel/Upstash test passes 12/12, and every file passes `node --check`.
- **Phone (375px), the full 2-minute demo on the no-key server:**
  - load starter routes → pick B C Road → register with a 09:00 exam → report "late" → simulate;
  - **summary 27 → 0 / 81 → 0**, "⚙️ Decided by on-device optimiser";
  - personal banner *"Your bus Puttur – Mangaluru (sample) 06:45 is broken down → take B.C. Road – Mangaluru (sample) 07:20 at 7:20, you'll reach by 7:59, before your 09:00 exam."*;
  - reset (crisis off, 0 simulated students, the real rider kept).
  
  Every tab was 375px wide with no element past the edge; the crisis card and banner had no tap target under 40px; no console errors.
- **Not pushed:** `.env`, `data/`, `node_modules` (checked before the commit; `.gitignore` covers all three).

---

## v8: A bus breaks down on the way

### Prompts 10–11 (exact text)

```
if a bus got technical issues in between the way what to do?
```
The AI explained that RouteLess then treated every breakdown as "the bus never left": students already **on the bus** were wrongly told to catch another bus from their *home stop*, and there was no way to report "it broke down while I'm on it". It proposed a fix, and the reply was:
```
it must overcome properly
```

### How it works
- **Reporting:**
  - **Students on the bus:** in the Report tab, tap **🛠 Broke down on the way (I'm on the bus)**. The phone's GPS places the bus on its route (nearest segment). Without GPS, or more than 5 km off the route, the student picks "between stop A and stop B".
  - **Two-phone confirmation:** a breakdown is **confirmed automatically when 2 different phones report the same bus within 30 min**, so one prank tap can't re-plan everyone. The route then gets a high alert: "stay together at the bus".
  - **Transport cell:** can **Confirm** a single report, **Add** a breakdown (bus + "between which stops" + time) or **Remove** one (Admin → Exam Day Crisis → 5).
  - **Without crisis mode:** a breakdown on the way re-plans on its own. The banner reads "🛠 BUS BROKE DOWN ON THE WAY".
- **Who is where** (`crisis.js`):
  - Students who boarded **before** the breakdown point are now **stranded at the spot** from the breakdown time on.
  - Students at **later** stops still wait at their stops.
- **Rescue options for stranded students, all from the spot:**
  1. **Rescue bus:** a depot spare or an under-used bus. It leaves the college yard 10 min after the call, drives to the spot (road distance at 30 km/h), then continues the route; its real delay is computed per breakdown. Stranded students get rescue buses first.
  2. **Other buses** that pass within 1.5 km of the spot *after* the breakdown. A bus that has already passed can't pick anyone up.
  3. **Shared autos (pods of 4)** from the **nearest real taxi/auto stand on OpenStreetMap** (looked up when the breakdown is added). If none is mapped, the auto is "arranged by the transport cell".
  
  Exam students go first, earliest exam first, and the optimiser picks whatever reaches college **before the exam**. For example, it chose an auto (reaching 8:36) over a rescue bus 39 min late (after the 08:50 deadline).
- **Display:**
  - **Personal banner:** *"Your bus Puttur 06:45 broke down between Kalladka and B C Road Bus Station at 7:29 → stay at the bus: a shared auto (pod A1) … picks your group up at about 7:46; you'll reach college by 8:36, before your 09:00 exam."*
  - **Other screens:** "Broken down / Replacement bus" in Live Status, 🛠 on the map, "N stranded on the road, N with a pickup" in the banner, and the breakdown included in "Explain this plan".
- **Claude:** its context marks `brokeDownOnTheWay` trips (place, time, stranded count, rescue delay) and `strandedAtBreakdownSince` students. Their options already exclude buses that have passed the spot. The server safety check is unchanged, and a confirmed breakdown resets an older Claude decision to the optimiser, because it could seat people on the broken bus.

### Results (all tests passing, no console errors)
- **Breakdown alone, no crisis mode:**
  - 1 report → not confirmed; the same phone again → still 1; a 2nd phone → **confirmed** ("2 student reports") with a high alert.
  - Device ids are not exposed.
  - The Puttur student (boarded at stop 0, 09:00 exam) was treated as stranded at the spot and got the auto plan above. Students at risk of missing their exam **1 → 0**.
- **Full "Simulate exam day crisis"** (it now also breaks one more bus down on the way): students missing their exam **30 → 2**, without transport **94 → 0**, **27 students stranded on the road, all 27 with a pickup** (20 rescued by the depot bus, 39 min late).
- **Claude path on that saved state** (14/14): 27 students marked stranded; every on-the-way breakdown listed; stranded students offered only buses that reach the spot after the breakdown; the safety check and `applyClaude` agree with the optimiser.
- **Phone (375px):**
  - the Report button is 330×64 px; with GPS unavailable, the "between which stops" fallback appears with the 4 real segments, and the report goes through;
  - the admin breakdown section has no overflow and no tap target under 40px.
- **Reset:** clears the breakdowns, the student breakdown reports, the crisis and the simulated students, and keeps real riders.
- **Regression:** Vercel/Upstash 12/12.

### Bugs found and fixed
| # | Bug | Fix |
|---|---|---|
| 39 | A breakdown on the way was handled as "the bus never left": on-board students were sent back to their home stop's buses. | Riders before the breakdown point are stranded **at the spot**, from the breakdown time on; only buses still to pass the spot, a rescue bus or autos can pick them up. |
| 40 | Every replacement was a flat +15 min, whatever the distance. | A rescue bus's delay = dispatch + drive from the college yard to the spot, compared with the schedule. |
| 41 | The `.rb` click handler would have treated the new breakdown button as a "report" with no outcome. | Report handlers bind only to `.rb[data-out]`; the breakdown button has its own handler. |
| 42 | "Activate crisis" could overwrite a breakdown that students confirmed meanwhile. | Activation merges the server's breakdowns with the admin's (by trip). |
| 43 | The banner said "from the nearest auto stand" even when OpenStreetMap has none mapped within 6 km. | It says "arranged by the transport cell" unless a real stand was found. |
| 44 | The admin list ran the time into the source ("7:292 student reports"). | Line break between them. |

---

## 4. APIs and libraries used

| API / library | Used for | Key needed? |
|---|---|---|
| **Anthropic Claude API** (`claude-opus-5-5`, official `@anthropic-ai/sdk`) | Student assistant, evidence letter, **AI route discovery with the `web_search_20260209` server tool**, "Explain this plan", and **v6 crisis decisions** (streamed, structured JSON output with a schema, validated on the server by `api/_crisisCheck.js`). Uses server-side refusal fallback (`fallbacks: "default"`), `stop_reason` refusal/max_tokens checks, and resumes on `pause_turn`. | Yes: `ANTHROPIC_API_KEY`, on the server only (`.env` locally, Vercel env vars in production) |
| **OSRM** `alternatives` + via-point routes | Detours around a flooded road (Exam Day Crisis) | No |
| **OpenStreetMap Overpass API** | Real bus stops and stations (Dakshina Kannada), plus taxi/auto stands near the student | No |
| **OpenStreetMap Nominatim** | Village name → coordinates when no stop matches | No |
| **OSRM** (`router.project-osrm.org`) | Real road geometry and stop-to-stop travel times for each route | No |
| **Open-Meteo** | Live 6–9 am rain probability and temperature at the student's stop (a model feature) | No |
| **Google Maps directions link** (`travelmode=transit`) | "Every bus Google Maps knows" from the student's stop | No |
| **Upstash Redis REST** (on Vercel) / JSON file (locally) | Shared database for routes, reports, riders, alerts and operators | Vercel env vars |
| **Leaflet 1.9.4 + OSM tiles**, **Chart.js 4.4.1** | Map and admin charts | No |
| **Browser Notification API** | Alerts on the phone | No |

**In-house AI (`public/js/model.js`):**
- Bayesian MAP logistic regression for delay and cancellation risk;
- a demand estimate from registered riders and "too full" reports;
- a Beta-smoothed reliability score;
- a greedy bus-allocation optimiser;
- grouping riders into pods.

---

## 5. Where the data comes from (no fake data)

| Data | Source |
|---|---|
| Bus stops | OpenStreetMap, loaded live |
| Bus routes | Entered by the transport cell, or found by Claude with web search plus a cited source, or the **starter routes**. Starter routes use real places snapped to real OSM stops and real road times, but **sample departure times**: they are labelled "sample", and their source says to verify with the depot. |
| Reports, riders and alerts | Real students and admins, through the shared database |
| Weather | Open-Meteo, live |
| Phone numbers | Only those an admin enters as verified operators. None are invented. |

Honest limit: KSRTC and Mangaluru private buses publish **no open live-GPS or timetable API**. "Live status" therefore comes from crowd reports and transport-office overrides, and "every bus" is covered by the Google Maps transit link.

---

## 6. Run and deploy

```bash
npm install
npm start                     # http://localhost:5173  (data saved in data/db.json)
```
Optional: put `ANTHROPIC_API_KEY=...` in a `.env` file (git-ignored, loaded by `env.js` for local runs) to enable the Claude features. Without it, the on-device assistant, letter template and greedy crisis optimiser are used.

On Vercel:
1. Import the repo with framework preset "Other". `vercel.json` sets the output directory to `public/`, and `api/` holds the two functions.
2. Under Storage, connect **Upstash for Redis**. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`; without them, data is not kept.
3. **Required for login (v9):** `SESSION_SECRET` (a long random string), `ADMIN_ID`, `ADMIN_PASSWORD` and `STUDENT_CODE` (the college access code students need to sign up). Optionally add `ANTHROPIC_API_KEY`.
4. `ADMIN_PIN` is no longer used: the admin logs in with `ADMIN_ID` / `ADMIN_PASSWORD`. Give the judges those, or let them use guest emergency mode.

---

## v9: Login for students and the transport cell (sent as "v7")

### Prompt 12 (exact text)

```
v7: add login with an ID and password for students and admin. Keep it simple, we have
under an hour. Don't break any existing feature.

1. Admin (transport cell): login ID and password come from env variables ADMIN_ID and
   ADMIN_PASSWORD. Never put them in frontend code.
2. Students: login ID = their USN, plus a password.
   - Sign up needs USN + name + password + a college access code (env STUDENT_CODE), so
     outsiders can't create accounts.
   - Save passwords hashed with Node's crypto.scrypt and a random salt. Never store or
     return plain passwords.
   - Minimum 6-character password, and each USN can only register once.
   - Admin can see the student list and remove a student.
3. On login, the server returns a signed token (HMAC with env SESSION_SECRET), valid for
   7 days, stored in localStorage. Logout clears it.
4. Every POST to /api/data and /api/assistant needs a valid token. Student actions
   (report, I ride this bus) need a student token, and admin actions (routes, alerts,
   overrides, crisis) need an admin token. Otherwise return 401. Hide rider names from
   logged-out users.
5. Use the USN from the token for reports, so it's one report per student per bus per day.
6. A clean login screen with "Student" and "Transport cell" tabs, plus sign-up for
   students, a logout button, and the user's name and role in the top bar. Wrong password
   → a clear message. Block login for 1 minute after 5 wrong tries.
7. For local testing, put ADMIN_ID=admin, ADMIN_PASSWORD=Admin@123,
   STUDENT_CODE=SAHYADRI2026 and SESSION_SECRET in .env. Test: logged-out users can't
   report or use admin, students can't do admin actions, a wrong password fails, and
   everything works after login. Then push, and add this prompt to prompt.md.

8. Emergency access without login: anyone can open the app and use Route Finder, Live
   Status, Alternatives (other buses, nearby stops, verified autos with call buttons, taxi
   stands, Google Maps link), Alerts, the crisis banner and Ask AI (on-device answers only
   for guests, Claude for logged-in users). Show a small "Guest: emergency mode" label.
9. Guests can NOT report whether a bus came, register as a rider, or do any admin action.
   On the Report tab, show "Log in with your USN to report your bus" with a login button.
   Block this on the server too (401), not just in the UI.
```

### Prompt 13 (sent during v9, with a screenshot circling the top-bar Student/Admin toggle)
```
i want email id for students to login, rmove the marked portion
```
So students now **log in with their email address** instead of their USN, and the top-bar **Student / Admin toggle was removed**. The Admin view opens automatically when the transport cell logs in.

### How it works
- **`api/_auth.js`** (Node `crypto` only, no new packages):
  - student passwords use `scrypt` with a random 16-byte salt, and are compared in constant time;
  - tokens are `base64url(payload).HMAC-SHA256(SESSION_SECRET)` with `{sub, role, name, exp: 7 days}`;
  - the admin ID and password are compared in constant time with `ADMIN_ID` / `ADMIN_PASSWORD`, which live only on the server;
  - a student whom the admin removes stops being accepted immediately, even with an unexpired token.
- **`POST /api/auth`:**
  - `signup` requires a valid email, a name, a password of at least 6 characters, the correct `STUDENT_CODE`, and an email not already registered (409);
  - `login` works for students (email) and the admin (ID);
  - **5 wrong tries → blocked for 1 minute** (wrong sign-up codes are counted too). The counter is in the shared database, so it holds across Vercel instances.
- **`/api/data`:**
  - every POST needs `Authorization: Bearer <token>`, otherwise **401**;
  - `report`, `rider` and `breakdown` need a **student**, and the identity is **the email from the token**, never the request, so it's **one report per student per bus per day**;
  - every admin action (routes, alerts, overrides, config, operators, crisis, `deleteStudent`) needs the **transport cell**.
- **What guests see on GET:** everything needed in an emergency, but rider and reporter names show as "Student". The admin also gets the student list (email, name, date; no password data).
- **`/api/assistant`:** Claude chat needs a login; planning modes (route discovery, letter, explain, crisis decisions) need the admin. Guests get the on-device assistant.
- **UI:**
  - **Top bar:** "🆘 Guest: emergency mode · Log in", or "👤 Asha Rao · asha.rao@… · Student / 🚌 Transport cell (admin) · Log out".
  - **Login modal:** **Student / Transport cell** tabs and student sign-up.
  - **Report tab:** guests see **"🔒 Log in with your student email to report your bus"** with a login button; "I ride this bus" asks guests to log in.
  - **Admin:** a "🎓 Registered students" table with **Remove**.
  - **Guest mode:** Route Finder, Live Status, Alternatives (call buttons, taxi stands, Google Maps), Alerts, the crisis banner and on-device Ask AI keep working without login.

### Tests (all passing, no console errors)
**Server access rules, 34/34** (against the running server with the `.env` login values):
- **Guests:** every write (report, I ride this bus, breakdown, addRoute, alert, crisis) and Claude chat → 401.
- **Sign-up and login:**
  - a wrong access code → 401 "(4 tries left)"; a password under 6 characters → 400; an invalid email → 400;
  - a valid sign-up works, with `"  Asha.Rao@Sahyadri.EDU.in "` normalised to `asha.rao@sahyadri.edu.in`;
  - a second sign-up with the same email → 409;
  - a wrong password → 401 with tries left; the right password works.
- **Roles:** a student calling addRoute, crisis, deleteStudent or Claude crisis planning → 401; the admin filing a student report → 401.
- **Reports and riders:** the name comes from the account (a spoofed `clientId` and name are ignored); a second report by the same student replaces the first; "I ride this bus" works; guests see names hidden.
- **Admin and storage:** the admin's student list has no password data; the database file holds a 32-hex salt and a 128-hex hash, and **the plain password appears nowhere**.
- **Tokens:** a token edited to `role: admin` (bad signature) → 401; after the admin removes a student, that student's token → 401.
- **Lockout:** the 5th wrong try → "blocked for 1 minute"; the correct password during the lock → 429 "Try again in 60 s".

**Vercel/Upstash, 14/14:** login and sign-up through Upstash storage, a report without login → 401, and outage protection still holds.

**In the browser:**
- **Guest:** guest label shown; Report gate shown; Ask AI says "On-device assistant · log in to ask Claude"; the Admin view is never shown.
- **Logins:** a wrong admin password gives a clear message. A student signs up with email, is locked to their account name, reports a bus and registers as a rider. The admin lands on the Admin tab with the student list and can still browse every tab.
- **After logout:** the gates come back.
- **Existing features:** "Simulate exam day crisis" still works behind the admin login (missing exam 30 → 0, without transport 94 → 0, 7 stranded on the road, all picked up).

### Bugs found and fixed
| # | Bug | Fix |
|---|---|---|
| 45 | The login modal's role tabs reused the top bar's `.role` class, so the top-bar handler (`.role button` → `setRole`) **overwrote the "Transport cell" tab click**: it silently stayed on "Student". | Handlers are scoped to `.role button[data-role]` (later the top-bar toggle was removed entirely, Prompt 13). |
| 46 | My test hard-coded `STUDENT_CODE=SAHYADRI2026`, but `.env` had since been changed to a different code, so every sign-up failed and then locked for a minute (the lockout working as designed). | The test reads the login values from `.env`, and the user's `.env` was left as it is. |
| 47 | The admin chip read "Transport cell · admin · Transport cell". | "🚌 Transport cell (admin)". |
| 48 | Old `ADMIN_PIN` / `checkPin` code would conflict with token login. | Removed. Admin actions require the admin token. |

### Notes
- **Local test values** are in the git-ignored `.env`: `ADMIN_ID=admin`, `ADMIN_PASSWORD=Admin@123`, `STUDENT_CODE` (currently set in `.env`), and a random `SESSION_SECRET`. **Use different, strong values on Vercel.**
- The token is kept in `localStorage`, as requested. It is HMAC-signed and expires after 7 days; logout removes it.

### Prompt 14 (exact text)
```
remove college access code
```
Student sign-up now needs only email, name and password (at least 6 characters, one account per email). The `STUDENT_CODE` check, its field in the sign-up form and its lockout were removed; `STUDENT_CODE` is no longer needed on Vercel. Wrong-password lockout (5 tries → 1 minute) still applies to login.

### Prompt 15 (exact text)
```
there must be main page with attractive eyecatchy  login interface and what you made till now must be landing page after the login and also there must be alternative(emergency) login without id pass there must be alternative tab only
```
**What changed:**
- **Welcome page first:** a full-screen page (teal gradient, glass cards, an animated bus on a road; animation is off for users who prefer reduced motion) with three choices: **🎓 Student** (log in or sign up with email), **🚌 Transport cell** (admin login) and **🆘 Emergency access** (no ID or password).
- **After login:** the existing app is the landing page (students land on Route Finder, the transport cell on Admin). **Log out** returns to the welcome page.
- **Emergency access shows only the Alternatives tab**, with its own "📍 Where are you?" box (type a stop, or use GPS to pick the nearest real OpenStreetMap stop). It lists other buses, nearby-stop buses, verified autos with call buttons, taxi stands and the Google Maps transit link. The top bar shows "🆘 Emergency access · Log in · Exit"; **Exit** returns to the welcome page. The choice lasts only for the browser session.
- **Tested:** welcome page first; emergency shows only the `alt` tab and works for B C Road; Exit returns; student sign-up lands on Route Finder with all 7 student tabs; logout returns to the welcome page; phone layout stacks the cards; no console errors.

### Prompt 16 (exact text)
```
the dots are not visible in map
```
**Cause:** the map's stop dots come from OpenStreetMap's Overpass service, and every public Overpass server was failing (overpass-api.de answered 406, the mirrors timed out), so the app loaded 0 stops.
**Fix:**
- The app now ships a **bundled snapshot of real OpenStreetMap stops** (`public/data/osm-stops.json`, 102 named stops around Mangaluru, fetched 2026-11-13, © OpenStreetMap contributors, ODbL). The dots appear instantly.
- Live Overpass data replaces the snapshot when any of 4 public servers answers (all are tried in parallel).
- The dots are bigger (6 px stops, 8 px stations) with white outlines; stations are orange, and the legend explains the colours.
- **Tested:** with the live cache cleared and Overpass down, the map shows all 102 dots.

### Prompt 17 (exact text, with a screenshot circling the What-if card)
```
this does nothing i guess
```
**Cause:** the What-if card did change the forecast, but only in the forecast card far above it, and only after a stop with a registered bus route was picked. Nothing visible happened inside the card itself.
**Fix:** the card now shows its own result, comparing live conditions today with the chosen conditions. For example: *"Puttur – Mangaluru 8:22: 25% → 48% chance of delay with heavy rain (+23 points). Reasons: rain."*, and with next Monday, *"25% → 56% … rain + Monday rush"*. Without a stop or a nearby route, it says exactly what's missing.

### Prompt 18 (exact text, with a screenshot of "hi" getting the "Best bus" reply)
```
it is telling same for all the prompts
```
**Cause:** Claude can't answer yet (the Anthropic account has no credit), so the **on-device assistant** replied. It only knew 4 question types, and everything else, even "hi", got the same "Best bus" answer.
**Fix:** the on-device assistant now handles:
- greetings (by name) and "what can you do";
- thanks;
- weather and rain (live Open-Meteo);
- alerts and crisis status;
- travel groups;
- crowding;
- whether my bus is running;
- when to leave;
- best bus with a backup;
- delay risk with reasons;
- "what if it doesn't come";
- route reliability.

Anything else gets a help list instead of a wrong answer.
**Tested** (B C Road, starter routes): each of `hi`, `which bus should I take?`, `why is my bus risky?`, `when should I leave?`, `is my bus running?`, `what if my bus doesnt come?`, `which route is least reliable?` and `tell me a joke` got a different, matching answer.
