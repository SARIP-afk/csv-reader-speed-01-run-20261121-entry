// csv-reader-speed-01 entry: the program the harness runs (node /bot/main.ts,
// node22). It reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the
// cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.
//
// Before the cases, it warms the JIT up: solve.js is parsed cold in a fresh
// container, and its hot loops run interpreted until V8 optimises them. A few
// dozen runs over a small varied text -- quoted fields, doubled quotes, CRs
// inside quotes, stray CRs, junk after a closing quote, an unterminated
// quote, short and long rows, blank lines, a BOM, LF and CRLF -- get every
// path optimised for a few milliseconds, so the real cases run compiled
// instead of interpreted. The warmup's answers are thrown away; it changes
// no output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it.
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// A small varied text that exercises every path of solve.js: a header row,
// quoted commas, doubled quotes, CRs inside quotes, a stray CR, junk after a
// closing quote, a short row, a long row, a blank line, a plain CRLF line and
// an unterminated quote, under a BOM.
const WARMUP_TEXT =
  '\uFEFFh1,h2,h3,h4,h5,h6,h7,h8,h9\r\n' +
  'a,"b,c","d""e",f,"g\r\nh",i,1,2\r\n' +
  'x,y\rz,1,2,3,4,5,6,7\n' +
  '"q"junk,2,3,4,5,6,7,8,9\n' +
  'short,only\r\n' +
  'a,b,c,d,e,f,g,h,i,j,k\n' +
  '\n' +
  'f1,123.45,2020-01-01,AB-12345,word,hello world,"a, b","multi\nline",x\r\n' +
  '"unterminated,rest,of,line';
for (let i = 0; i < 25; i++) run({ text: WARMUP_TEXT, header: true });
for (let i = 0; i < 25; i++) run({ text: WARMUP_TEXT, header: false });

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
