#!/usr/bin/env node
// One-off: copy the desktop app's records (bets/<competition>/log.json, predictions.json,
// pregame.json) into Firestore so the Pages site starts with the full history. A record Firestore
// already has is left alone unless --force.
//
//   node publisher/import-logs.mjs [--force]

import { existsSync, readFileSync } from "node:fs";
import { RECORDS, recordFile } from "../store.mjs";
import { connect } from "./firestore.mjs";

const force = process.argv.includes("--force");
const fb = await connect();
try {
  const have = await fb.store.load(RECORDS);
  for (const name of RECORDS) {
    const file = recordFile(name);
    if (!existsSync(file)) { console.log(`${name}: no ${file}`); continue; }
    if (have[name] && !force) { console.log(`${name}: already in Firestore (use --force to replace)`); continue; }
    const data = JSON.parse(readFileSync(file, "utf8"));
    await fb.store.save(name, data);
    const size = Array.isArray(data.days) ? `${data.days.length} days` : `${Object.keys(data).length} entries`;
    console.log(`${name}: imported ${size}`);
  }
} finally {
  await fb.close();
}
process.exit(0);
