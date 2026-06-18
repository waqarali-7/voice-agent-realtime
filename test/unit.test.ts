/**
 * Unit tests — run with `npm test` (node:test, no extra deps).
 * Covers the pure/testable units: TwiML generation, host normalization, and
 * the message store's round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHost, incomingCallTwiml } from "../src/twiml.js";
import { JsonlMessageStore } from "../src/lib/messageStore.js";
import { toolDefinitions, dispatchTool } from "../src/tools.js";

test("resolveHost strips scheme and picks first forwarded host", () => {
  assert.equal(resolveHost({ host: "abc.ngrok.app" }), "abc.ngrok.app");
  assert.equal(
    resolveHost({ "x-forwarded-host": "https://abc.ngrok.app" }),
    "abc.ngrok.app"
  );
  assert.equal(
    resolveHost({ "x-forwarded-host": "a.com, b.com" }),
    "a.com"
  );
  assert.equal(resolveHost({ "x-forwarded-host": ["x.com", "y.com"] }), "x.com");
});

test("incomingCallTwiml builds a well-formed single-scheme stream url", () => {
  const xml = incomingCallTwiml("abc.ngrok.app");
  assert.match(xml, /<Stream url="wss:\/\/abc\.ngrok\.app\/media" \/>/);
  // guard against the classic double-scheme bug
  assert.doesNotMatch(xml, /wss:\/\/https/);
});

test("message store saves and lists round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "msgstore-"));
  const file = join(dir, "messages.jsonl");
  const store = new JsonlMessageStore(file);

  assert.deepEqual(await store.list(), []); // empty before any write

  const saved = await store.save({
    callerName: "Ali",
    callbackNumber: "0300-0000025",
    message: "Please call back about the order.",
    channel: "web",
  });
  assert.ok(saved.id);
  assert.ok(saved.takenAt);

  const all = await store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].callerName, "Ali");
  assert.equal(all[0].channel, "web");

  await rm(dir, { recursive: true, force: true });
});

test("take_message tool persists via the store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tooltest-"));
  const store = new JsonlMessageStore(join(dir, "m.jsonl"));

  const result = await dispatchTool(
    "take_message",
    {
      caller_name: "Sara",
      callback_number: "0311-1234567",
      message: "Asking about Saturday hours.",
    },
    { store, channel: "phone" }
  );

  assert.equal(result.output.status, "saved");
  const all = await store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].callerName, "Sara");

  await rm(dir, { recursive: true, force: true });
});

test("end_call tool signals the call should end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "endtest-"));
  const store = new JsonlMessageStore(join(dir, "m.jsonl"));
  const result = await dispatchTool("end_call", {}, { store, channel: "phone" });
  assert.equal(result.endCall, true);
  await rm(dir, { recursive: true, force: true });
});

test("unknown tool returns a structured error, never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unktest-"));
  const store = new JsonlMessageStore(join(dir, "m.jsonl"));
  const result = await dispatchTool("does_not_exist", {}, { store, channel: "web" });
  assert.equal(result.output.status, "error");
  await rm(dir, { recursive: true, force: true });
});

test("tool definitions expose the expected tools to the model", () => {
  const names = toolDefinitions().map((t) => t.name).sort();
  assert.deepEqual(names, ["end_call", "take_message"]);
});
