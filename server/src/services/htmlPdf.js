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

/**
 * A self-contained document → one full-height PNG.
 *
 * For the work plan sent to the parents' WhatsApp group: a picture has no
 * pages, so the month is one continuous image at a width a phone can read
 * rather than a month squeezed onto A4 until the type disappears.
 *
 * ⚠️ THE HTML COMES FROM THE BROWSER, so this renders with the network cut.
 * Chromium here sits inside our own network and would happily fetch whatever a
 * document asked it to — a cloud metadata address, an internal service — and
 * paint the answer into a picture the caller then downloads. Every request
 * except the document itself is aborted. The gantt sheet is entirely inline
 * (its CSS is in a <style> block and it loads no images), so nothing legitimate
 * is lost; a future template that needs a web font has to inline it too.
 *
 * deviceScaleFactor 2 because the result is read on a telephone, where a 1x
 * screenshot of 15pt text is soft enough to look like a bad scan.
 */
async function htmlToPng(html, { width = 1400, maxHeightPx = 20000 } = {}) {
  const run = async () => {
    let browser;
    try {
      browser = await getBrowser();
      const page = await browser.newPage();
      try {
        await page.setViewport({ width, height: 1200, deviceScaleFactor: 2 });
        await page.setRequestInterception(true);
        page.on('request', (r) => {
          // The document itself arrives via setContent, so anything that
          // reaches here is the page reaching outward.
          if (r.isNavigationRequest() && r.frame() === page.mainFrame() && r.url() === 'about:blank') {
            return r.continue();
          }
          return r.abort();
        });
        await page.setContent(html, { waitUntil: 'load', timeout: 60000 });

        // A runaway document must not turn into a 400MB buffer on a 512MB box.
        const h = await page.evaluate(() => document.body.scrollHeight);
        if (h > maxHeightPx) {
          throw new Error(`התוכנית ארוכה מדי לתמונה אחת (${h}px)`);
        }
        return Buffer.from(await page.screenshot({ type: 'png', fullPage: true, timeout: 120000 }));
      } finally { try { await page.close(); } catch (e) { /* ignore */ } }
    } finally {
      if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
      tryGc();
    }
  };
  // Same single-Chromium rule as the PDF path, and the SAME queue — two
  // browsers is two browsers whichever function launched them.
  const next = _queue.then(run);
  _queue = next.then(() => undefined, () => undefined);
  return next;
}

module.exports = { htmlToPdf, htmlToPdfBatch, htmlToPng, tryGc };
