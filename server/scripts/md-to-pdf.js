#!/usr/bin/env node
/**
 * Hebrew markdown → RTL PDF, rendered locally.
 *
 * Local on purpose: the document describes how the gan's systems are opened
 * and closed, so it is not handed to a conversion service.
 *
 *   node md2pdf.js <input.md> <output.pdf>
 */
const fs = require('fs');
const path = require('path');

const SERVER = '/Users/amitkohta/Desktop/Claude Code Apps/אפליקציות/gan-halomot/server';
const puppeteer = require(path.join(SERVER, 'node_modules/puppeteer-core'));

function findChrome() {
  const base = `${process.env.HOME}/.cache/puppeteer/chrome`;
  const versions = fs.readdirSync(base).sort().reverse();
  for (const v of versions) {
    const p = path.join(base, v, 'chrome-mac-arm64',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('לא נמצא דפדפן לרינדור');
}

/**
 * The gan's logo, inlined.
 *
 * Read off disk and embedded as a data URI rather than linked: the page is
 * rendered from a string with no base URL, so a relative <img src> resolves to
 * nothing and the header comes out as a broken-image box — which looks exactly
 * like a finished document until somebody holds it.
 *
 * client/public/careers/logo.webp is the GAN's mark (the rainbow, the name, and
 * "כל ילד חולם להיות בו"). brand/ belongs to the חלום product and is not this.
 * Missing file is not an error: the document is still correct without it.
 */
function logoDataUri() {
  const p = path.join(SERVER, '..', 'client', 'public', 'careers', 'logo.webp');
  try {
    return `data:image/webp;base64,${fs.readFileSync(p).toString('base64')}`;
  } catch {
    return '';
  }
}

const esc = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markdown, applied only outside code spans. */
function inline(s) {
  const spans = [];
  let t = esc(s).replace(/`([^`]+)`/g, (_, c) => {
    spans.push(c);
    return `\u0000${spans.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${spans[Number(i)]}</code>`);
}

function toHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let list = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. Kept LTR — a command that reorders is a command that fails.
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      closeList();
      out.push(`<pre class="code${lang ? ` lang-${lang}` : ''}"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Table.
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const header = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
      closeList();
      out.push('<table><thead><tr>'
        + header.map(c => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>');
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^---+\s*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue; }

    /**
     * A quote block.
     *
     * Not supported until 07.10.2026, and the failure was the quiet kind: the
     * '>' came out as a literal character and the lines inside the block were
     * joined into one paragraph with the markers still in it. The document
     * rendered, looked finished, and said something different from what was
     * written. Anything the converter does not understand should be visible as
     * wrong — so the block types it does understand have to cover what people
     * actually write.
     */
    if (/^>\s?/.test(line)) {
      closeList();
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${toHtml(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    /**
     * The rest of a list item that was wrapped onto the following lines.
     *
     * Markdown written by hand wraps at the margin, and every wrapped line is
     * part of the item above it — not a new paragraph. Without this a bullet
     * broke into a fragment plus a stray paragraph, and in an RTL document the
     * stray one landed somewhere that read as a different thought entirely.
     */
    const continuation = (from) => {
      const parts = [];
      let j = from;
      while (j < lines.length && lines[j].trim()
        && !/^(\s*[-*]\s|\s*\d+\.\s|#{1,4}\s|```|---+\s*$|\s*\|)/.test(lines[j])) {
        parts.push(lines[j].trim());
        j++;
      }
      return [parts.join(' '), j];
    };

    const task = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      if (list !== 'ul') { closeList(); out.push('<ul class="tasks">'); list = 'ul'; }
      const done = task[1].toLowerCase() === 'x';
      const [more, next] = continuation(i + 1);
      out.push(`<li class="${done ? 'done' : 'todo'}"><span class="box">${done ? '✓' : ''}</span>`
        + `<span>${inline(task[2] + (more ? ` ${more}` : ''))}</span></li>`);
      i = next;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      const [more, next] = continuation(i + 1);
      out.push(`<li>${inline(bullet[1] + (more ? ` ${more}` : ''))}</li>`);
      i = next;
      continue;
    }

    const num = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (num) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      const [more, next] = continuation(i + 1);
      out.push(`<li>${inline(num[2] + (more ? ` ${more}` : ''))}</li>`);
      i = next;
      continue;
    }

    if (!line.trim()) { closeList(); i++; continue; }

    // Paragraph: gather until a blank line or a block starter.
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,4}\s|```|---+\s*$|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    closeList();
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  closeList();
  return out.join('\n');
}

function document(title, body, logo) {
  return `<!doctype html>
<html lang="he" dir="rtl">
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }

  :root {
    --ink: #16181d;
    --soft: #5b6472;
    --line: #dfe3ea;
    --accent: #1f5fa8;
    --warn: #a8341f;
    --code-bg: #f4f6f9;
  }

  * { box-sizing: border-box; }

  body {
    font-family: "Assistant", "Heebo", "Arial Hebrew", "Arial", sans-serif;
    color: var(--ink);
    font-size: 10.6pt;
    line-height: 1.75;
    margin: 0;
    -webkit-font-smoothing: antialiased;
  }

  h1 {
    font-size: 21pt; line-height: 1.3; margin: 0 0 4pt;
    letter-spacing: -0.2pt;
  }
  h2 {
    font-size: 14pt; margin: 20pt 0 7pt; padding-top: 9pt;
    border-top: 1.2pt solid var(--line);
    break-after: avoid; page-break-after: avoid;
  }
  h3 {
    font-size: 11.6pt; margin: 14pt 0 5pt; color: var(--accent);
    break-after: avoid; page-break-after: avoid;
  }
  h4 { font-size: 10.8pt; margin: 11pt 0 4pt; }

  p { margin: 0 0 8pt; }
  strong { font-weight: 700; }
  hr { border: 0; border-top: 1pt solid var(--line); margin: 16pt 0; }

  /* An aside, marked on the start edge — which in an RTL document is the
     right. border-inline-start rather than border-right, so the rule
     follows the direction instead of being nailed to one side. */
  blockquote {
    margin: 10pt 0 12pt;
    padding: 2pt 11pt 2pt 0;
    padding-inline-start: 11pt;
    padding-inline-end: 0;
    border-inline-start: 2.5pt solid var(--accent);
    color: #3a3f47;
  }
  blockquote > :last-child { margin-bottom: 0; }

  /* The mark, once, at the top of the first page. Not repeated in the running
     header: a logo on every page of a twelve-page document is a letterhead
     nobody asked for, and it eats the margin the text needs. */
  .brand { margin: 0 0 10pt; }
  .brand img { height: 46pt; width: auto; display: block; }

  ul, ol { margin: 0 0 9pt; padding-inline-start: 20pt; }
  li { margin-bottom: 4pt; }

  /* Commands stay left-to-right and unwrapped: a path or a flag that reorders
     on the page is a path somebody retypes wrong. */
  pre.code {
    direction: ltr; text-align: left; unicode-bidi: isolate;
    background: var(--code-bg);
    border: 0.8pt solid var(--line);
    border-inline-start: 2.6pt solid var(--accent);
    border-radius: 4pt;
    padding: 8pt 10pt;
    margin: 8pt 0 11pt;
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 8.4pt; line-height: 1.6;
    white-space: pre-wrap; word-break: break-word;
    break-inside: avoid; page-break-inside: avoid;
  }

  code {
    direction: ltr; unicode-bidi: isolate; display: inline-block;
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 8.8pt;
    background: var(--code-bg);
    border: 0.6pt solid var(--line);
    border-radius: 3pt;
    padding: 0 3pt;
  }
  pre.code code { border: 0; background: none; padding: 0; display: inline; font-size: inherit; }

  table {
    border-collapse: collapse; width: 100%;
    margin: 8pt 0 12pt; font-size: 9.8pt;
    break-inside: avoid; page-break-inside: avoid;
  }
  th, td { border: 0.7pt solid var(--line); padding: 4.5pt 8pt; text-align: right; }
  th { background: var(--code-bg); font-weight: 700; }

  ul.tasks { list-style: none; padding-inline-start: 0; }
  ul.tasks li { display: flex; gap: 7pt; align-items: flex-start; margin-bottom: 6pt; }
  ul.tasks .box {
    flex: 0 0 auto; width: 11pt; height: 11pt; margin-top: 3pt;
    border: 1pt solid var(--soft); border-radius: 2.5pt;
    text-align: center; line-height: 10pt; font-size: 8.5pt;
  }
  ul.tasks li.done { color: var(--soft); }
  ul.tasks li.done .box { background: var(--soft); color: #fff; border-color: var(--soft); }

  .stamp {
    color: var(--soft); font-size: 9pt;
    border-bottom: 1pt solid var(--line);
    padding-bottom: 9pt; margin-bottom: 15pt;
  }
</style>
<body>
${logo ? `<div class="brand"><img src="${logo}" alt=""></div>` : ''}
${body}
</body>
</html>`;
}

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('שימוש: node md2pdf.js <input.md> <output.pdf>');
  process.exit(1);
}

(async () => {
  const md = fs.readFileSync(input, 'utf8');
  const title = (md.match(/^#\s+(.*)$/m) || [, path.basename(input, '.md')])[1];

  // The first heading becomes the cover line; the date line under it becomes
  // the stamp, so the PDF does not repeat them as ordinary paragraphs.
  const rest = md.replace(/^#\s+.*$/m, '').replace(/^מסמך הרצה\. נכתב .*$/m, '');
  const stamp = (md.match(/^מסמך הרצה\. נכתב (.*)$/m) || [])[1] || '';

  const body = `<h1>${esc(title)}</h1>`
    + (stamp ? `<div class="stamp">מסמך הרצה · ${esc(stamp)}</div>` : '')
    + toHtml(rest);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(document(title, body, logoDataUri()),
      { waitUntil: 'networkidle0', timeout: 60000 });
    await page.pdf({
      path: output,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;font-size:7.5pt;color:#8a929e;
        font-family:Arial,sans-serif;padding:0 16mm;text-align:center;">
        <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
      margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' },
    });
  } finally {
    await browser.close();
  }
  console.log(`✅ ${output}`);
})().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
