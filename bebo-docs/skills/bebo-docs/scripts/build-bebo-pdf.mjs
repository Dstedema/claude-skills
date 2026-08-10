// Zet een Markdown-document om in een Bebo-huisstijl HTML + PDF.
//   node build-bebo-pdf.mjs <document.md> [--no-pdf] [--logo <pad.png>]
// Uitvoer komt naast het bronbestand te staan: <document>.html en <document>.pdf.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const wantsPdf = !argv.includes('--no-pdf');
const logoFlag = argv.indexOf('--logo');
const logoArg = logoFlag === -1 ? undefined : argv[logoFlag + 1];
const logoPath = logoArg
  ? resolve(logoArg)
  : resolve(scriptDir, '..', 'assets', 'bebo-logo.png');
const target = argv.find((a) => /\.md$/i.test(a) && a !== logoArg);

if (!target) {
  console.error('Gebruik: node build-bebo-pdf.mjs <document.md> [--no-pdf] [--logo <pad.png>]');
  process.exit(1);
}

let logoTag = '';
try {
  const logo = readFileSync(logoPath).toString('base64');
  logoTag = `<img class="brand-logo" src="data:image/png;base64,${logo}" alt="BeBo Vloeren">`;
} catch {
  console.warn(`Let op: logo niet gevonden (${logoPath}) — document wordt zonder logo gebouwd.`);
}

// Pad is relatief aan de werkmap (CLI-conventie); forward slashes voor de file-URL.
const inPath = resolve(target).replace(/\\/g, '/');
const outHtml = inPath.replace(/\.md$/i, '.html');
const src = readFileSync(inPath, 'utf8');
const allLines = src.replace(/\r\n/g, '\n').split('\n');

// Front matter (key: value) levert de gegevens voor het titelblad en de voettekst.
const meta = {};
let lines = allLines;
if (allLines[0]?.trim() === '---') {
  const end = allLines.findIndex((l, n) => n > 0 && l.trim() === '---');
  if (end > 0) {
    for (const l of allLines.slice(1, end)) {
      const m = l.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim();
    }
    lines = allLines.slice(end + 1);
  }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(t) {
  let s = esc(t);
  // inline code
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // bold, daarna cursief (bold eerst, anders vreet de cursief-regex de **)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

const html = [];
let i = 0;

function parseListBlock(block) {
  // block: array of {indent, marker('ul'|'ol'), text}
  let idx = 0;
  function build(minIndent) {
    const type = block[idx].marker;
    let out = `<${type}>`;
    while (idx < block.length && block[idx].indent >= minIndent) {
      const cur = block[idx];
      if (cur.indent > minIndent) { // shouldn't happen at start
        break;
      }
      idx++;
      let li = `<li>${inline(cur.text)}`;
      if (idx < block.length && block[idx].indent > cur.indent) {
        li += build(block[idx].indent);
      }
      li += '</li>';
      out += li;
    }
    out += `</${type}>`;
    return out;
  }
  return build(block[0].indent);
}

while (i < lines.length) {
  const line = lines[i];

  // blank
  if (/^\s*$/.test(line)) { i++; continue; }

  // fenced code
  if (/^```/.test(line)) {
    i++;
    const code = [];
    while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
    i++;
    html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    continue;
  }

  // expliciete paginaovergang
  if (/^<!--\s*page\s*-->\s*$/.test(line)) { html.push('<div class="pagebreak"></div>'); i++; continue; }

  // overige HTML-comments negeren (o.a. layout-aanwijzingen)
  if (/^<!--.*-->\s*$/.test(line)) { i++; continue; }

  // hr
  if (/^---\s*$/.test(line)) { html.push('<hr>'); i++; continue; }

  // heading
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) { const lvl = h[1].length; html.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); i++; continue; }

  // blockquote
  if (/^>\s?/.test(line)) {
    const q = [];
    while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
    html.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
    continue;
  }

  // table
  if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
    const cells = (r) => r
      .replace(/\\\|/g, '\x00')            // bescherm escaped pipes
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.replace(/\x00/g, '|').trim());  // herstel als literale |
    const header = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    let t = '<table><thead><tr>';
    header.forEach((c) => { t += `<th>${inline(c)}</th>`; });
    t += '</tr></thead><tbody>';
    body.forEach((r) => {
      t += '<tr>';
      r.forEach((c) => { t += `<td>${inline(c)}</td>`; });
      t += '</tr>';
    });
    t += '</tbody></table>';
    html.push(t);
    continue;
  }

  // list
  if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) {
    const block = [];
    while (i < lines.length) {
      const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (!m) break;
      const item = {
        indent: m[1].length,
        marker: /\d+\./.test(m[2]) ? 'ol' : 'ul',
        text: m[3],
      };
      i++;
      // Vervolgregels van hetzelfde punt aanplakken (afgebroken regels in de bron).
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) &&
        !/^(#{1,6}\s|>|\||```|---\s*$|<!--)/.test(lines[i].trim())
      ) {
        item.text += ` ${lines[i].trim()}`;
        i++;
      }
      block.push(item);
    }
    html.push(parseListBlock(block));
    continue;
  }

  // paragraph (gather until blank)
  const para = [];
  while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|>|\||```|---\s*$|(\s*)([-*]|\d+\.)\s)/.test(lines[i])) {
    para.push(lines[i]); i++;
  }
  if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`);
}

const css = `
:root{
  --brown:#E30613; --brown-d:#b30510; --dark:#1A1A1A; --cream:#f7f7f7;
  --line:#e5e5e5; --muted:#5a5a5a;
}
*{box-sizing:border-box}
html{font-family:"Segoe UI",Arial,Helvetica,sans-serif;color:var(--dark);font-size:11pt;line-height:1.5}
body{margin:0}
.page{padding:0 6mm}
.brand-logo{display:block;width:230px;height:auto;margin:-14pt 0 -10pt -10pt}
h1{font-size:26pt;line-height:1.15;margin:0 0 6pt;color:var(--dark)}
.cover h1{color:#fff}
.cover{background:linear-gradient(135deg,var(--brown),var(--dark));color:#fff;padding:34pt 26pt;border-radius:10px;margin:0 0 18pt}
.cover .sub{color:#ffe1e3;font-size:13pt;margin-top:2pt}
.cover .meta{color:#f7dfe1;font-size:10pt;margin-top:16pt;line-height:1.6}
.cover .brand-logo{background:#fff;border-radius:6px;padding:5pt 9pt;width:215px;margin:0 0 22pt}
.pagebreak{page-break-after:always;height:0}
h2{font-size:15pt;color:var(--dark);border-bottom:2px solid var(--brown);padding-bottom:3pt;margin:20pt 0 8pt;page-break-after:avoid;page-break-before:always}
h2:first-of-type{page-break-before:avoid}
h3{font-size:12.5pt;color:var(--brown-d);margin:14pt 0 5pt;page-break-after:avoid}
h4{font-size:11pt;color:var(--dark);margin:11pt 0 3pt;page-break-after:avoid}
p{margin:5pt 0}
a{color:var(--brown-d);text-decoration:none;border-bottom:1px solid var(--line)}
ul,ol{margin:5pt 0 5pt 0;padding-left:20pt}
li{margin:2.5pt 0}
code{background:#fbe9ea;color:#b30510;padding:1px 5px;border-radius:4px;font-family:"Cascadia Code",Consolas,monospace;font-size:9.5pt}
pre{background:var(--dark);color:#f3e9dd;padding:10pt 12pt;border-radius:8px;overflow:hidden;font-size:7.5pt;line-height:1.4;page-break-inside:avoid;white-space:pre}
pre code{background:none;color:inherit;padding:0}
blockquote{background:var(--cream);border-left:4px solid var(--brown);margin:8pt 0;padding:8pt 12pt;border-radius:0 6px 6px 0;color:var(--muted)}
table{border-collapse:collapse;width:100%;margin:8pt 0;font-size:9.5pt;page-break-inside:avoid}
th{background:var(--brown);color:#fff;text-align:left;padding:6pt 8pt;font-weight:600}
td{border-bottom:1px solid var(--line);padding:5pt 8pt;vertical-align:top}
tr:nth-child(even) td{background:#fafafa}
hr{border:none;border-top:1px solid var(--line);margin:14pt 0}
h2,h3{-webkit-print-color-adjust:exact;print-color-adjust:exact}
th,pre,blockquote,.cover,tr:nth-child(even) td{-webkit-print-color-adjust:exact;print-color-adjust:exact}
@page{size:A4;margin:16mm 14mm 22mm}
`;

// Titelblad uit de front matter; zonder front matter valt het terug op de oude opzet.
const coverPage = meta.title
  ? `<section class="cover">${logoTag}<h1>${inline(meta.title)}</h1>` +
    (meta.subject ? `<div class="sub">${inline(meta.subject)}</div>` : '') +
    `<div class="meta">` +
      [['Versie', meta.version], ['Status', meta.status], ['Datum', meta.date], ['Auteurs', meta.authors]]
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${inline(v)}`)
        .join('<br>') +
    `</div></section><div class="pagebreak"></div>`
  : logoTag;

// Geen lopende voettekst: Chromium plaatst position:fixed bij printen onbetrouwbaar.
const doc = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>${inline(meta.title ?? 'Document')}</title><style>${css}</style></head><body><div class="page">${coverPage}${html.join('\n')}</div></body></html>`;
writeFileSync(outHtml, doc, 'utf8');
console.log('HTML geschreven:', outHtml, `(${html.length} blokken)`);

if (!wantsPdf) process.exit(0);

// De PDF rendert via een headless Chromium-browser (Edge of Chrome).
const outPdf = inPath.replace(/\.md$/i, '.pdf');
const candidates = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ]
  : [
      '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
      '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
const browser = candidates.find((p) => existsSync(p));

if (!browser) {
  console.log('Geen Edge of Chrome gevonden — alleen de HTML is geschreven.');
  console.log(`Zelf renderen: <browser> --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="${outPdf}" "${pathToFileURL(outHtml).href}"`);
  process.exit(0);
}

const r = spawnSync(browser, [
  '--headless', '--disable-gpu', '--no-pdf-header-footer',
  `--print-to-pdf=${process.platform === 'win32' ? outPdf.replace(/\//g, '\\') : outPdf}`,
  pathToFileURL(outHtml).href,
], { stdio: 'ignore', timeout: 120000 });

console.log(r.status === 0 && existsSync(outPdf)
  ? `PDF geschreven: ${outPdf}`
  : `PDF renderen mislukt (exit ${r.status}) — HTML staat klaar: ${outHtml}`);
