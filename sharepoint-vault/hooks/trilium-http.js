// One request to Trilium's ETAPI, for the hooks and the MCP server alike.
// The certificate is never checked: Dennis' Trilium runs with a self-signed
// one and he chose (23-11-2026) that Trilium never needs a valid one. Only
// these requests skip the check, not the rest of the process.
const http = require("node:http");
const https = require("node:https");

/** Resolves { ok, status, text }; rejects with name "TimeoutError" when the
 *  time is up, else with the network error as cause (cause.code: ECONNREFUSED…). */
function triliumRequest(url, { method = "GET", headers = {}, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      return reject(Object.assign(new Error(`ongeldig adres: ${url}`), { cause: err }));
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode || 0;
        resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (err) => reject(Object.assign(new Error(err.message), { cause: err })));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`geen antwoord binnen ${timeoutMs / 1000} s`), { name: "TimeoutError" }));
    });
    req.on("error", (err) => reject(err && err.name === "TimeoutError" ? err : Object.assign(new Error(err.message), { cause: err })));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { triliumRequest };
