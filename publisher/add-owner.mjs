#!/usr/bin/env node
// Enrol a Google account as the website's owner: it can read the bet record and the day's card, and
// the builder can track slips. The rules let only the publisher account write /owners, so this runs
// with the publisher login. The page shows the uid when a signed-in account isn't enrolled.
//
//   node publisher/add-owner.mjs <uid>
//   node publisher/add-owner.mjs --remove <uid>

import { connect } from "./firestore.mjs";

const remove = process.argv.includes("--remove");
const uid = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!uid || !/^[A-Za-z0-9]{20,128}$/.test(uid)) {
  console.error("usage: node publisher/add-owner.mjs [--remove] <uid>");
  process.exit(2);
}

const fb = await connect();
try {
  await fb.setOwner(uid, !remove);
  console.log(remove ? `removed owner ${uid}` : `enrolled owner ${uid}`);
} catch (e) {
  console.error(e.code === "permission-denied" && !remove ? `${uid} is already enrolled (or the rules refused)` : e.message);
  process.exitCode = 1;
} finally {
  await fb.close();
}
process.exit(process.exitCode ?? 0);
