// Firestore for the publisher. Signs in as the publisher account (email/password — firestore.rules
// lets only that account write the snapshots and records) and hands back:
//   store     store.mjs's remote backend: each record is gzipped JSON in a bytes field
//   publish   a snapshot the page reads: plain JSON text, so the browser needs only JSON.parse
//   readJson  read one of those back (the publisher's own schedule, the slate)
//   slips     parlays the owner tracked on the page, waiting to be logged
//
// Credentials: FUTBOL_PUBLISHER_EMAIL / FUTBOL_PUBLISHER_PASSWORD (the workflow's secrets), or
// publisher/credentials.json { "email", "password" } when run by hand (gitignored).

import { readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  getFirestore, terminate, doc, getDoc, setDoc, deleteDoc, collection, getDocs, Bytes, serverTimestamp,
} from "firebase/firestore";
import { firebaseConfig } from "../web/firebase-config.js";
import { COMP } from "../competition.mjs";

const DOC_CAP = 1_000_000; // Firestore's per-document limit is 1 MiB, fields and names included

function credentials() {
  const { FUTBOL_PUBLISHER_EMAIL: email, FUTBOL_PUBLISHER_PASSWORD: password } = process.env;
  if (email && password) return { email, password };
  try { return JSON.parse(readFileSync(new URL("./credentials.json", import.meta.url), "utf8")); }
  catch { throw new Error("no publisher login: set FUTBOL_PUBLISHER_EMAIL + FUTBOL_PUBLISHER_PASSWORD or write publisher/credentials.json"); }
}

export async function connect() {
  const { email, password } = credentials();
  const app = initializeApp(firebaseConfig);
  const { user } = await signInWithEmailAndPassword(getAuth(app), email, password);
  const db = getFirestore(app);
  // everything lives under the active competition, so a new tournament starts clean
  const ref = (path) => doc(db, "competitions", COMP.key, ...path);

  return {
    uid: user.uid,
    store: {
      async load(names) {
        const out = {};
        await Promise.all(names.map(async (name) => {
          const snap = await getDoc(ref(["store", name]));
          out[name] = snap.exists() ? JSON.parse(gunzipSync(snap.get("gz").toUint8Array()).toString("utf8")) : null;
        }));
        return out;
      },
      async save(name, data) {
        const json = JSON.stringify(data);
        const gz = gzipSync(json);
        if (gz.length > DOC_CAP - 1024) throw new Error(`record ${name} is ${gz.length} bytes gzipped, over the 1 MiB doc cap`);
        await setDoc(ref(["store", name]), { gz: Bytes.fromUint8Array(gz), bytes: Buffer.byteLength(json), savedAt: serverTimestamp() });
      },
    },
    async publish(path, json) {
      const bytes = Buffer.byteLength(json);
      if (bytes > DOC_CAP - 1024) throw new Error(`${path.join("/")} is ${bytes} bytes, over the 1 MiB doc cap`);
      await setDoc(ref(path), { json, bytes, publishedAt: serverTimestamp() });
    },
    async readJson(path) {
      const snap = await getDoc(ref(path));
      return snap.exists() ? JSON.parse(snap.get("json")) : null;
    },
    async slips() {
      const q = await getDocs(collection(db, "competitions", COMP.key, "slips"));
      return q.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    dropSlip: (id) => deleteDoc(ref(["slips", id])),
    // /owners/{uid} (top level — owners aren't per competition)
    setOwner: (uid, enrolled) => (enrolled ? setDoc(doc(db, "owners", uid), { addedAt: serverTimestamp() }) : deleteDoc(doc(db, "owners", uid))),
    async close() { await terminate(db); await deleteApp(app); },
  };
}
