const fs = require('fs');
const path = require('path');

/**
 * The kindergarten's letterhead for generated documents.
 *
 * The logo is NOT baked into the stored HTML. Every letter and every contract
 * keeps its own copy of its markup forever, and an inlined image would add
 * ~87KB of base64 to each of them — for a picture that is identical in all of
 * them. Instead the templates emit a slot, and the logo is substituted on the
 * way out: preview, PDF, and the employee's signing page.
 *
 * The useful side effect is that a re-branded logo appears on old documents
 * too, which is what you want from a letterhead: it identifies the
 * organisation, it is not part of what was agreed.
 *
 * `logo-doc.png` is a 320px-wide copy of the full-size asset — enough for a
 * 34mm header at print resolution, a third of the bytes.
 */

const SLOT = '<!--GAN_LETTERHEAD-->';

let cached;
function logoDataUrl() {
  if (cached !== undefined) return cached;
  cached = null;
  for (const name of ['logo-doc.png', 'logo.png']) {
    try {
      const p = path.join(__dirname, '..', 'assets', name);
      if (fs.existsSync(p)) {
        cached = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
        break;
      }
    } catch (err) {
      console.error('[letterhead] failed to load', name, err.message);
    }
  }
  if (!cached) console.error('[letterhead] no logo asset found — documents will render without one');
  return cached;
}

/** Markup for the header block. Empty string when the asset is missing, so a
 *  document still renders rather than showing a broken image. */
function headerHtml() {
  const src = logoDataUrl();
  if (!src) return '';
  return `<div class="letterhead"><img src="${src}" alt="גן החלומות"/></div>`;
}

const CSS = `
  .letterhead { text-align: center; margin: 0 0 10pt; }
  .letterhead img { height: 34mm; width: auto; }
  @media print { .letterhead { break-inside: avoid; } }
`;

/** Replace the slot with the real header. Safe to call on markup without one. */
function inject(html) {
  if (!html || !html.includes(SLOT)) return html;
  return html.split(SLOT).join(headerHtml());
}

/** Strip the slot — for a context where the header is not wanted. */
function strip(html) {
  return html ? html.split(SLOT).join('') : html;
}

module.exports = { SLOT, CSS, inject, strip, headerHtml, logoDataUrl };
