// Checks the stored nostr-bch-bind v1 vectors (test/bind-vectors.json) against the verifier, without regenerating them.
// `node src/bind.mjs` rewrites the file from the same fixed test keys; this test only reads it.
import { readFileSync } from 'node:fs';
import { verifyBinding, resolve } from '../src/bindverify.mjs';

const { vectors } = JSON.parse(readFileSync(new URL('./bind-vectors.json', import.meta.url)));
let pass = 0, fail = 0;
for (const v of vectors) {
  const r = v.events ? resolve(v.events, v.result?.addr ?? v.events[0].tags.find((t) => t[0] === 'i')?.[1]?.slice(4)) : verifyBinding(v.event);
  const same = r.ok === v.expect && (r.ok || r.reason === v.result.reason);
  same ? pass++ : fail++;
  console.log(same ? 'ok  ' : 'FAIL', v.name, '->', r.ok ? 'valid' : r.reason);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail || !vectors.length ? 1 : 0);
