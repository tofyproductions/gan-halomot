/**
 * The import bot's two doors.
 *
 * Cibus and ClickTac both publish the reports this system needs and neither
 * publishes an API, so the only way to get a file is to sign in to their
 * website and download it. A bot does that and posts the file here.
 *
 * It is worth a day on Cibus alone: the site has the month's report on the 1st
 * at 00:01, the email arrives on the 2nd, and until the file is in, payroll for
 * the month cannot close.
 *
 * THREE RULES SHAPE EVERYTHING BELOW.
 *
 * 1. NOTHING IS REIMPLEMENTED. Both handlers call the very services a person
 *    calls from the screen — `cibusSyncJob.applyBotFile` (which is
 *    `applyCibusReport` underneath, the same function the mailbox job uses) and
 *    `externalEnrollment.importFile`. A file posted by the bot and the same file
 *    uploaded by hand must produce identical rows, and the only way to be sure
 *    of that is for there to be one implementation.
 *
 * 2. THE BOT IS TOLD COUNTS AND NOTHING ELSE. Both underlying imports answer
 *    with names — `missing_names`, `skipped_names`, `results`, the unmatched
 *    Cibus rows. Those are children and employees, and they have no business
 *    leaving this server for a third party's robot, which may log or retain
 *    whatever it receives. So the real response is captured and reduced here
 *    (see `reduce*` below) rather than forwarded. Whatever the bot is, and
 *    whoever operates it, it never learns a name.
 *
 * 3. EVERY KNOCK IS RECORDED AND ANNOUNCED. A robot that stops working stops
 *    quietly — see models/ImportBotRun.js. Refusals are logged too, because a
 *    refusal is the bot telling us it tried; and every successful import mails
 *    the office what changed, with the undo, so a file filed against the wrong
 *    branch is caught in hours instead of at the end of the year.
 */
const { ImportBotRun, Branch } = require('../models');
const cibusJob = require('../services/cibusSyncJob');
const enrollments = require('./externalEnrollment.controller');
const { dispatchEmail } = require('../services/email.service');
const { officeEmails } = require('../services/office-recipients.service');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' for today in Israel — the clock the whole payroll works on. */
function currentMonth() {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  return String(d).slice(0, 7);
}

/**
 * How far back a bot may write.
 *
 * A file downloaded at 00:01 on the 1st is last month's, so the bot normally
 * names no month at all and the configured offset picks it. When it does name
 * one, the window is narrow on purpose: a typo'd year ('2025-09' for '2026-09')
 * would otherwise rewrite a payroll that closed a year ago, and nobody reads a
 * closed month again to notice.
 */
function monthOutOfRange(ym) {
  if (!MONTH_RE.test(ym)) return 'חודש חייב להיות בתבנית YYYY-MM';
  const cur = currentMonth();
  if (ym > cur) return `חודש ${ym} עוד לא התחיל`;
  const [cy, cm] = cur.split('-').map(Number);
  const [y, m] = ym.split('-').map(Number);
  const back = (cy * 12 + cm) - (y * 12 + m);
  if (back > 3) return `חודש ${ym} רחוק מדי לאחור — עד 3 חודשים בלבד`;
  return null;
}

/** One row per knock, successful or not. Never throws into the response. */
async function log(req, row) {
  try {
    await ImportBotRun.create({
      kind: row.kind,
      status: row.status,
      file_name: req.file?.originalname || '',
      file_bytes: req.file?.size || 0,
      month: row.month || '',
      branch_id: row.branch_id || null,
      branch_name: row.branch_name || '',
      academic_year: row.academic_year || '',
      counts: row.counts || {},
      enrollment_import_id: row.enrollment_import_id || null,
      message: row.message || '',
      ip: req.ip || '',
    });
  } catch (e) {
    console.error('[import-bot] logging failed:', e.message);
  }
}

/**
 * Tell the office, every time.
 *
 * The undo for a ClickTac upload already exists and is exact; what was missing
 * was anybody knowing there was something to undo. A branch named wrongly by
 * the bot files a whole cohort into the other כפר סבא, and the file itself
 * cannot catch that — only a person reading this mail can.
 *
 * A failure to mail must never fail the import: the rows are already written,
 * and answering the bot with an error would have it upload them again.
 */
async function notifyOffice(topic, subject, html) {
  try {
    const to = await officeEmails(topic);
    if (!to.length) return;
    await dispatchEmail({ to: to.join(','), subject, html: `<div dir="rtl">${html}</div>` });
  } catch (e) {
    console.error('[import-bot] notice failed:', e.message);
  }
}

/**
 * POST /api/import-bot/cibus
 * multipart: file, month? ('YYYY-MM'), force? ('1')
 *
 * Writes each employee's Cibus spend into their payroll month. Refuses a month
 * that already succeeded — see applyBotFile for why that is a refusal and not
 * an overwrite.
 */
async function cibus(req, res, next) {
  try {
    if (!req.file) {
      await log(req, { kind: 'cibus', status: 'rejected', message: 'לא צורף קובץ' });
      return res.status(400).json({ error: { code: 'NO_FILE', message: 'לא צורף קובץ' } });
    }

    const asked = String(req.body?.month || '').trim();
    if (asked) {
      const bad = monthOutOfRange(asked);
      if (bad) {
        await log(req, { kind: 'cibus', status: 'rejected', month: asked, message: bad });
        return res.status(400).json({ error: { code: 'BAD_MONTH', message: bad } });
      }
    }

    const result = await cibusJob.applyBotFile({
      buffer: req.file.buffer,
      filename: req.file.originalname || '',
      month: asked || null,
      force: String(req.body?.force || '') === '1',
    });

    if (!result.ok) {
      await log(req, {
        kind: 'cibus',
        status: result.code === 'PARSE_FAILED' ? 'error' : 'rejected',
        month: result.month,
        message: result.message,
      });
      if (result.code === 'PARSE_FAILED') {
        await notifyOffice('system_faults', 'ייבוא סיבוס אוטומטי נכשל',
          `הבוט ניסה להעלות דוח סיבוס לחודש ${result.month} והקובץ לא נקרא.<br/>`
          + `השגיאה: ${result.message}<br/>`
          + 'הדוח לא יובא. אפשר להעלות אותו ידנית במסך השכר.');
      }
      // 409 for a month already in, 422 for a file we could not parse: the bot
      // must be able to tell "stop, this is done" from "this file is wrong".
      const status = result.code === 'ALREADY_IMPORTED' ? 409 : 422;
      return res.status(status).json({
        error: { code: result.code, message: result.message },
        month: result.month,
      });
    }

    const run = result.run;
    await log(req, {
      kind: 'cibus',
      status: 'ok',
      month: result.month,
      counts: { matched: run.matched_count, unmatched: run.unmatched_count },
      message: run.message || '',
    });

    await notifyOffice('hr', `דוח סיבוס ל-${result.month} יובא אוטומטית`,
      `הבוט העלה את דוח סיבוס לחודש ${result.month}.<br/>`
      + `הותאמו ${run.matched_count} עובדות, לא הותאמו ${run.unmatched_count}, `
      + `סך הכל ₪${run.total_amount}.<br/>`
      + (run.unmatched_count
        ? 'שורות שלא הותאמו הן כסף שלא חויב לאף אחת — הן מופיעות במסך ייבוא סיבוס.<br/>'
        : '')
      + 'לבדיקה או לתיקון — מסך השכר.');

    // Counts only. The unmatched NAMES stay in CibusSync's run log, where the
    // accountant reads them; the bot is told how many, never who.
    return res.json({
      ok: true,
      month: result.month,
      matched: run.matched_count,
      unmatched: run.unmatched_count,
    });
  } catch (err) {
    await log(req, { kind: 'cibus', status: 'error', message: err.message });
    return next(err);
  }
}

/**
 * Everything the bot may be told about a ClickTac import — counts, the export
 * that was recognised, and the undo handle. Names are dropped here and this is
 * the only thing that reaches the response.
 */
function reduceClicktac(body) {
  return {
    ok: true,
    export_type: body.export_type || '',
    rows: body.rows || 0,
    parsed: body.parsed || 0,
    created: body.created || 0,
    updated: body.updated || 0,
    unchanged: body.unchanged || 0,
    missing: body.missing || 0,
    skipped_duplicate: body.skipped_duplicate || 0,
    import_id: body.import_id ? String(body.import_id) : null,
  };
}

/**
 * POST /api/import-bot/clicktac
 * multipart: file, branch_id, academic_year?
 *
 * BRANCH_ID IS REQUIRED AND IS NEVER GUESSED. Both ClickTac exports write
 * "כפר סבא" in `מוסד` and `מעון`, and two branches answer to that name, so the
 * file cannot say which gan it is — the import has always taken the branch as a
 * parameter for exactly this reason. A bot inferring it would file seventy
 * families into the wrong gan, which is not a mistake anybody notices quickly.
 * So there is no default and no fallback: no branch, no import.
 */
async function clicktac(req, res, next) {
  try {
    if (!req.file) {
      await log(req, { kind: 'clicktac', status: 'rejected', message: 'לא צורף קובץ' });
      return res.status(400).json({ error: { code: 'NO_FILE', message: 'לא צורף קובץ' } });
    }

    const branchId = String(req.body?.branch_id || '').trim();
    if (!branchId) {
      const message = 'חובה לציין branch_id — הקובץ עצמו לא מבחין בין סניפי כפר סבא';
      await log(req, { kind: 'clicktac', status: 'rejected', message });
      return res.status(400).json({ error: { code: 'NO_BRANCH', message } });
    }
    const branch = await Branch.findById(branchId).select('name').lean().catch(() => null);
    if (!branch) {
      const message = `סניף ${branchId} לא נמצא`;
      await log(req, { kind: 'clicktac', status: 'rejected', message });
      return res.status(404).json({ error: { code: 'BRANCH_NOT_FOUND', message } });
    }

    /**
     * The import runs as the office, not as a person.
     *
     * `importFile` reads `req.user` for the branch check and stamps
     * `imported_by`. A bot has no User row and must not be given one — an
     * account is a thing that can log in, and this one would never need to. So
     * the principal is request-local and exists for the length of this call:
     * `system_admin` because the branch is an explicit parameter that was just
     * verified to exist, and `imported_by` stays null. Who actually did it is
     * the ImportBotRun row, which says so plainly.
     */
    req.user = { id: null, role: 'system_admin', branch_id: branchId, import_bot: true };

    /**
     * The real response, captured instead of sent.
     *
     * This is what keeps rule 2 above true without forking the import: the
     * controller answers exactly as it does for a person, and its answer is
     * reduced here. `status` and `json` are all `importFile` and both of its
     * branches use.
     */
    const captured = { status: 200, body: null };
    const shim = {
      status(code) { captured.status = code; return this; },
      json(body) { captured.body = body; return this; },
      setHeader() { return this; },
    };

    let failed = null;
    await enrollments.importFile(req, shim, (err) => { failed = err || new Error('שגיאה בייבוא'); });
    if (failed) throw failed;

    const body = captured.body || {};
    if (captured.status >= 400) {
      const message = body.error || 'הקובץ נדחה';
      await log(req, {
        kind: 'clicktac', status: 'rejected',
        branch_id: branchId, branch_name: branch.name,
        academic_year: req.body?.academic_year || '',
        message: String(message),
      });
      await notifyOffice('system_faults', 'ייבוא קליקטאק אוטומטי נדחה',
        `הבוט ניסה להעלות קובץ קליקטאק לסניף ${branch.name} והקובץ נדחה.<br/>`
        + `הסיבה: ${message}<br/>`
        + 'שום שורה לא נכנסה.');
      return res.status(captured.status).json({
        error: { code: body.code || 'REJECTED', message: String(message) },
      });
    }

    const reduced = reduceClicktac(body);
    await log(req, {
      kind: 'clicktac', status: 'ok',
      branch_id: branchId, branch_name: branch.name,
      academic_year: req.body?.academic_year || '',
      counts: {
        created: reduced.created, updated: reduced.updated, unchanged: reduced.unchanged,
      },
      enrollment_import_id: reduced.import_id,
      message: reduced.export_type,
    });

    await notifyOffice('parents_finance', `קובץ קליקטאק יובא אוטומטית — ${branch.name}`,
      `הבוט העלה ${body.export_label || 'קובץ קליקטאק'} לסניף <b>${branch.name}</b>.<br/>`
      + `נוצרו ${reduced.created}, עודכנו ${reduced.updated}, ללא שינוי ${reduced.unchanged}.<br/><br/>`
      + '<b>אם זה הסניף הלא נכון</b> — הקובץ עצמו לא מבחין בין סניפי כפר סבא, '
      + 'ולכן כדאי לוודא. לביטול ההעלאה הזאת במסך רישום לאמונה: "בטל העלאה".');

    return res.json(reduced);
  } catch (err) {
    await log(req, { kind: 'clicktac', status: 'error', message: err.message });
    return next(err);
  }
}

module.exports = { cibus, clicktac, monthOutOfRange, reduceClicktac };
