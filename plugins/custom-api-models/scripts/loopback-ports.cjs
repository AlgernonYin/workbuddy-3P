"use strict";
// WHATWG Fetch bad-port table: https://fetch.spec.whatwg.org/#port-blocking
// Do not bypass Fetch's protections. Rebind if the OS selects a blocked port.
const badPorts = new Set([0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,
  109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,
  548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,5060,5061,6000,6566,
  6665,6666,6667,6668,6669,6697,10080]);
const fetchSafePort = p => Number.isInteger(p) && p > 0 && p <= 65535 && !badPorts.has(p);
async function listenFetchSafe(server, attempts = 32) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 128) throw Error("invalid loopback bind attempt limit");
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve, reject) => {
      const onError = e => { server.removeListener("listening", onListening); reject(e); };
      const onListening = () => { server.removeListener("error", onError); resolve(); };
      server.once("error", onError); server.once("listening", onListening); server.listen(0, "127.0.0.1");
    });
    const port = server.address()?.port;
    if (fetchSafePort(port)) return port;
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
  throw Error("No fetch-compatible loopback port available");
}
module.exports = { listenFetchSafe, fetchSafePort };
