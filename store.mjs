// store — where the app's own records live: the bet log, the predictions scorecard and the pregame
// snapshots. One synchronous get/set in front of two backends, so the data layer's call sites stay
// exactly as they were:
//
//   file    (default) JSON files under COMP.betlogDir — the desktop widget, cli.mjs, morning.mjs
//   remote  whatever useRemote() was handed — the GitHub Actions publisher plugs in Firestore
//
// A remote backend is async, so its owner calls load() before running the data layer (which then
// reads and writes in-memory copies) and save() afterwards, which writes only the records that
// changed. The publisher is the only writer — one workflow run at a time — so there's no merging.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMP } from "./competition.mjs";

const FILES = { log: "log.json", predictions: "predictions.json", pregame: "pregame.json" };
export const RECORDS = Object.keys(FILES);
export const recordFile = (name) => join(COMP.betlogDir, FILES[name]);
const PRETTY = new Set(["log"]); // log.json stays hand-readable on disk, as it always was

let remote = null;     // { load(names) → Promise<{ [name]: data|null }>, save(name, data) → Promise }
const mem = new Map(); // name → { data, dirty }

export function useRemote(backend) { remote = backend; mem.clear(); }

export function get(name, fallback) {
  if (!remote) {
    try { return JSON.parse(readFileSync(recordFile(name), "utf8")); } catch { return structuredClone(fallback); }
  }
  // hand out a copy: callers mutate what they read and then set() it, like they did with files
  return structuredClone(mem.get(name)?.data ?? fallback);
}

export function set(name, data) {
  if (!remote) {
    const file = recordFile(name);
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, PRETTY.has(name) ? JSON.stringify(data, null, 2) : JSON.stringify(data));
    return;
  }
  mem.set(name, { data: structuredClone(data), dirty: true });
}

export async function load() {
  if (!remote) return;
  const got = await remote.load(RECORDS);
  for (const name of RECORDS) mem.set(name, { data: got[name] ?? null, dirty: false });
}

export async function save() {
  if (!remote) return [];
  const saved = [];
  for (const [name, e] of mem) {
    if (!e.dirty) continue;
    await remote.save(name, e.data);
    e.dirty = false;
    saved.push(name);
  }
  return saved;
}
