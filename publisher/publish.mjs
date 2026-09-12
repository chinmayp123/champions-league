#!/usr/bin/env node
// publisher — what the GitHub Actions cron runs every 5 minutes. The data layer (the same modules the
// desktop widget runs) builds the views and writes them to Firestore; the GitHub Pages site shows them.
//
//   node publisher/publish.mjs live    slate, match views, table, record, and slips tracked on the page
//                                      — free feeds only: the workflow gives this step NO odds keys
//   node publisher/publish.mjs keyed   the 10:00 card + builder, and closing prices near kickoff — the
//                                      only step with the odds keys, and rationed
//
// Every run is a fresh process, so the feed modules' in-memory caches start empty each time and their
// TTLs protect nothing. The keyed work is gated on a schedule persisted in Firestore (publisher/jobs)
// instead: OddsPapi's free tier is 250 calls a month (~4 per card or builder build, 2 books) and The
// Odds API's 500 credits are shared with Pick Six.
//
// Firestore layout, under competitions/<COMP.key>/:
//   view/slate · view/standings · view/menu · view/status                  public snapshots
//   games/<espnEventId>                                                    public match views
//   private/record · private/parlays                                       owner only (record, the day's picks)
//   slips/<auto>                                                           owner-created, consumed here
//   store/<log|predictions|pregame>                                        store.mjs records
//   publisher/jobs                                                         this script's schedule

import { createHash } from "node:crypto";
import * as store from "../store.mjs";
import * as lib from "../lib.mjs";
import * as betlog from "../betlog.mjs";
import * as parlays from "../parlays.mjs";
import { oddspapiUsage } from "../oddspapi.mjs";
import { COMP, compMeta } from "../competition.mjs";
import { connect } from "./firestore.mjs";

const MODE = process.argv[2];
if (MODE !== "live" && MODE !== "keyed") {
  console.error("usage: node publisher/publish.mjs live|keyed");
  process.exit(2);
}

const MIN = 60e3, HOUR = 60 * MIN;
const BUILD_BUDGET = 150e3; // stop starting match builds after this; the next run is 5 minutes away
const CLOSE_MARKETS = new Set(["Moneyline", "Total", "BTTS", "DNB", "TeamTotal", "Spread"]); // what captureClosing can price
const started = Date.now();
const say = (...a) => console.log(`[${MODE}]`, ...a);

const fb = await connect();
store.useRemote(fb.store);
await store.load();
const jobs = (await fb.readJson(["publisher", "jobs"])) || {};
jobs.hashes ||= {};
jobs.games ||= {};

// write a page snapshot only when its content changed — every write counts against the free quota
async function put(path, data) {
  const json = JSON.stringify(data);
  const key = path.join("/");
  const hash = createHash("sha1").update(json).digest("base64");
  if (jobs.hashes[key] === hash) return false;
  try {
    await fb.publish(path, json);
    jobs.hashes[key] = hash;
    return true;
  } catch (e) {
    say("could not publish", key, "-", e.message);
    return false;
  }
}

async function live() {
  const now = Date.now();

  // parlays tracked on the page since the last run → the bet log (dropped only after the log is saved)
  const slips = await fb.slips();
  for (const s of slips) {
    let res;
    try { res = await lib.trackParlay(JSON.parse(s.payload)); } catch (e) { res = { error: e.message }; }
    say("slip", s.id, res?.ok ? `logged (${res.legs} legs, ${res.date})` : `rejected: ${res?.error}`);
  }

  const matches = await lib.listMatchesData();
  if (matches.length) await put(["view", "slate"], { matches, comp: compMeta() });

  // which match views to (re)build this run, most urgent first
  const wentFinal = [];
  const due = [];
  for (const m of matches) {
    const kick = Date.parse(m.date), last = jobs.games[m.id];
    if (last && last.state !== "post" && m.state === "post") wentFinal.push(m.id);
    let pri = null;
    if (m.state === "in") pri = 0; // live: every run
    else if (m.state === "pre") {
      // confirmed XIs land about an hour out, so the last two hours refresh every run
      const lead = kick - now;
      const every = lead < 2 * HOUR ? 0 : lead < 36 * HOUR ? 30 * MIN : 12 * HOUR;
      if (!last || now - last.at >= every) pri = lead < 36 * HOUR ? 1 : 3;
    } else if (m.state === "post") {
      // at full time, and once more a couple of hours later when FotMob has settled ratings and xG
      if (!last || last.state !== "post") pri = 1;
      else if ((last.posts || 0) < 2 && now - last.at >= 2 * HOUR) pri = 2;
    }
    if (pri != null) due.push({ m, pri, kick });
  }
  due.sort((a, b) => a.pri - b.pri || Math.abs(a.kick - now) - Math.abs(b.kick - now));

  let built = 0, deferred = 0;
  for (const { m } of due) {
    if (Date.now() - started > BUILD_BUDGET) { deferred++; continue; }
    const state = await lib.getWidgetState(m.id);
    if (state.error || !state.match) { say("match", m.id, "failed:", state.error || "not found"); continue; }
    await put(["games", String(m.id)], { match: state.match });
    const prev = jobs.games[m.id];
    const posts = m.state === "post" ? (prev?.state === "post" ? (prev.posts || 0) + 1 : 1) : 0;
    jobs.games[m.id] = { at: Date.now(), state: m.state, posts };
    built++;
  }
  // forget games that have left the fixture pool
  const pool = new Set(matches.map((m) => String(m.id)));
  if (matches.length) {
    for (const id of Object.keys(jobs.games)) if (!pool.has(id)) delete jobs.games[id];
    for (const key of Object.keys(jobs.hashes)) if (key.startsWith("games/") && !pool.has(key.slice(6))) delete jobs.hashes[key];
  }

  if (wentFinal.length || !jobs.standingsAt || now - jobs.standingsAt >= 30 * MIN) {
    const st = await lib.getStandings();
    if (!st.error) { await put(["view", "standings"], st); jobs.standingsAt = now; }
  }
  // the record settles finished legs and grades the frozen predictions
  if (slips.length || wentFinal.length || !jobs.recordAt || now - jobs.recordAt >= HOUR) {
    const rec = await lib.getRecord();
    if (!rec.error) { await put(["private", "record"], rec); jobs.recordAt = now; }
  }

  const saved = await store.save();
  for (const s of slips) await fb.dropSlip(s.id);
  say(`slate ${matches.length} · built ${built}${deferred ? ` (${deferred} deferred)` : ""} · slips ${slips.length} · saved ${saved.join(", ") || "nothing"}`);
}

// the calendar date and hour in Los Angeles, where the 10:00 card is scheduled
function laClock(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(t).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

async function keyed() {
  const now = Date.now();
  const la = laClock(now);
  // OddsPapi's free calls are shared across competitions and with Pick Six: cap this one's month
  const month = la.date.slice(0, 7);
  if (jobs.oddspapi?.month !== month) jobs.oddspapi = { month, calls: 0 };
  oddspapiUsage.cap = Math.max(0, (COMP.oddspapiBudget ?? 60) - jobs.oddspapi.calls);
  const slate = (await fb.readJson(["view", "slate"]))?.matches || [];
  const nextKick = slate.filter((m) => m.state === "pre").map((m) => Date.parse(m.date)).filter((k) => k > now).sort((a, b) => a - b)[0] ?? null;

  if (jobs.cardDate !== la.date && la.hour >= 10) {
    // the morning card (morning.mjs's job): settle, build, record — and the builder from the same fetches
    await betlog.settle().catch(() => {});
    const card = await parlays.generateDailyParlays(10);
    betlog.recordDay(card);
    await put(["private", "parlays"], card);
    await put(["view", "menu"], await parlays.parlayMenu());
    jobs.cardDate = la.date;
    say(`card ${card.date}: ${(card.singles || []).filter((g) => g.bet).length} bets recorded`);
  } else if (jobs.cardDate === la.date && jobs.menuDate !== la.date && nextKick && nextKick - now <= 90 * MIN && laClock(nextKick).date === la.date) {
    // FanDuel's lines go up late, so rebuild the card view and the builder once before the day's first
    // kickoff. Display only — the recorded card stays the 10:00 one, as it was with morning.mjs.
    await put(["private", "parlays"], await parlays.generateDailyParlays(10));
    await put(["view", "menu"], await parlays.parlayMenu());
    jobs.menuDate = la.date;
    say("pre-kickoff card + builder refresh");
  }

  // closing prices (CLV) for pending legs inside captureClosing's window (45 min before → 30 after
  // kickoff), at most every 30 min, so a fresh process doesn't re-spend OddsPapi calls on every run
  const kickOf = new Map(slate.map((m) => [String(m.id), Date.parse(m.date)]));
  const waiting = (betlog.readLog().days || [])
    .flatMap((d) => d.parlays || []).filter((p) => !p.settled).flatMap((p) => p.legs || [])
    .filter((l) => l.closeMl == null && CLOSE_MARKETS.has(l.market) && kickOf.has(String(l.id)))
    .filter((l) => { const k = kickOf.get(String(l.id)); return now >= k - 45 * MIN && now <= k + 30 * MIN; });
  if (waiting.length && (!jobs.closingAt || now - jobs.closingAt >= 30 * MIN)) {
    jobs.closingAt = now;
    say("closing prices:", JSON.stringify(await betlog.captureClosing()));
  }

  const saved = await store.save();
  say(`saved ${saved.join(", ") || "nothing"}`);
}

try {
  await (MODE === "live" ? live() : keyed());
  jobs[`${MODE}At`] = Date.now();
  jobs[`${MODE}Error`] = null;
} catch (e) {
  jobs[`${MODE}Error`] = { at: Date.now(), message: String(e?.message || e) };
  console.error(e);
  process.exitCode = 1;
} finally {
  if (MODE === "keyed" && jobs.oddspapi) jobs.oddspapi.calls += oddspapiUsage.calls; // counted even if the run failed
  // the page's freshness chip reads this; the Odds API remainder shows how much quota is left
  await put(["view", "status"], {
    liveAt: jobs.liveAt ?? null, keyedAt: jobs.keyedAt ?? null,
    liveError: jobs.liveError ?? null, keyedError: jobs.keyedError ?? null,
    cardDate: jobs.cardDate ?? null, oddsRemaining: lib.oddsState.remaining,
    oddspapi: jobs.oddspapi ? { ...jobs.oddspapi, budget: COMP.oddspapiBudget ?? 60 } : null,
  });
  await fb.publish(["publisher", "jobs"], JSON.stringify(jobs)).catch((e) => say("could not save jobs:", e.message));
  await fb.close();
}
process.exit(process.exitCode ?? 0);
