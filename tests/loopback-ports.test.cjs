"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { listenFetchSafe, fetchSafePort } = require("../plugins/custom-api-models/scripts/loopback-ports.cjs");
class Server extends EventEmitter {
  constructor(ports) { super(); this.ports = ports; this.binds = 0; this.closes = 0; }
  listen(port, host) { assert.equal(port, 0); assert.equal(host, "127.0.0.1"); this.current = this.ports[this.binds++]; queueMicrotask(() => this.emit("listening")); }
  address() { return { port: this.current }; }
  close(done) { this.current = null; this.closes++; queueMicrotask(done); }
}
test("loopback binding skips Fetch-blocked OS-assigned ports without disabling protections", async () => {
  const server = new Server([10080, 6667, 32768]); assert.equal(await listenFetchSafe(server), 32768);
  assert.equal(server.binds, 3); assert.equal(server.closes, 2);
  for (const p of [0, 2049, 10080, -1, 65536, "32768"]) assert.equal(fetchSafePort(p), false);
});
test("loopback rebinding is bounded and closes every rejected listener", async () => {
  const server = new Server([6667, 6667, 6667]); await assert.rejects(listenFetchSafe(server, 3), /No fetch-compatible/);
  assert.equal(server.closes, 3); assert.equal(server.listenerCount("error"), 0); assert.equal(server.listenerCount("listening"), 0);
});
test("loopback bind failures propagate without retries or leaked listeners", async () => {
  const server = new Server([]); server.listen = () => queueMicrotask(() => server.emit("error", Error("bind failure")));
  await assert.rejects(listenFetchSafe(server), /bind failure/); assert.equal(server.listenerCount("listening"), 0);
});
