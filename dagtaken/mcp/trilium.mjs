#!/usr/bin/env node
/**
 * trilium — a tiny MCP server (stdio, no dependencies) for Dennis' second brain
 * in Trilium Notes, through Trilium's ETAPI. JARVIS uses it when Instellingen →
 * Vault says the vault is in Trilium.
 *
 * Auth: an ETAPI token (Trilium → Opties → ETAPI) in TRILIUM_ETAPI_TOKEN, sent
 * as the Authorization header. Address from TRILIUM_URL (default: the service
 * inside the cluster's it namespace).
 *
 * Search, read, create and update; nothing here deletes. New notes go under
 * the note named JARVIS_NOTES_DIR (default "jarvis") at the root, made once
 * when it's missing. Before a note changes, Trilium saves a revision of it;
 * when that fails, nothing is changed. Which agents may create and update is
 * up to JARVIS' tool profiles.
 *
 * Speaks just enough MCP (JSON-RPC 2.0, newline-delimited) for Claude Code:
 * initialize, tools/list, tools/call, ping.
 */

import readline from "node:readline";

const BASE =
  (process.env.TRILIUM_URL || "http://trilium.it.svc.cluster.local").replace(/\/+$/, "").replace(/\/etapi$/, "") + "/etapi";
const TOKEN = process.env.TRILIUM_ETAPI_TOKEN || "";
const NOTES_DIR = (process.env.JARVIS_NOTES_DIR || "jarvis").replace(/["\\]/g, "").trim() || "jarvis";

/** Trilium's note ids (EntityId): letters, digits and _. */
const NOTE_ID = /^[A-Za-z0-9_]{1,32}$/;
/** Enough for any real note; a huge one would only flood the agent. */
const MAX_CONTENT = 100_000;

const noteId = { type: "string", description: "The note's id, as search_notes gives it (e.g. abc123XYZ)" };

const TOOLS = [
  {
    name: "search_notes",
    description:
      "Search Dennis' second brain in Trilium Notes. The query is Trilium search: keywords for full text, " +
      '"exact phrase" in double quotes, #label for a label. Returns note ids and titles; read one with read_note.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Trilium search, e.g. printer 2e or #project" },
        limit: { type: "number", description: "At most this many results (default 20, max 50)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_note",
    description: "Read one note from Trilium: its title, type and content. Text notes are HTML.",
    inputSchema: { type: "object", properties: { noteId }, required: ["noteId"], additionalProperties: false },
  },
  {
    name: "create_note",
    description:
      `Add a text note to Trilium. Content is HTML (<p>, <h2>, <ul><li>, <a href>, <code>). Without parentNoteId ` +
      `it goes under the note "${NOTES_DIR}" at the root.`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The note's title" },
        content: { type: "string", description: "The note's content, as HTML" },
        parentNoteId: { type: "string", description: "Put it under this note instead" },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "update_note",
    description:
      "Change a note in Trilium: replace its content (HTML for a text note), its title, or both. Trilium keeps a " +
      "revision of the note as it was. Read the note first: the content you send replaces all of it.",
    inputSchema: {
      type: "object",
      properties: {
        noteId,
        content: { type: "string", description: "The new content, as HTML: replaces all of it" },
        title: { type: "string", description: "A new title" },
      },
      required: ["noteId"],
      additionalProperties: false,
    },
  },
];

class UserError extends Error {}

async function etapi(method, path, { json, text } = {}) {
  const headers = { Authorization: TOKEN, Accept: "application/json" };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (text !== undefined) {
    headers["Content-Type"] = "text/plain; charset=utf-8";
    body = text;
  }
  const res = await fetch(BASE + path, { method, headers, body, signal: AbortSignal.timeout(20_000) });
  const raw = await res.text();
  if (!res.ok) {
    let message = raw.slice(0, 300);
    try {
      message = JSON.parse(raw).message || message;
    } catch {
      // not JSON: keep the text
    }
    throw new Error(`Trilium ${res.status}: ${message}`);
  }
  return raw;
}

const getJson = async (path) => {
  const raw = await etapi("GET", path);
  return raw ? JSON.parse(raw) : null;
};

function id(raw, what = "noteId") {
  const v = String(raw ?? "").trim();
  if (!NOTE_ID.test(v)) throw new UserError(`Not a Trilium ${what}: ${raw}`);
  return v;
}

function line(n) {
  const type = n.type && n.type !== "text" ? ` (${n.type})` : "";
  const when = n.dateModified ? `, gewijzigd ${String(n.dateModified).slice(0, 16)}` : "";
  return `- ${n.noteId} — ${n.title}${type}${when}`;
}

async function searchNotes({ query, limit }) {
  const q = String(query ?? "").trim();
  if (!q) throw new UserError("query is empty");
  const n = Math.min(50, Math.max(1, Math.round(Number(limit)) || 20));
  const { results = [] } = (await getJson(`/notes?${new URLSearchParams({ search: q, limit: String(n) })}`)) ?? {};
  if (!results.length) return `Niets gevonden voor: ${q}`;
  return `${results.length} notitie(s) voor "${q}":\n${results.map(line).join("\n")}`;
}

async function readNote({ noteId: raw }) {
  const nid = id(raw);
  const note = await getJson(`/notes/${nid}`);
  const head = `# ${note.title}\nnoteId: ${nid}, type: ${note.type}${note.dateModified ? `, gewijzigd ${String(note.dateModified).slice(0, 16)}` : ""}`;
  if (note.type === "image" || note.type === "file") return `${head}\n\n(${note.type}: de inhoud is geen tekst)`;
  const content = await etapi("GET", `/notes/${nid}/content`);
  const cut = content.length > MAX_CONTENT ? `${content.slice(0, MAX_CONTENT)}\n\n(afgekapt: ${content.length} tekens)` : content;
  return `${head}\n\n${cut}`;
}

let notesDirNote = null;

/** The note new notes go under: NOTES_DIR at the root, made once when missing. */
function notesDir() {
  if (!notesDirNote) {
    const params = new URLSearchParams({ search: `note.title = "${NOTES_DIR}"`, ancestorNoteId: "root", ancestorDepth: "eq1", limit: "1" });
    notesDirNote = getJson(`/notes?${params}`)
      .then(async (found) => {
        const hit = found?.results?.[0];
        if (hit) return hit.noteId;
        const made = JSON.parse(await etapi("POST", "/create-note", { json: { parentNoteId: "root", title: NOTES_DIR, type: "text", content: "" } }));
        return made.note.noteId;
      })
      .catch((err) => {
        notesDirNote = null;
        throw err;
      });
  }
  return notesDirNote;
}

async function createNote({ title, content, parentNoteId }) {
  const t = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!t) throw new UserError("title is empty");
  if (typeof content !== "string") throw new UserError("content must be a string (HTML)");
  const parent = parentNoteId ? id(parentNoteId, "parentNoteId") : await notesDir();
  const made = JSON.parse(await etapi("POST", "/create-note", { json: { parentNoteId: parent, title: t, type: "text", content } }));
  return `Notitie gemaakt: ${made.note.noteId} — ${t} (onder ${parent})`;
}

async function updateNote({ noteId: raw, content, title }) {
  const nid = id(raw);
  const t = title === undefined ? undefined : String(title).replace(/\s+/g, " ").trim().slice(0, 200);
  if (content === undefined && !t) throw new UserError("nothing to change: give content, title or both");
  if (content !== undefined && typeof content !== "string") throw new UserError("content must be a string (HTML)");
  try {
    await etapi("POST", `/notes/${nid}/revision`);
  } catch (err) {
    throw new Error(`Geen revisie kunnen bewaren, dus niets gewijzigd: ${err.message}`);
  }
  if (content !== undefined) await etapi("PUT", `/notes/${nid}/content`, { text: content });
  if (t) await etapi("PATCH", `/notes/${nid}`, { json: { title: t } });
  return `Notitie ${nid} bijgewerkt (de vorige versie staat als revisie in Trilium).`;
}

const HANDLERS = { search_notes: searchNotes, read_note: readNote, create_note: createNote, update_note: updateNote };

// ── JSON-RPC over stdio ──────────────────────────────────────────────────

function reply(rid, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: rid, result }) + "\n");
}
function fail(rid, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: rid, error: { code, message } }) + "\n");
}

readline.createInterface({ input: process.stdin }).on("line", async (input) => {
  let msg;
  try {
    msg = JSON.parse(input);
  } catch {
    return;
  }
  const { id: rid, method, params } = msg;
  if (rid === undefined) return; // notifications (e.g. notifications/initialized)

  try {
    switch (method) {
      case "initialize":
        reply(rid, {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "trilium", version: "0.1.0" },
        });
        return;
      case "ping":
        reply(rid, {});
        return;
      case "tools/list":
        reply(rid, { tools: TOOLS });
        return;
      case "tools/call": {
        const handler = HANDLERS[params?.name];
        if (!handler) {
          fail(rid, -32602, `Unknown tool: ${params?.name}`);
          return;
        }
        if (!TOKEN) {
          const text =
            "Trilium is niet ingesteld: zet het ETAPI-token in JARVIS → Instellingen → Vault (Trilium ETAPI-token). " +
            "Maak het in Trilium onder Opties → ETAPI.";
          reply(rid, { content: [{ type: "text", text }], isError: true });
          return;
        }
        try {
          const text = await handler(params?.arguments ?? {});
          reply(rid, { content: [{ type: "text", text }] });
        } catch (err) {
          reply(rid, { content: [{ type: "text", text: `trilium: ${err.message}` }], isError: true });
        }
        return;
      }
      default:
        fail(rid, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    fail(rid, -32603, err instanceof Error ? err.message : String(err));
  }
});
