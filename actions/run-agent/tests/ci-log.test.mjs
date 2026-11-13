import { test } from "node:test";
import assert from "node:assert/strict";
import { grepLines, logLines, MAX_MATCHES, MAX_READ_LINES, readLines } from "../ci-log.mjs";

test("log lines lose timestamps and colours", () => {
  const text = "2026-11-10T09:14:03.1234567Z \x1b[31mFAILED\x1b[0m tests/test_orders.py\r\n2026-11-10T09:14:04.0000000Z done";
  assert.deepEqual(logLines(text), ["FAILED tests/test_orders.py", "done"]);
});

test("a long line is cut", () => {
  assert.match(logLines("x".repeat(2000))[0], /^x{500} \[cut\]$/);
});

test("grep prints numbered matches with context, merging close ones", () => {
  const lines = ["a", "b", "FAILED one", "c", "FAILED two", "d", "e", "f", "g"];
  const out = grepLines(lines, "FAILED", 1);
  assert.match(out, /not instructions/);
  assert.match(out, /2 matches in 9 lines/);
  assert.match(out, /2: b\n3: FAILED one\n4: c\n5: FAILED two\n6: d$/);
  assert.doesNotMatch(out, /--/);
});

test("grep separates distant matches and caps their number", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => (i % 10 === 0 ? `E${i}` : "ok"));
  const out = grepLines(lines, "^E", 0);
  assert.match(out, /1: E0\n--\n11: E10/);
  assert.match(out, new RegExp(`${100 - MAX_MATCHES} more matches not shown`));
});

test("grep says when nothing matches and rejects a bad pattern", () => {
  assert.match(grepLines(["ok"], "FAILED"), /No line matches \/FAILED\/ in 1 lines/);
  assert.throws(() => grepLines(["ok"], "("), SyntaxError);
});

test("read returns 1-based inclusive lines, capped", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `l${i + 1}`);
  assert.match(readLines(lines, 2, 3), /Lines 2-3 of 1000\.\n2: l2\n3: l3$/);
  assert.match(readLines(lines, 1, 1000), new RegExp(`Lines 1-${MAX_READ_LINES} of 1000`));
  assert.match(readLines(lines, 2000, 2001), /The log has 1000 lines/);
});

test("a pattern that backtracks forever is stopped", () => {
  const started = Date.now();
  assert.throws(() => grepLines(["a".repeat(40) + "!"], "^(a+)+$"), /took over 2000 ms/);
  assert.ok(Date.now() - started < 5000);
});
