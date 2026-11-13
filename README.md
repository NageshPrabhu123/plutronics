# 🚌 RouteLess: The Last Mile

**Live app:** _link coming soon_ · **Prompts & iterations:** [prompt.md](prompt.md)

## ⏱ Demo in 2 minutes
Works on a phone. Without logging in, anyone can use **guest emergency mode**: Route Finder, Live Status, Alternatives, Alerts, the crisis banner and on-device Ask AI. **Log in** (top bar) as the **🚌 Transport cell** with the admin ID and password from the server settings, or as a **🎓 Student** with email, password and the college access code.

1. **Load starter routes.** Tap **Log in → 🚌 Transport cell**, then **Admin → 🚀 Load starter routes**. (Log out and **sign up as a student** for steps 2–3; log back in as the transport cell for steps 4–7.) This adds 4 real routes (Puttur, Vitla, Moodbidri, B.C. Road → Sahyadri College) on real roads; the timings are samples.
2. **Pick a stop.** Tap **Student → My bus stop**, type `B C Road`, choose a Puttur bus, tick **📝 I have an exam today** (09:00) and tap **I ride this bus**. The forecast card shows the % chance the bus is late.
3. **Report a bus.** Tap **✋ Report → ❌ Didn't come**. The AI retrains, and the risk, status and reliability grade change immediately. (There is also **🛠 Broke down on the way**: students already on board get a pickup *at the breakdown spot*.)
4. **Simulate exam day crisis.** Tap **Admin → ⚡ Simulate exam day crisis**. In about 20–40 s: 2 KSRTC buses break down, **one more bus breaks down on the way** (its passengers are stranded at the spot), demand rises 40%, the B C Road ↔ Farangipete road floods (OSRM finds a detour), and 120 simulated students are added (40% with exams).
5. **Show before → after** (right under the buttons):
   - **students who would miss their exam 27 → 0**;
   - **students without transport 81 → 0**;
   - **"Decided by Claude"** or **"Decided by on-device optimiser"** (the server checks Claude's plan; without an API key, or on timeout, the optimiser decides).
6. **Show the student banner.** Switch to **Student**. The red banner shows *your* plan, for example: *"Your bus Puttur 06:45 is broken down → take B.C. Road 07:20 at 7:20, you'll reach by 7:59, before your 09:00 exam."*
7. **Reset.** Tap **Admin → Reset crisis**. The crisis, the simulated students and the crisis alerts are removed.

Rural students often wait an hour for a bus that never comes. With RouteLess, students tap **"bus came / didn't come"**. The app learns how reliable each route really is and forecasts:

> **"34% chance the 8:31 Puttur – Mangaluru is late or doesn't come today — rain + Monday rush."**

Every route also gets an A–F reliability score, built from real reports, that the college can send to KSRTC as evidence.

**No fake data.** RouteLess uses only these sources:
- **Bus stops:** OpenStreetMap, loaded live.
- **Road times:** OSRM.
- **Weather:** live from Open-Meteo.
- **Routes, reports and riders:** entered by real users into a shared database.

KSRTC and private buses have no open live-GPS API, so "live status" comes from crowd reports and transport-office updates. A Google Maps transit link covers every other bus.

## Features
- **Route Finder:** pick a real stop, then see buses ranked by risk and arrival time, with an AI pick, a map and a what-if for rain or day.
- **Delay forecast:** a Bayesian logistic regression that learns from real reports. It uses live rain, market day, Monday, exam week and the first trip of the day, and shows "prior estimate" until reports exist.
- **Live Status:** Available, Delayed, Cancelled or Full, from today's reports, then transport-office overrides, then the AI forecast. Data refreshes every 20 s, and the app shows "offline" if the server is down.
- **Report:** one tap, one report per phone per bus per day. The AI retrains instantly, and 2+ "didn't come" reports trigger an automatic alert.
- **Alternatives:** other buses, buses at nearby stops, verified operators, OSM taxi/auto stands and the Google Maps transit link.
- **Groups:** registered riders on the same bus with nearby stops form pods of 4, with a one-click backup plan.
- **Ask AI:** Claude, grounded in the live data. Falls back to an on-device assistant when no API key is set.
- **Admin:**
  - Load starter routes
  - Add a route (real OSM stops plus OSRM routing)
  - **AI route discovery** (Claude + web search, with sources)
  - Status overrides, alerts, bus allocation and exam-week setting
  - Learned-weights chart and evidence letter
  - Verified operators

## 🚨 Surprise Hurdle: Exam Day Crisis
Admin → **⚡ Simulate exam day crisis** sets up the whole scenario, all labelled "simulated":
- 2 KSRTC trips break down, demand rises 40%, and a road floods (OSRM finds a detour);
- 120 simulated students are added, 40% of them with exams within 2 hours.

The optimiser then re-plans every seat:
- exam students are seated first, earliest exam first;
- broken buses are replaced by depot or under-used buses;
- other students take the next bus, a nearby-stop bus or a shared-auto pod.

**A bus breaking down on the way** is handled too. Students already on board are stranded at the spot, and they get a rescue bus (timed by road distance), a bus that still passes the spot, or a shared auto from the nearest real auto stand. Exam students go first. Students report it with **🛠 Broke down on the way**; 2 phones confirm it automatically, or the transport cell confirms it.

It shows **students missing their exam X → Y** and **students without transport X → Y**. With an API key, **Claude also decides the plan**; the server checks Claude's plan and the better plan wins. Every student sees a red banner with their personal plan and "Decided by Claude / on-device optimiser". "Reset crisis" restores everything. Details are in [prompt.md](prompt.md#-surprise-hurdle-the-exam-day-crisis-v5--v6).

## 🔐 Login
- **Students:** email + password. Sign-up needs the college access code (`STUDENT_CODE`). Passwords are stored as salted `scrypt` hashes.
- **Transport cell:** `ADMIN_ID` / `ADMIN_PASSWORD` from server environment variables.
- **Session:** a signed 7-day token. Every change (report, "I ride this bus", any admin action) needs it, and the server answers **401** otherwise. 5 wrong passwords → 1-minute lock.
- **Guests:** emergency mode works without login; names of other students are hidden.

## Run
```bash
npm install
npm start          # http://localhost:5173
```
Optional: create a `.env` file containing `ANTHROPIC_API_KEY=...` for the Claude features. It is git-ignored and only loaded locally; on Vercel, use environment variables. The app works fully without it.

## Demo in 1 minute
1. **Admin → Load starter routes.** This adds 4 routes between real places. Their departure times are **samples**.
2. **Student → My bus stop.** Type "Farangipete" or "B C Road", or tap a stop on the map.
3. Read the forecast, then go to **Report → Didn't come**. The risk, status and reliability update immediately.

## Deploy (Vercel)
1. Import the repo with framework preset **Other**. `vercel.json` already sets the output directory to `public/`, and `api/` holds the two functions.
2. Storage → connect **Upstash for Redis**. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Without it, reports are not kept between visits.
3. Optional: add `ANTHROPIC_API_KEY` for Claude chat, the evidence letter and AI route discovery.
4. **Login settings (required):** `SESSION_SECRET` (a long random string), `ADMIN_ID`, `ADMIN_PASSWORD` and `STUDENT_CODE` (the access code students need to sign up). Use strong values, and never put them in the code.

Works on phones: tested at 375px with no sideways scrolling, 44px tap targets, and tables shown as cards.

All prompts, iterations, APIs and bugs fixed are in **[prompt.md](prompt.md)**.
