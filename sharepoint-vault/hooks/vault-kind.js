// The plugin's settings as hooks get them: Claude Code hands hooks every
// option as CLAUDE_PLUGIN_OPTION_<KEY>. The vault choice comes from the option
// only (unset means sharepoint, as in the MCP server, which gets the
// manifest's default); address, token and notes dir fall back to the
// environment JARVIS also gives its agents.
function vaultKind(env = process.env) {
  const raw = (env.CLAUDE_PLUGIN_OPTION_VAULT || "").trim().toLowerCase();
  return raw === "trilium" ? "trilium" : "sharepoint";
}

function triliumSettings(env = process.env) {
  const pick = (opt, fallback) => (env[opt] || "").trim() || (env[fallback] || "").trim();
  return {
    url: pick("CLAUDE_PLUGIN_OPTION_TRILIUM_URL", "TRILIUM_URL") || "http://trilium.it.svc.cluster.local",
    token: pick("CLAUDE_PLUGIN_OPTION_TRILIUM_TOKEN", "TRILIUM_ETAPI_TOKEN"),
  };
}

/** The ETAPI root from whatever address was filled in (as in mcp/trilium.mjs). */
function etapiBase(raw) {
  const trim = (p) => p.replace(/\/+$/, "").replace(/\/etapi$/, "");
  try {
    const u = new URL(raw);
    return u.origin + trim(u.pathname) + "/etapi";
  } catch {
    return trim(raw) + "/etapi";
  }
}

/**
 * Null when Trilium answers with this token, else why not, in a few words.
 * Short timeout: it runs at every session start.
 */
async function triliumProblem({ url, token }, timeoutMs = 3000) {
  if (!token) return "geen ETAPI-token ingesteld";
  try {
    const res = await fetch(etapiBase(url) + "/app-info", {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return null;
    return res.status === 401 ? "het ETAPI-token wordt geweigerd (401)" : `Trilium antwoordt met HTTP ${res.status}`;
  } catch (err) {
    const cause = (err && err.cause) || {};
    const why =
      err && err.name === "TimeoutError"
        ? `geen antwoord binnen ${timeoutMs / 1000} s`
        : cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code) || cause.message || (err && err.message) || String(err);
    return `niet bereikbaar op ${url} (${why})`;
  }
}

module.exports = { vaultKind, triliumSettings, triliumProblem, etapiBase };
