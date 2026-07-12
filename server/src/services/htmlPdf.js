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

const PDF_MARGIN = { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' };

// Render several full HTML documents to PDF Buffers in ONE browser (one page at
// a time — bounded memory). Rendering each employee separately and merging the
// PDFs downstream guarantees a clean page break between them regardless of the
// Chromium build's CSS page-break support.
async function htmlToPdfBatch(htmls) {
  while (_launching) { try { await _launching; } catch (e) { /* ignore */ } }
  let resolve;
  _launching = new Promise(r => { resolve = r; });
  let browser;
  try {
    browser = await getBrowser();
    const out = [];
    for (const html of htmls) {
      const page = await browser.newPage();
      try {
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        out.push(Buffer.from(await page.pdf({ printBackground: true, format: 'A4', margin: PDF_MARGIN })));
      } finally { try { await page.close(); } catch (e) { /* ignore */ } }
    }
    return out;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
    resolve(); _launching = null;
  }
}

async function htmlToPdf(html) {
  const [pdf] = await htmlToPdfBatch([html]);
  return pdf;
}

module.exports = { htmlToPdf, htmlToPdfBatch };
