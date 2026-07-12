/**
 * Server-side HTML → PDF via headless Chromium (@sparticuz/chromium +
 * puppeteer-core). Chromium honors print CSS (page-break, grid/flex, exact
 * layout), so the emailed report is pixel-identical to the in-app preview —
 * unlike the GAS HTML→PDF path which ignores page breaks and advanced CSS.
 *
 * Memory-optimized single-process launch so it can run on constrained tiers;
 * every caller wraps this in a try/catch and falls back to the HTML attachment
 * if Chromium can't launch (e.g. not enough RAM), so a send never fails.
 */
async function getBrowser() {
  const chromium = require('@sparticuz/chromium');
  const puppeteer = require('puppeteer-core');
  return puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--disable-gpu'],
    defaultViewport: { width: 1240, height: 1754, deviceScaleFactor: 1 },
    executablePath: await chromium.executablePath(),
    headless: true,
  });
}

const PDF_MARGIN = { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' };

// Force a V8 GC when possible so freed render buffers return to the OS before
// the next Chromium launch — on the 512MB tier the two peaks must not overlap.
// Works with --expose-gc, and falls back to the v8-flag trick without it.
let _gc = global.gc || null;
if (!_gc) {
  try {
    require('v8').setFlagsFromString('--expose_gc');
    _gc = require('vm').runInNewContext('gc');
  } catch (e) { _gc = null; }
}
function tryGc() { try { if (_gc) _gc(); } catch (e) { /* ignore */ } }

// Render several full HTML documents to PDF Buffers, one page at a time
// (closed after each). Chromium accumulates memory across renders even with
// pages closed (single-process build) — ~25 documents held, 75 OOM-killed the
// 512MB instance — so the browser itself is recycled every RECYCLE_EVERY
// documents (relaunch is fast once /tmp holds the extracted binary). Explicit
// timeouts everywhere: a hung render must FAIL (so the caller logs it and
// falls back) rather than hang the queue forever.
const RECYCLE_EVERY = 15;
async function runBatch(htmls) {
  let browser;
  const out = [];
  try {
    for (let i = 0; i < htmls.length; i++) {
      if (!browser) browser = await getBrowser();
      const page = await browser.newPage();
      try {
        await page.setContent(htmls[i], { waitUntil: 'load', timeout: 60000 });
        out.push(Buffer.from(await page.pdf({ printBackground: true, format: 'A4', margin: PDF_MARGIN, timeout: 120000 })));
      } finally { try { await page.close(); } catch (e) { /* ignore */ } }
      if ((i + 1) % RECYCLE_EVERY === 0 && i + 1 < htmls.length) {
        try { await browser.close(); } catch (e) { /* ignore */ }
        browser = null;
        tryGc();
      }
    }
    return out;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
    tryGc();
  }
}

// Strictly serialize batches: two concurrent sends must never launch two
// Chromiums (each is a few hundred MB — a second one OOMs the 512MB tier). A
// promise chain (instead of a while-await flag) has no race: every caller
// queues behind the previous batch, and a failed batch doesn't break the chain.
let _queue = Promise.resolve();
function htmlToPdfBatch(htmls) {
  const next = _queue.then(() => runBatch(htmls));
  _queue = next.then(() => undefined, () => undefined); // keep the chain alive after a failure
  return next;
}

async function htmlToPdf(html) {
  const [pdf] = await htmlToPdfBatch([html]);
  return pdf;
}

module.exports = { htmlToPdf, htmlToPdfBatch, tryGc };
