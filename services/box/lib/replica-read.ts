// replica-read.ts — read-only probe over the stripped replica, reusing the SHIPPED
// @lares/network query functions so the box read path == the Mac read path.
import { openDbReadOnly } from "@lares/network/lib/db.js";
import { whoAt, dormantQueue, personProfile } from "@lares/network/lib/queries.js";

const [dbPath, verb, ...rest] = process.argv.slice(2);
if (!dbPath || !verb) {
  console.error("usage: replica-read <db> who-at <company> | dormant | person <name>");
  process.exit(2);
}
const db = openDbReadOnly(dbPath);
try {
  if (verb === "who-at") console.log(JSON.stringify(whoAt(db, rest.join(" "))));
  else if (verb === "dormant") console.log(JSON.stringify(dormantQueue(db, 25)));
  else if (verb === "person") console.log(JSON.stringify(personProfile(db, rest.join(" "))));
  else { console.error(`unknown verb: ${verb}`); process.exit(2); }
} finally {
  db.close();
}
