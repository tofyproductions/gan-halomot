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
let _launching = null;

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

// Render a full HTML document to an A4 PDF Buffer. Uses the document's own
// @page/print CSS (preferCSSPageSize) so margins + page breaks come from the HTML.
async function htmlToPdf(html) {
  // Serialize launches — one Chromium at a time keeps peak memory low.
  while (_launching) { try { await _launching; } catch (e) { /* ignore */ } }
  let resolve;
  _launching = new Promise(r => { resolve = r; });
  let browser;
  try {
    browser = await getBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true, format: 'A4' });
    return Buffer.from(pdf);
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
    resolve(); _launching = null;
  }
}

module.exports = { htmlToPdf };
