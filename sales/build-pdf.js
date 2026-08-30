#!/usr/bin/env node
/**
 * Render the specification to PDF.
 *
 *   node sales/build-pdf.js
 *
 * Chromium is what decides the page, not a converter: spec.html carries a
 * print stylesheet — its own margins, the contents rail hidden, tables and
 * boxes kept off page boundaries — and only a real browser honours it.
 *
 * It drives the Chrome already installed on the machine rather than the
 * @sparticuz build the server uses, which is a Linux binary and will not
 * launch here.
 */

const path = require('path');
const fs = require('fs');
const puppeteer = require(path.join(__dirname, '../server/node_modules/puppeteer-core'));

const SRC = 'file://' + path.join(__dirname, 'spec.html');
const OUT = process.argv[2] || path.join(__dirname, 'חלום - מסמך אפיון מערכת.pdf');

// Whatever Chrome this machine has. Ordered by how likely it is to be the one
// the user actually installed.
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

const chrome = CANDIDATES.find(p => fs.existsSync(p));
if (!chrome) {
  console.error('✗ לא נמצא דפדפן כרום במחשב. התקן Google Chrome ונסה שוב.');
  process.exit(1);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();

  // The document is theme-aware and paper is not. Pin light BEFORE the load so
  // the light tokens are what the renderer resolves — asking afterwards leaves
  // the first paint dark and prints a black page.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.goto(SRC, { waitUntil: 'networkidle0' });
  await page.emulateMediaType('print');

  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    // Numbered, because twenty pages handed round a table get separated and a
    // page with no number never finds its way back.
    footerTemplate:
      '<div style="width:100%;font-size:8pt;color:#6C8394;padding:0 14mm;' +
      'font-family:Assistant,Arial,sans-serif;display:flex;justify-content:space-between;direction:rtl">' +
      '<span>חלום — מסמך אפיון מערכת</span>' +
      '<span class="pageNumber"></span>' +
      '</div>',
  });

  await browser.close();
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`✓ ${path.basename(OUT)} — ${kb} קילובייט`);
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
