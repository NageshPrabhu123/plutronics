// Serverless function (Vercel: /api/assistant, local: server.js) — RouteLess AI powered by Claude.
// The API key stays on the server (env ANTHROPIC_API_KEY); the browser only sends live app context.
// modes: chat (student Q&A), letter (evidence letter to KSRTC), discover (find REAL bus services with web search)
import Anthropic from "@anthropic-ai/sdk";
import { readJson, send, load } from "./_store.js";
import { userFrom } from "./_auth.js";
import { checkCrisisPlan, mergeWithGreedy } from "./_crisisCheck.js";

// Vercel functions here may run at most 60 s (vercel.json). Claude's crisis decision gets 50 s, then we fall back.
const CRISIS_TIMEOUT_MS = 50_000;

const MODEL = "claude-opus-5-5";

const SYSTEM = `You are RouteLess, a transport assistant for rural college students in Dakshina Kannada (Mangaluru region), India, who depend on KSRTC and private buses.
You receive LIVE JSON from the RouteLess app: bus routes registered by the college transport cell, real student "bus came / didn't come" reports, AI delay forecasts (logistic regression trained on those reports + live rain forecast), live statuses, registered riders, route reliability scores and verified alternative transport.
Rules:
- Ground every claim in the JSON. Quote exact times, risk percentages and reliability grades, and say how many real reports a number is based on. Never invent buses, timings, phone numbers or numbers. If the data has no route or no reports, say so plainly and suggest the Google Maps transit link or adding the route.
- Be short and practical: a student is reading this on a phone at a bus stop. Plain text, no markdown headings, at most ~120 words unless asked for more.
- Give a concrete recommendation and one fallback. Safety first: prefer verified options and travelling in groups early morning or in heavy rain.
- If the student writes in Kannada, reply in simple Kannada.`;

const LETTER_TASK = `Using ONLY the evidence JSON above (real student reports collected by RouteLess), draft a formal, polite letter from the college's Student Transport Committee to the KSRTC Depot Manager, Mangaluru Division, requesting additional or standby buses on this route.
Cite the reliability score, number of student reports, late and non-arrival counts, crowding reports and the rainy-vs-dry comparison if present. If the sample is small, say so honestly. Propose 3 specific, low-cost actions. Plain text, under 280 words.`;

const EXPLAIN_TASK = `The JSON above is an Exam Day Crisis plan produced by RouteLess's optimiser (bus breakdowns, demand surge, a flooded road, students with exams within 2 hours).
Explain the plan to the college transport cell in plain language: what went wrong, what the optimiser did (replacement buses, detours, re-seating with exam students first, shared-auto pods) and the before → after numbers.
Name the remaining risk honestly and suggest 2 concrete actions for the people on the ground. If "simulated" is true, say it is a simulated drill. Plain text, under 180 words. Use ONLY the numbers in the JSON.`;

// v6 — Claude decides the Exam Day Crisis plan. The server validates it (api/_crisisCheck.js) before it is used.
const CRISIS_SYSTEM = `You are the dispatcher for a college transport cell on an exam day crisis in rural Dakshina Kannada, India.
You get JSON: trips (seats, broken, blocked road + detour minutes, arrival time), spare depot buses, trips allowed to lend their bus (donorCandidates), shared autos (pods of up to rules.podSize students), and every student with their exam time ("" = no exam) and the ONLY options they can use:
opts = [tripId, boardTime, arriveCollegeTime, note]. note "ifReplaced" = that trip is broken and only runs if you move a bus onto it (it then leaves 15 min late, already included in the times). note "nearby x km" = the student must first get to a nearby stop.
auto = [departTime, arriveTime] if a shared auto from their stop is possible.
Some buses broke down ON THE WAY (trips with "brokeDownOnTheWay"). Students with "strandedAtBreakdownSince" are standing at that breakdown spot (their "stop" is the spot): they are the most vulnerable, so get them moving first; their opts only contain buses that still pass the spot after the breakdown, and a rescue bus on their own trip arrives "rescueDelayMin" late.
You also get "greedy": the plan of our on-device greedy optimiser and its results. Try to beat it; never do worse.

Decide:
1. busMoves: which bus replaces each broken trip — from "depot" (at most resources.spareBuses) or from a donorCandidates trip (that trip then has 0 seats, its students need other options). Only onto broken trips.
2. assignments: ONLY the students whose seat you change compared with greedy.assign (everyone you leave out keeps their greedy seat):
   {"student":"S1","bus":"T4","auto":""} or {"student":"S2","bus":"","auto":"A7"} or both "" for no transport. Keep this list short.
   If you change busMoves, re-seat every student whose greedy seat is no longer valid. Never exceed a trip's seats. A broken trip has 0 seats unless a busMove replaces it. Use only the student's own opts. Autos: at most resources.autos distinct auto ids, at most podSize students each, put students from the same or nearby stop together.
3. Priority: first minimise students who reach college later than (exam time − rules.examBufferMin) or not at all; earliest exams first. Then minimise students without any transport.
4. studentsMissingExam: ids of exam students who still cannot make it. studentsWithoutTransport: ids with no transport.
5. reasons: 3–6 short plain-English sentences for the transport cell, using bus names (not T/S ids), explaining the key decisions and the trade-offs.
Reply with ONLY the JSON object.`;

const CRISIS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["assignments", "busMoves", "reasons", "studentsMissingExam", "studentsWithoutTransport"],
  properties: {
    assignments: { type: "array", items: { type: "object", additionalProperties: false, required: ["student", "bus", "auto"], properties: { student: { type: "string" }, bus: { type: "string" }, auto: { type: "string" } } } },
    busMoves: { type: "array", items: { type: "object", additionalProperties: false, required: ["from", "to", "reason"], properties: { from: { type: "string" }, to: { type: "string" }, reason: { type: "string" } } } },
    reasons: { type: "array", items: { type: "string" } },
    studentsMissingExam: { type: "array", items: { type: "string" } },
    studentsWithoutTransport: { type: "array", items: { type: "string" } },
  },
};

const parseJson = (t) => { try { return JSON.parse(t); } catch { const m = String(t).match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } } };

const DISCOVER_SYSTEM = `You research REAL bus services in Dakshina Kannada, Karnataka, India for a student transport app. Use web search. Only report services you found evidence for on the web (KSRTC timetables, news, bus-timing sites, forums). Never invent route numbers or timings. If timings are unknown, leave departures empty.`;

function discoverTask(from, to) {
  return `Find real bus services (KSRTC and private) that students can take from "${from}" to "${to}" (Dakshina Kannada, Karnataka) in the morning.
Reply with ONLY a JSON array (no prose), each item:
{"code":"route name or number as people call it, e.g. 'KSRTC Puttur–Mangaluru'","operator":"KSRTC|Private|City bus","via":["ordered list of real place names the bus passes, first = boarding place, last = destination"],"departures":["HH:MM morning departure times from the first place, only if found"],"frequency":"text if only frequency is known","source":"URL where you found it"}
Return [] if nothing reliable is found. Max 6 items.`;
}

const apiMessage = (err) => String(err?.error?.error?.message || err?.message || err);
const textOf = (msg) => msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

export default async function handler(req, res) {
  if (req.method === "GET") return send(res, 200, { available: !!process.env.ANTHROPIC_API_KEY, model: MODEL });
  if (req.method !== "POST") return send(res, 405, { error: "GET or POST" });
  // v9: Claude is for logged-in users only (guests get the on-device assistant); planning modes are admin-only
  let db = null; try { db = await load(); } catch {}
  const user = userFrom(req, db);
  if (!user) return send(res, 401, { error: "Please log in to use Claude (guests get the on-device assistant)." });
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: "bad json" }); }
  const { mode = "chat", question = "", context = {}, from = "", to = "" } = body;
  if (mode !== "chat" && user.role !== "admin") return send(res, 401, { error: "Transport cell (admin) login required." });
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 501, { error: "ANTHROPIC_API_KEY not configured on the server" });
  const client = new Anthropic();
  const common = { model: MODEL, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

  try {
    if (mode === "crisis") {
      const ctx = context || {};
      if (!Array.isArray(ctx.students) || !Array.isArray(ctx.trips) || ctx.students.length > 800 || ctx.trips.length > 200) return send(res, 400, { error: "bad crisis context" });
      // streamed (the SDK refuses a large max_tokens without streaming); one shared deadline for all attempts
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), CRISIS_TIMEOUT_MS);
      const req = (withSchema) => client.beta.messages.stream({
        ...common, max_tokens: 16000, system: CRISIS_SYSTEM,
        output_config: withSchema ? { effort: "low", format: { type: "json_schema", schema: CRISIS_SCHEMA } } : { effort: "low" },
        messages: [{ role: "user", content: JSON.stringify(ctx) }],
      }, { signal: ac.signal, maxRetries: 0 }).finalMessage();
      let msg, structured = true;
      try {
        try { msg = await req(true); }
        catch (e) { // only when the structured-output format itself is rejected: retry with plain JSON instructions
          if (e instanceof Anthropic.BadRequestError && /format|schema|output_config/i.test(apiMessage(e))) { structured = false; msg = await req(false); } else throw e;
        }
      } catch (e) {
        if (ac.signal.aborted || e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionTimeoutError) // timeout → caller falls back to the optimiser
          return send(res, 200, { ok: false, timeout: true, check: { ok: false, errors: [`Claude did not answer within ${CRISIS_TIMEOUT_MS / 1000} s`] } });
        throw e;
      } finally { clearTimeout(timer); }
      if (msg.stop_reason === "refusal") return send(res, 200, { ok: false, check: { ok: false, errors: ["Claude declined this request"] }, model: msg.model });
      if (msg.stop_reason === "max_tokens") return send(res, 200, { ok: false, check: { ok: false, errors: ["Claude's answer was cut off (too long)"] }, model: msg.model });
      const plan = mergeWithGreedy(ctx, parseJson(textOf(msg)));
      const check = checkCrisisPlan(ctx, plan);
      return send(res, 200, { ok: check.ok, plan: check.ok ? plan : null, reasons: plan?.reasons || [], changed: plan?.changed ?? 0, check, model: msg.model, structured });
    }
    if (mode === "discover") {
      if (!String(from).trim()) return send(res, 400, { error: "from required" });
      const messages = [{ role: "user", content: discoverTask(String(from).slice(0, 100), String(to || "Sahyadri College, Adyar, Mangaluru").slice(0, 100)) }];
      let msg;
      for (let i = 0; i < 4; i++) { // server tools may pause long turns — resume
        msg = await client.beta.messages.create({ ...common, max_tokens: 16000, output_config: { effort: "medium" }, system: DISCOVER_SYSTEM, tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }], messages });
        if (msg.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: msg.content });
      }
      if (msg.stop_reason === "refusal") return send(res, 200, { services: [], note: "refused" });
      const t = textOf(msg); const m = t.match(/\[[\s\S]*\]/);
      let services = []; try { services = m ? JSON.parse(m[0]) : []; } catch { services = []; }
      return send(res, 200, { services: Array.isArray(services) ? services.slice(0, 6) : [], model: msg.model });
    }

    if (mode === "chat" && !String(question).trim()) return send(res, 400, { error: "empty question" });
    const msg = await client.beta.messages.create({
      ...common, max_tokens: 4000, output_config: { effort: "low" }, system: SYSTEM,
      messages: [{ role: "user", content: `LIVE ROUTELESS DATA (JSON):\n${JSON.stringify(context)}\n\n${mode === "letter" ? LETTER_TASK : mode === "explain" ? EXPLAIN_TASK : `Student question: ${String(question).slice(0, 1000)}`}` }],
    });
    if (msg.stop_reason === "refusal") return send(res, 200, { answer: "Sorry, I can't help with that. Ask me about buses, routes or alternatives.", model: msg.model });
    return send(res, 200, { answer: textOf(msg), model: msg.model });
  } catch (err) {
    return send(res, err instanceof Anthropic.APIError ? 502 : 500, { error: apiMessage(err).slice(0, 300) });
  }
}
