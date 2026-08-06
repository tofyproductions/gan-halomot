#!/usr/bin/env node
/**
 * Step 1 of the Cibus/Pluxee auto-import: find out what the portal actually
 * returns.
 *
 * The employer portal is a JS app talking to a JSON API, and nobody outside
 * Pluxee has that API documented. This script logs in AS YOU, in a visible
 * browser, and records every JSON response the site receives. Its output is
 * what the importer gets built against — guessing the shape instead would
 * produce an importer that silently imports nothing.
 *
 * CREDENTIALS NEVER GO IN CODE, IN THE DATABASE, OR IN A CHAT. Put them in the
 * environment for the length of this one run:
 *
 *   CIBUS_URL='https://<the page you normally log in at>' \
 *   CIBUS_USER='...' CIBUS_PASS='...' \
 *   node scripts/cibus-discover.js
 *
 * Add HEADLESS=1 to run it without a visible window (do the first run WITH the
 * window — you may need to solve something by hand, and you want to see it).
 *
 * It writes ./cibus-capture/ :
 *   calls.json        every JSON response, with its URL
 *   summary.txt       one line per call — this is the file to look at first
 *   page-*.png        screenshots, including one on failure
 *
 * NOTHING IS SENT ANYWHERE. Review the files before sharing them, and redact
 * anything you don't want to hand over — they can contain employee names.
 */
const fs = require('fs');
const path = require('path');

const URL = process.env.CIBUS_URL || 'https://www.mysodexo.co.il/';
const USER = process.env.CIBUS_USER;
const PASS = process.env.CIBUS_PASS;
const HEADLESS = process.env.HEADLESS === '1';
const OUT = path.join(process.cwd(), 'cibus-capture');

if (!USER || !PASS) {
  console.error('חסרים CIBUS_USER / CIBUS_PASS בסביבה. ראו את ההערה בראש הקובץ.');
  process.exit(1);
}

async function launch() {
  const puppeteer = require('puppeteer-core');
  // Prefer a real desktop Chrome for discovery — it behaves most like what you
  // see by hand. Falls back to the bundled Chromium the server already uses.
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    // Arc is Chromium underneath and drives fine — it is what is actually
    // installed on this Mac.
    '/Applications/Arc.app/Contents/MacOS/Arc',
  ].filter(Boolean);
  const executablePath = candidates.find(p => fs.existsSync(p));
  if (!executablePath) {
    // The bundled @sparticuz build is a headless shell — fine for the server's
    // PDF rendering, useless for a login you have to watch and sometimes
    // finish by hand.
    throw new Error(
      'לא נמצא דפדפן מבוסס Chromium להרצת הגילוי.\n'
      + 'התקינו Google Chrome, או הריצו עם CHROME_PATH=/path/to/browser.',
    );
  }
  console.log(`דפדפן: ${executablePath}`);
  return puppeteer.launch({
    headless: HEADLESS,
    executablePath,
    defaultViewport: null,
    // A throwaway profile: the run never touches your real browser session,
    // and closing it leaves no logged-in Cibus session lying around.
    userDataDir: path.join(require('os').tmpdir(), 'cibus-discover-profile'),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage();
  const captured = [];

  page.on('response', async (res) => {
    try {
      const url = res.url();
      const ct = res.headers()['content-type'] || '';
      if (!/json/i.test(ct)) return;
      if (/google|gstatic|analytics|hotjar|clarity|facebook/i.test(url)) return;
      const body = await res.json().catch(() => null);
      if (body == null) return;
      captured.push({ url, status: res.status(), method: res.request().method(), body });
      const n = Array.isArray(body) ? body.length
        : Array.isArray(body?.data) ? body.data.length
        : Array.isArray(body?.items) ? body.items.length : '';
      console.log(`  ← ${res.status()} ${res.request().method()} ${url.slice(0, 110)}${n !== '' ? `  [${n} rows]` : ''}`);
    } catch { /* not our problem — keep recording */ }
  });

  // The monthly report is very likely behind an "export" button rather than a
  // JSON list. Record every request that looks like one — its URL and method
  // are what the importer would call — and let the file land in the capture
  // folder so we can see the exact format the parser will receive.
  const downloads = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/export|download|report|excel|xls|csv/i.test(u) && !/\.(js|css|png|svg|woff2?)(\?|$)/i.test(u)) {
      downloads.push({ method: req.method(), url: u, postData: req.postData() || null });
      console.log(`  ⭳ ${req.method()} ${u.slice(0, 130)}`);
    }
  });
  try {
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT });
  } catch { /* older builds — a download just goes to the default folder */ }

  const shot = (name) => page.screenshot({ path: path.join(OUT, `page-${name}.png`), fullPage: true }).catch(() => {});

  try {
    console.log(`\nפותח ${URL} …`);
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90_000 });
    await shot('1-login');

    // The field names differ between Pluxee properties, so try the usual
    // shapes rather than hard-coding one selector.
    const userSel = 'input[name="username"], input[name="user"], input#username, input[type="email"], input[type="text"]';
    const passSel = 'input[type="password"]';
    await page.waitForSelector(userSel, { timeout: 30_000 });
    await page.type(userSel, USER, { delay: 40 });
    await page.type(passSel, PASS, { delay: 40 });
    await Promise.all([
      page.click('button[type="submit"], input[type="submit"], button'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {}),
    ]);
    await new Promise(r => setTimeout(r, 4000));
    await shot('2-after-login');

    if (await page.$(passSel)) {
      console.log('\n⚠ עדיין מוצג שדה סיסמה — ייתכן שההתחברות נכשלה, או שנדרש קוד חד-פעמי.');
      if (!HEADLESS) {
        console.log('   השלימו את ההתחברות ידנית בחלון שנפתח. הסקריפט ימשיך להקליט 3 דקות.');
      }
    }

    // Give a human time to click into the report screens, which is what makes
    // the interesting calls fire. Headless can't do that, so it just waits.
    const waitMs = HEADLESS ? 15_000 : 180_000;
    console.log(`\nמקליט… ${HEADLESS ? '15 שניות' : '3 דקות — נווטו לדוח החודשי/היסטוריית עסקאות ולחצו על ייצוא'}`);
    await new Promise(r => setTimeout(r, waitMs));
    await shot('3-final');
  } catch (err) {
    console.error('\nשגיאה:', err.message);
    await shot('error');
  } finally {
    fs.writeFileSync(path.join(OUT, 'calls.json'), JSON.stringify(captured, null, 2));
    const summary = captured.map((c, i) => {
      const keys = c.body && typeof c.body === 'object' ? Object.keys(c.body).slice(0, 12).join(', ') : typeof c.body;
      const rows = Array.isArray(c.body) ? c.body.length
        : Array.isArray(c.body?.data) ? c.body.data.length
        : Array.isArray(c.body?.items) ? c.body.items.length : 0;
      return `[${i}] ${c.method} ${c.status}  ${c.url}\n     rows=${rows}  keys=${keys}`;
    }).join('\n');
    const dl = downloads.length
      ? '\n\n=== קריאות שנראות כמו ייצוא/הורדה ===\n'
        + downloads.map((d, i) => `[D${i}] ${d.method} ${d.url}${d.postData ? `\n      body: ${d.postData.slice(0, 500)}` : ''}`).join('\n')
      : '\n\n(לא נתפסו קריאות ייצוא/הורדה)';
    fs.writeFileSync(path.join(OUT, 'summary.txt'), (summary || '(לא נתפסו קריאות JSON)') + dl);
    console.log(`\nנשמרו ${captured.length} קריאות JSON ו-${downloads.length} קריאות ייצוא ל-${OUT}`);
    console.log('הקובץ להסתכל בו ראשון: cibus-capture/summary.txt');
    await browser.close();
  }
})();
