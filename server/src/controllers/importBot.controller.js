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
const XLSX = require('xlsx');
const { ImportBotRun, Branch } = require('../models');
const cibusJob = require('../services/cibusSyncJob');
const enrollments = require('./externalEnrollment.controller');
const { identifyHeader, institutionMatchesBranch } = require('../services/clicktac.service');
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

/**
 * WHAT CITY DOES THIS FILE SAY IT IS, and does the named branch sit in it?
 *
 * The branch cannot be read off a ClickTac file — `מוסד` and `מעון` are written
 * at CITY level, and two branches answer to "כפר סבא". That is why the branch is
 * a parameter. But city level is not nothing: it is enough to catch the mistake
 * a bot actually makes, which is a mapping error — הרצליה's file posted with תל
 * אביב's branch id, because a config line was copied and one field was not
 * changed. That mistake files a whole cohort into another town, and the office
 * would find it by noticing strangers on a roster.
 *
 * So the file's city is checked against the branch's before a row is written.
 * `institutionMatchesBranch` is the same comparison the contracts import already
 * makes per row; this applies it to both exports, once, at the door.
 *
 * IT DOES NOT SOLVE כפר סבא. Both כפר סבא branches match "כפר סבא" and always
 * will — the comparison is at city depth on purpose, because that is the depth
 * the file is written at. A כפר סבא file still needs a person to say which gan,
 * or to be split before it is sent. This guard is the layer that closes the
 * wrong-TOWN mistake, not the wrong-gan one.
 *
 * Returns null when it is fine, or `{ file_city, branch_name }` when it is not.
 */
function cityMismatch(rows, branchName) {
  const header = rows[0] || {};
  const col = ['מוסד', 'מעון'].find(c => c in header);
  if (!col) return null;               // neither column in this export — nothing to check
  const value = String(rows[0]?.[col] ?? '').trim();
  if (!value) return null;             // blank, as an older hand-edited sheet can be
  if (institutionMatchesBranch(value, branchName)) return null;
  return { file_city: value, branch_name: branchName };
}

/** The sheet as row objects, or null when the buffer is not a readable workbook. */
function readRows(buffer) {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const name = wb.SheetNames[0];
    if (!name) return null;
    return { rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, raw: false }), sheet: name };
  } catch {
    return null;
  }
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

    /**
     * A dry run parses, matches and counts, and writes nothing — not the payroll
     * figures, not the CibusSync log, not a run row here. It is what to call the
     * first time a bot is pointed at this, and after Pluxee changes an export:
     * the answer tells you whether the columns were found and how many employees
     * matched, which is the whole question, without a figure landing on anyone's
     * payslip.
     */
    const dryRun = String(req.body?.dry_run || '') === '1';
    if (dryRun) {
      const { applyCibusReport } = require('../services/cibusImport');
      const cfg = await cibusJob.getConfig();
      const ym = asked || cibusJob.targetMonth(cfg.month_offset);
      try {
        const applied = await applyCibusReport(
          req.file.buffer, req.file.originalname || '', ym, { dryRun: true },
        );
        return res.json({
          ok: true,
          dry_run: true,
          month: ym,
          matched: applied.matched_count,
          unmatched: applied.unmatched_count,
          // Which columns the parser recognised — the one thing worth seeing
          // when an export changes shape, and it names no person.
          detected_columns: Object.keys(applied.detected_columns || {}),
          already_imported: cfg.last_success_month === ym,
        });
      } catch (err) {
        return res.status(422).json({
          error: { code: 'PARSE_FAILED', message: err.message }, dry_run: true, month: ym,
        });
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
     * A branch that does not get its children from ClickTac at all.
     *
     * כפר סבא - קפלן registers and collects on its own; ClickTac holds nothing
     * for it and never will. So a bot upload naming it is not a borderline call,
     * it is a mapping error — and the city guard below cannot catch that one,
     * because קפלן and משה דיין are both "כפר סבא" and always match.
     *
     * Expressed as configuration rather than a field on Branch: a new field
     * would need an admin screen to ever be corrected, and a field with no
     * screen is a rule nobody can change without a deploy. This sits with the
     * secret, where the rest of the bot's setup already lives.
     *
     * UNSET MEANS NO RESTRICTION, so no existing behaviour depends on it and a
     * customer with no such split is unaffected.
     */
    const allow = String(process.env.IMPORT_BOT_CLICKTAC_BRANCHES || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(branchId)) {
      const message = `סניף ${branch.name} אינו מקבל ייבוא מקליקטאק`;
      await log(req, {
        kind: 'clicktac', status: 'rejected',
        branch_id: branchId, branch_name: branch.name, message,
      });
      await notifyOffice('system_faults', 'ייבוא קליקטאק לסניף שאינו מקליקטאק',
        `הבוט ניסה להעלות קובץ קליקטאק לסניף <b>${branch.name}</b>, שלא מקבל ייבוא משם.<br/>`
        + 'זו כמעט בוודאות טעות בהגדרת הבוט. שום שורה לא נכנסה.');
      return res.status(403).json({ error: { code: 'BRANCH_NOT_FROM_CLICKTAC', message } });
    }

    /**
     * The city check, before anything is written. See cityMismatch — it closes
     * the wrong-TOWN mistake and deliberately cannot close the wrong-gan one.
     */
    const read = readRows(req.file.buffer);
    if (read?.rows?.length) {
      const clash = cityMismatch(read.rows, branch.name);
      if (clash) {
        const message = `הקובץ הוא של ${clash.file_city}, וההעלאה היא לסניף ${clash.branch_name}`;
        await log(req, {
          kind: 'clicktac', status: 'rejected',
          branch_id: branchId, branch_name: branch.name, message,
        });
        await notifyOffice('system_faults', 'ייבוא קליקטאק — קובץ של עיר אחרת',
          `הבוט ניסה להעלות קובץ של <b>${clash.file_city}</b> לסניף `
          + `<b>${clash.branch_name}</b>.<br/>שום שורה לא נכנסה. `
          + 'כנראה מיפוי שגוי בין הדוחות לסניפים בהגדרת הבוט.');
        return res.status(400).json({
          error: { code: 'CITY_MISMATCH', message },
          file_city: clash.file_city,
        });
      }
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

/**
 * POST /api/import-bot/clicktac/validate
 * multipart: file, branch_id
 *
 * The dry run for ClickTac: WRITES NOTHING, and answers the three questions
 * worth asking before an import that creates children.
 *
 *   - is this one of the two exports, and which — the header decides, by the
 *     same `identifyHeader` the import uses, so a file this accepts is a file
 *     the import accepts
 *   - does the file's city match the branch being named
 *   - how many data rows are in it
 *
 * It cannot answer "which of the two כפר סבא gans is this", because nothing can:
 * the file is written at city level. That is a decision, not a check.
 *
 * Deliberately not a `dry_run` flag on the import route: the import's own path
 * has no dry mode — it merges against what is already stored, row by row — and a
 * flag that skipped the write would be a second implementation of the merge,
 * which is the one thing this whole feature is written to avoid. So this is a
 * separate, smaller question, and it is honest about being smaller.
 */
async function clicktacValidate(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { code: 'NO_FILE', message: 'לא צורף קובץ' } });
    }

    const read = readRows(req.file.buffer);
    if (!read) {
      return res.status(422).json({
        error: { code: 'UNREADABLE', message: 'הקובץ אינו גיליון שאפשר לקרוא' },
      });
    }
    if (!read.rows.length) {
      return res.status(400).json({ error: { code: 'EMPTY_SHEET', message: 'הגיליון ריק' } });
    }

    const verdict = identifyHeader(read.rows[0]);
    if (!verdict.type) {
      return res.status(400).json({
        error: { code: verdict.code || 'WRONG_EXPORT_TYPE', message: verdict.error },
        dry_run: true,
      });
    }

    // Same refusal as the real import: the monthly collection report is the
    // income module's file, not a registrations/contracts one.
    if (verdict.type === 'debt') {
      return res.status(400).json({
        error: { code: 'WRONG_EXPORT_TYPE', message: 'זה דוח הגבייה החודשי של קליקטאק (debt_contract_export) — הוא נקלט במסך ההכנסות, לא כאן.' },
        dry_run: true,
      });
    }

    // The branch is optional here — a caller may be asking only "what file is
    // this". When it IS given, the city is checked, because that is the answer
    // worth having before the real upload.
    const branchId = String(req.body?.branch_id || '').trim();
    let branch = null;
    if (branchId) {
      branch = await Branch.findById(branchId).select('name').lean().catch(() => null);
      if (!branch) {
        return res.status(404).json({
          error: { code: 'BRANCH_NOT_FOUND', message: `סניף ${branchId} לא נמצא` }, dry_run: true,
        });
      }
      const clash = cityMismatch(read.rows, branch.name);
      if (clash) {
        return res.status(400).json({
          error: {
            code: 'CITY_MISMATCH',
            message: `הקובץ הוא של ${clash.file_city}, וההעלאה היא לסניף ${clash.branch_name}`,
          },
          file_city: clash.file_city,
          dry_run: true,
        });
      }
    }

    return res.json({
      ok: true,
      dry_run: true,
      export_type: verdict.type,
      sheet: read.sheet,
      rows: read.rows.length,
      branch: branch ? branch.name : null,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  cibus, clicktac, clicktacValidate, monthOutOfRange, reduceClicktac, cityMismatch,
};
