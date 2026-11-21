#!/usr/bin/env node
/**
 * jira-forms — a tiny MCP server (stdio, no dependencies) that reads Jira
 * Service Management *forms* on an issue.
 *
 * Why it exists: portal requests often carry everything in a form and leave
 * the description empty. The claude.ai Atlassian connector doesn't expose the
 * Forms API, so a triage agent sees an "empty" ticket and asks the reporter
 * for information they already gave.
 *
 * Auth: basic auth with JIRA_EMAIL + JIRA_API_TOKEN (an Atlassian API token),
 * site from JIRA_BASE_URL (default https://bebogroep.atlassian.net). Read-only.
 *
 * Speaks just enough MCP (JSON-RPC 2.0, newline-delimited) for Claude Code:
 * initialize, tools/list, tools/call, ping.
 */

import readline from "node:readline";

const SITE = (process.env.JIRA_BASE_URL || "https://bebogroep.atlassian.net").replace(/\/+$/, "");
const EMAIL = process.env.JIRA_EMAIL || "";
const TOKEN = process.env.JIRA_API_TOKEN || "";

const TOOLS = [
  {
    name: "get_issue_forms",
    description:
      "Read the Jira Service Management forms on an issue (portal request forms) with their answers. " +
      "Use this whenever a ticket's description is empty or short, or the issue has forms " +
      "(field 'Totaal aantal formulieren' > 0): the request details are usually in the form. Read-only.",
    inputSchema: {
      type: "object",
      properties: { issue: { type: "string", description: "Issue key, e.g. ITSD-5160" } },
      required: ["issue"],
      additionalProperties: false,
    },
  },
];

let cloudIdPromise = null;

/** The site's cloud id, from the public tenant_info endpoint (cached). */
function cloudId() {
  if (!cloudIdPromise) {
    cloudIdPromise = fetch(`${SITE}/_edge/tenant_info`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`tenant_info ${r.status}`))))
      .then((d) => d.cloudId)
      .catch((err) => {
        cloudIdPromise = null;
        throw err;
      });
  }
  return cloudIdPromise;
}

async function formsApi(path) {
  const base = `https://api.atlassian.com/jira/forms/cloud/${await cloudId()}`;
  const res = await fetch(base + path, {
    headers: {
      Accept: "application/json",
      Authorization: "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64"),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Forms API ${res.status}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

async function getIssueForms(issue) {
  if (!EMAIL || !TOKEN) {
    return "jira-forms is not configured: set JIRA_EMAIL and JIRA_API_TOKEN (an Atlassian API token) in the environment.";
  }
  const key = String(issue || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return `Not an issue key: ${issue}`;

  const forms = (await formsApi(`/issue/${key}/form`)) || [];
  if (!forms.length) return `${key} has no forms.`;

  const parts = [];
  for (const f of forms) {
    const state = [f.submitted ? "submitted" : "not submitted", f.internal ? "internal" : "visible to customer"].join(", ");
    parts.push(`## ${f.name || "Form"} (${state})`);
    try {
      const answers = (await formsApi(`/issue/${key}/form/${f.id}/format/answers`)) || [];
      if (!answers.length) parts.push("(no answers)");
      for (const a of answers) parts.push(`- **${a.label}**: ${a.answer === "" || a.answer == null ? "—" : a.answer}`);
    } catch (err) {
      parts.push(`(answers unavailable: ${err.message})`);
    }
  }
  return `Forms on ${key}:\n\n${parts.join("\n")}`;
}

// ── JSON-RPC over stdio ──────────────────────────────────────────────────

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (e.g. notifications/initialized)

  try {
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "jira-forms", version: "0.1.0" },
        });
        return;
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: TOOLS });
        return;
      case "tools/call": {
        if (params?.name !== "get_issue_forms") {
          fail(id, -32602, `Unknown tool: ${params?.name}`);
          return;
        }
        try {
          const text = await getIssueForms(params?.arguments?.issue);
          reply(id, { content: [{ type: "text", text }] });
        } catch (err) {
          reply(id, { content: [{ type: "text", text: `jira-forms error: ${err.message}` }], isError: true });
        }
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    fail(id, -32603, err instanceof Error ? err.message : String(err));
  }
});
