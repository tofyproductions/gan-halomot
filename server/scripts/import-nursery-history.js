/**
 * One-off: the old board's history, into `DailyLog` and `DailyMenu`.
 *
 * The תינוקייה ran on a Google Sheet driven by an Apps Script until
 * `NurseryBoard` replaced it. The sheet's history tab holds one JSON blob per
 * day — every child, every meal, every nap — and that is eight months of a
 * family's record that would otherwise stay locked inside 243 rows of
 * stringified JSON. This moves it across once.
 *
 * ONE-WAY AND ONCE. Not a sync, not a bridge. After this runs, the sheet is
 * history in the other sense too.
 *
 * Dry by default. Without `--write` it reads the file, resolves every child
 * against the database, and prints exactly what it WOULD do — and that is the
 * run you read before you let it write anything. The default is dry rather
 * than the flag being `--dry-run` for one reason: a mistyped MONGODB_URI
 * should produce a printout, not an incident.
 *
 *   node scripts/import-nursery-history.js --file <xlsx> --branch "<שם סניף>"
 *   node scripts/import-nursery-history.js --file <xlsx> --branch "<שם סניף>" --write
 *
 * Options:
 *   --file <path>        the xlsx export. Required.
 *   --branch <name>      the branch it belongs to. Required — the export says
 *                        only "moshe", and a branch name is what the database
 *                        actually has. Nothing here is specific to משה דיין;
 *                        קפלן arrives as another file and another branch.
 *   --write              actually write. Everything else is a dry run.
 *   --overwrite          replace rows that already hold something. Off by
 *                        default, and the default is insert-only: a row with
 *                        anything in it is skipped whole and reported, never
 *                        merged field by field. The history runs to September
 *                        and the new board is already in use, so an overlap is
 *                        evidence that an assumption here is wrong rather than
 *                        a conflict to resolve automatically.
 *   --undo "<run id>"    delete everything one run created, by the id stamped
 *                        on the documents. Rows edited since are kept.
 *   --manifest <path>    write the created _ids to a file as well.
 *   --expect-db <name>   refuse to run unless MONGODB_URI points at this
 *                        database. The last guard before a production write.
 *   --settings           extend the board's option and menu lists with what
 *                        the sheet held. Off by default, and reported either
 *                        way — ten dishes the kitchen served for months are
 *                        not in `DEFAULT_MENU`.
 *   --conflict richest|latest   which snapshot wins on a day that has more
 *                        than one. Default 'richest'; see the module.
 *   --scope room|branch|all     which children a name may match against.
 *                        Default 'branch', and it matters more than it looks:
 *                        the export covers a school year, and most of the
 *                        children in it are no longer in a תינוקייה.
 *   --from / --to <YYYY-MM-DD>  limit the range.
 *   --verbose            print every day rather than a summary.
 *
 * Exported as a function as well as a script, so `nursery-history-e2e.test.js`
 * can run the real thing against a database that lives for eight seconds.
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const H = require('./lib/nursery-history');

// --- Matching a child in the export to a child in the database ------------

/**
 * A name, in a form that survives the difference between two systems.
 *
 * The same child is "לביא אהרון מרום" in one place and "מרום לביא אהרון" in the
 * other, and one of them has a double space. Tokens sorted, punctuation
 * dropped, so the order stops mattering — the same key the employee import has
 * used since it was written.
 */
function nameKey(name) {
  return String(name || '')
    .replace(/[()]/g, ' ')
    .replace(/[^֐-׿0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** A `Child.birth_date` as the export writes it. */
function birthKey(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Which database child an exported one is.
 *
 * The export's own identifier is an `accessId` — a UUID the parent's link
 * carried — and nothing in this database has ever held it, so it cannot be the
 * key. The name is, with the date of birth breaking the tie when a branch has
 * two children of the same name, which it does.
 *
 * Ambiguity is refused rather than guessed. A day written onto the wrong child
 * is worse than a day not written: the first is a stranger reading a family's
 * record, the second is a gap somebody can see.
 */
/**
 * The export's own idea of who its children are.
 *
 * Nothing in this database holds an `accessId`, so it cannot match a child to
 * a `Child` document — but it can match a child to THEMSELVES across the
 * export, and that turns out to matter. In Kaplan, "איתן חרמון" appears for
 * exactly one day and "איתן חכמון" for 225; they carry the same accessId, the
 * same date of birth and the same phone. They are one child and a typo that
 * was corrected. Matching on the name alone invents a nineteenth child in a
 * room of eighteen, and gives them one day.
 *
 * Built in the other direction too, because the token is not stable either:
 * "אופק אלון" carries two accessIds, the second issued when the parent's link
 * was reissued. So this is many-to-one in both directions, and all it does is
 * agree on a canonical spelling — the name that carries the most days wins,
 * on the grounds that the typo is the rare one.
 *
 * The early Kaplan rows carry no accessId at all (459 of 3,444 entries, from
 * the days before the script wrote one). Those fall through to the name, which
 * is all there is.
 */
function canonicalNames(byDate) {
  const perName = new Map();
  const idToNames = new Map();

  for (const snapshots of byDate.values()) {
    for (const snapshot of snapshots) {
      for (const entry of H.historyChildren(snapshot.payload)) {
        if (!entry?.name) continue;
        perName.set(entry.name, (perName.get(entry.name) || 0) + 1);
        if (!entry.accessId) continue;
        if (!idToNames.has(entry.accessId)) idToNames.set(entry.accessId, new Set());
        idToNames.get(entry.accessId).add(entry.name);
      }
    }
  }

  // Union the spellings that share a token, then elect the commonest of each.
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const name of perName.keys()) parent.set(name, name);
  for (const names of idToNames.values()) {
    const [first, ...rest] = names;
    for (const other of rest) parent.set(find(other), find(first));
  }

  const best = new Map();
  for (const name of perName.keys()) {
    const root = find(name);
    const current = best.get(root);
    if (!current || perName.get(name) > perName.get(current)) best.set(root, name);
  }

  const canonical = new Map();
  const merged = [];
  for (const name of perName.keys()) {
    const winner = best.get(find(name));
    canonical.set(name, winner);
    if (winner !== name) merged.push({ from: name, to: winner, days: perName.get(name) });
  }
  return { canonical, merged };
}

function resolveChild(entry, index) {
  const key = nameKey(entry.name);
  const candidates = index.get(key) || [];
  const dob = H.normalizeDateKey(entry.dob);

  if (candidates.length === 0) return { child: null, reason: 'לא נמצא ילד בשם הזה' };

  if (candidates.length === 1) {
    const child = candidates[0];
    const theirs = birthKey(child.birth_date);
    // One name, two different dates of birth, is two children. Refused rather
    // than accepted on the name alone — and reported, because a wrong date in
    // one of the two systems looks exactly the same from here.
    if (dob && theirs && dob !== theirs) {
      return { child: null, reason: `תאריך לידה לא תואם (${dob} מול ${theirs})`, ambiguous: true };
    }
    return { child };
  }

  const byDob = candidates.filter(c => birthKey(c.birth_date) === dob);
  if (byDob.length === 1) return { child: byDob[0], via: 'תאריך לידה' };
  return { child: null, reason: `${candidates.length} ילדים באותו שם`, ambiguous: true };
}

/**
 * Which children the import is allowed to match against.
 *
 * NOT the infant rooms, by default, and that is the whole point. The export
 * runs from January to September and the cohort it describes has moved on:
 * of the 39 children in the Moshe Dayan history, 16 are in the current
 * roster and 22 finished the year on 27/08 and are now in צעירים, in בוגרים,
 * or gone. Matching only against the rooms that keep a board today would
 * resolve one child-day in sixteen and call the rest missing.
 *
 *   'room'   — only rooms that keep a full board, at this branch
 *   'branch' — every room at this branch, whatever it is now. The default.
 *   'all'    — every child in the database. For a child who transferred
 *              branches mid-year; use it when the report says so.
 */
const CHILD_FIELDS = 'child_name birth_date phone classroom_id is_active';

async function childScope(scope, branch, { Child, Classroom }) {
  if (scope === 'all') {
    return { rooms: [], children: await Child.find({}).select(CHILD_FIELDS).lean() };
  }
  const nursery = require('../src/services/nursery.service');
  let rooms = await Classroom.find({ branch_id: branch._id }).lean();
  if (scope === 'room') rooms = rooms.filter(r => nursery.boardKind(r) === 'full');
  const children = await Child.find({ classroom_id: { $in: rooms.map(r => r._id) } })
    .select(CHILD_FIELDS).lean();
  return { rooms, children };
}

/** Read one dotted path out of a lean document. */
function valueAt(doc, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== '';
}

// --- The import itself ----------------------------------------------------

/**
 * Run the import. Assumes mongoose is already connected.
 *
 * Returns everything the caller needs to decide whether to trust it: the
 * counts, the days that had more than one snapshot and which one won, the
 * children it could not place, and every value it refused. Writes nothing
 * unless `write` is true.
 */
/** The id this run stamps on everything it creates. */
function makeRunId(branchName, at = new Date()) {
  return `nursery-sheet:${branchName}:${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

async function importHistory(options) {
  const {
    file, branch: branchName, write = false, overwrite = false, settings = false,
    conflict = 'richest', scope = 'branch', from = null, to = null,
    verbose = false, log = console.log, runId = makeRunId(branchName),
  } = options;

  const models = require('../src/models');
  const { Branch, DailyLog, DailyMenu, Setting } = models;
  const nursery = require('../src/services/nursery.service');

  const parsed = H.readWorkbook(file);
  const { byDate, broken } = parsed.history;

  let dates = [...byDate.keys()].sort();
  if (from) dates = dates.filter(d => d >= from);
  if (to) dates = dates.filter(d => d <= to);

  const branch = await Branch.findOne({ name: branchName }).lean();
  if (!branch) {
    const names = (await Branch.find({}).select('name').lean()).map(b => b.name);
    const err = new Error(`לא נמצא סניף "${branchName}". קיימים: ${names.join(' | ')}`);
    err.known = true;
    throw err;
  }

  const { rooms, children } = await childScope(scope, branch, models);

  const index = new Map();
  for (const c of children) {
    const key = nameKey(c.child_name);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(c);
  }

  const menuConfig = await nursery.getMenu();
  const knownDishes = H.knownDishSet(menuConfig);
  const { canonical, merged } = canonicalNames(byDate);

  const report = {
    file, branch: branch.name, write, overwrite, conflict, scope, run_id: runId,
    sheets: parsed.sheets,
    roster: parsed.children.length,
    rooms: rooms.length, db_children: children.length,
    date_from: dates[0] || null, date_to: dates[dates.length - 1] || null,
    days: 0, days_skipped: 0, conflicts: [],
    logs_created: 0, logs_updated: 0, logs_unchanged: 0,
    menus_created: 0, menus_updated: 0, menus_unchanged: 0,
    child_days_seen: 0, child_days_written: 0, child_days_empty: 0,
    fields_written: 0, fields_kept: 0,
    unresolved: new Map(), ambiguous: new Map(),
    unmapped_fields: new Map(), rejected_values: [],
    unknown_dishes: new Map(), unknown_menu_keys: new Set(),
    today_rows: parsed.today.rows,
    merged_names: merged,
    created_ids: [], created_menu_ids: [],
    collisions: [],
    settings: null,
    broken,
  };

  const bump = (map, key, extra) => {
    const cur = map.get(key) || { count: 0, ...extra };
    cur.count += 1;
    map.set(key, cur);
  };

  for (const date of dates) {
    const snapshots = byDate.get(date);
    const picked = H.chooseSnapshot(snapshots, conflict);
    if (!picked) { report.days_skipped += 1; continue; }

    if (snapshots.length > 1) {
      const other = H.chooseSnapshot(snapshots, conflict === 'richest' ? 'latest' : 'richest');
      report.conflicts.push({
        date,
        options: picked.all.map(s => ({ timestamp: s.timestamp, score: s.score })),
        chosen: picked.chosen.timestamp,
        would_differ: other.chosen.timestamp !== picked.chosen.timestamp,
      });
    }

    const payload = picked.chosen.payload;
    report.days += 1;

    // --- the children's day ---
    for (const raw of H.historyChildren(payload)) {
      // One spelling per child, decided once across the whole export.
      const entry = { ...raw, name: canonical.get(raw.name) || raw.name };
      report.child_days_seen += 1;
      const { set, unmapped, rejected } = H.dailyLogSet(entry.data);

      for (const u of unmapped) bump(report.unmapped_fields, u.field, { sample: u.value });
      for (const r of rejected) {
        if (report.rejected_values.length < 40) report.rejected_values.push({ date, name: entry.name, ...r });
      }

      if (Object.keys(set).length === 0) { report.child_days_empty += 1; continue; }

      const { child, reason, ambiguous } = resolveChild(entry, index);
      if (!child) {
        bump(ambiguous ? report.ambiguous : report.unresolved, entry.name,
          { reason, access_id: entry.accessId, dob: entry.dob });
        continue;
      }

      const existing = await DailyLog.findOne({ child_id: child._id, date }).lean();

      // Insert only. A day that already holds something is left exactly as it
      // is and reported — not merged, not patched field by field.
      //
      // The history being imported ran to September and the new board is
      // already in use, so the two should not overlap at all. A row that does
      // is not a merge to resolve; it is evidence that an assumption here is
      // wrong — the wrong child was matched, or the wrong branch, or this ran
      // once already. Deciding that automatically would bury the one signal
      // worth stopping for. --overwrite is the deliberate way past it.
      const filledPaths = existing
        ? Object.keys(set).filter(path => isFilled(valueAt(existing, path)))
        : [];
      if (filledPaths.length > 0 && !overwrite) {
        report.logs_unchanged += 1;
        report.fields_kept += filledPaths.length;
        if (report.collisions.length < 200) {
          report.collisions.push({
            date,
            name: entry.name,
            child_id: String(child._id),
            fields: filledPaths,
            imported: existing.import_source || '',
            edited_by: existing.updated_by_name || '',
          });
        }
        continue;
      }

      const finalSet = { ...set };
      report.fields_written += Object.keys(finalSet).length;
      report.child_days_written += 1;
      if (existing) report.logs_updated += 1; else report.logs_created += 1;

      finalSet.child_name = entry.name || child.child_name;
      finalSet.classroom_id = child.classroom_id || null;
      finalSet.branch_id = branch._id;
      finalSet.import_source = runId;

      if (verbose) log(`    ${date}  ${existing ? '~' : '+'} ${entry.name}  ${Object.keys(set).join(', ')}`);

      if (write) {
        const doc = await DailyLog.findOneAndUpdate(
          { child_id: child._id, date },
          { $set: finalSet, $setOnInsert: { child_id: child._id, date } },
          { upsert: true, new: true, setDefaultsOnInsert: true, projection: { _id: 1 } }
        ).lean();
        if (doc) report.created_ids.push(String(doc._id));
      }
    }

    // --- the kitchen's day ---
    const { selections, unknownKeys, unknownDishes } = H.menuSelections(H.historyMenu(payload)?.selected, knownDishes);
    for (const k of unknownKeys) report.unknown_menu_keys.add(k);
    for (const d of unknownDishes) bump(report.unknown_dishes, `${d.key} — ${d.dish}`, {});

    if (Object.keys(selections).length > 0) {
      const existing = await DailyMenu.findOne({ branch_id: branch._id, date }).lean();
      // Same rule as the child's day: a menu the kitchen has already entered
      // is the kitchen's, and the sheet does not get to argue with it.
      if (existing && Object.keys(existing.selections || {}).length > 0 && !overwrite) {
        report.menus_unchanged += 1;
        if (report.collisions.length < 200) {
          report.collisions.push({
            date, name: '(תפריט הסניף)', fields: Object.keys(existing.selections),
            imported: existing.import_source || '', edited_by: existing.updated_by_name || '',
          });
        }
      } else {
        if (existing) report.menus_updated += 1; else report.menus_created += 1;
        if (write) {
          const doc = await DailyMenu.findOneAndUpdate(
            { branch_id: branch._id, date },
            {
              $set: { selections, import_source: runId },
              $setOnInsert: { branch_id: branch._id, date },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true, projection: { _id: 1 } }
          ).lean();
          if (doc) report.created_menu_ids.push(String(doc._id));
        }
      }
    }
  }

  // --- the lists, only when asked ------------------------------------------
  if (settings) {
    const current = await nursery.getOptions();
    const nextOptions = { ...current };
    const added = [];

    const union = (key, incoming) => {
      const cur = nextOptions[key] || [];
      const extra = (incoming || []).filter(v => !cur.includes(v));
      if (extra.length) { nextOptions[key] = cur.concat(extra); added.push(`${key}: ${extra.join(', ')}`); }
    };
    union('formula_amounts', parsed.options['תמ"ל']);
    union('meal_amounts', parsed.options['א. בוקר']);
    union('missing', parsed.options['חוסרים']);

    const nextMenu = JSON.parse(JSON.stringify(menuConfig));
    for (const [mealKey, meal] of Object.entries(parsed.menu)) {
      if (!nextMenu[mealKey]) { nextMenu[mealKey] = meal; added.push(`menu.${mealKey}: ארוחה חדשה`); continue; }
      for (const [category, dishes] of Object.entries(meal.categories)) {
        const cur = nextMenu[mealKey].categories[category] || [];
        const extra = dishes.filter(d => !cur.includes(d));
        if (extra.length) {
          nextMenu[mealKey].categories[category] = cur.concat(extra);
          added.push(`menu.${mealKey}.${category}: ${extra.join(', ')}`);
        }
      }
    }

    report.settings = { added };
    if (write && added.length) {
      await Setting.updateOne({ key: nursery.OPTIONS_KEY }, { $set: { key: nursery.OPTIONS_KEY, value: nextOptions } }, { upsert: true });
      await Setting.updateOne({ key: nursery.MENU_KEY }, { $set: { key: nursery.MENU_KEY, value: nextMenu } }, { upsert: true });
    }
  }

  return report;
}

/**
 * Take an import back out.
 *
 * Deletes only documents carrying this exact run id — so one branch's import,
 * or one failed attempt, comes out without touching anything else. Nothing the
 * staff has ever written carries the field at all.
 *
 * A row somebody has edited since the import is KEPT and reported. The undo
 * exists to remove rows nobody wanted; a row a teacher has since corrected is
 * a row somebody wants, and deleting it to tidy up an import would be the
 * import doing damage on its way out.
 */
async function undoImport({ runId, write = false }) {
  const { DailyLog, DailyMenu } = require('../src/models');

  const logs = await DailyLog.find({ import_source: runId })
    .select('_id date child_name updated_by updated_by_name').lean();
  const menus = await DailyMenu.find({ import_source: runId }).select('_id date').lean();

  const touched = logs.filter(l => l.updated_by || l.updated_by_name);
  const removable = logs.filter(l => !l.updated_by && !l.updated_by_name);

  if (write && removable.length) {
    await DailyLog.deleteMany({ _id: { $in: removable.map(l => l._id) } });
  }
  if (write && menus.length) {
    await DailyMenu.deleteMany({ _id: { $in: menus.map(m => m._id) } });
  }

  return { runId, write, found: logs.length, removed: removable.length, kept: touched, menus: menus.length };
}

/** The database this is about to write to, with no credentials in it. */
function describeTarget(uri) {
  try {
    const u = new URL(uri);
    const db = u.pathname.replace(/^\//, '') || '(ברירת מחדל)';
    return { host: u.host, db, ok: true };
  } catch {
    return { host: '(לא ניתן לפענוח)', db: '(לא ידוע)', ok: false };
  }
}

// --- The report -----------------------------------------------------------

function printReport(report, log = console.log) {
  const list = (map, limit = 30) => [...map.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, limit);

  log('');
  log(`  קובץ:     ${report.file}`);
  const scopeLabel = { room: 'כיתות לוח מלא בלבד', branch: 'כל כיתות הסניף', all: 'כל המסד' }[report.scope];
  log(`  סניף:     ${report.branch}`);
  log(`  התאמה:    --scope ${report.scope} (${scopeLabel}) — ${report.rooms} כיתות, ${report.db_children} ילדים`);
  log(`  מצב:      ${report.write ? 'כתיבה' : 'DRY RUN — לא נכתב כלום'}`);
  log(`  התנגשות:  ${report.conflict}${report.overwrite ? '  ⚠ --overwrite: דריסת רשומות קיימות' : '  | insert-only'}`);
  log(`  run id:   ${report.run_id}`);
  log(`  גיליונות: ${report.sheets.join(', ')}`);
  log(`  רוסטר:    ${report.roster} ילדים בגיליון "ילדים"`);

  log('\n  ═══ סיכום ═══\n');
  log(`  ימים שיובאו:              ${report.days}${report.date_from ? `  (${report.date_from} → ${report.date_to})` : ''}`);
  log(`  ימים שדולגו:              ${report.days_skipped}`);
  log(`  ימי-ילד במקור:            ${report.child_days_seen}`);
  log(`  ימי-ילד ריקים במקור:      ${report.child_days_empty}`);
  log(`  ימי-ילד שנכתבו:           ${report.child_days_written}`);
  log(`  DailyLog חדשים:           ${report.logs_created}`);
  log(`  DailyLog שיעודכנו:        ${report.logs_updated}`);
  log(`  DailyLog שדולגו (יש תוכן):${report.logs_unchanged}`);
  log(`  שדות שנכתבו:              ${report.fields_written}`);
  log(`  שדות שנשמרו כמו שהם:      ${report.fields_kept}${report.overwrite ? '' : '   (כבר יש בהם ערך; --overwrite כדי לדרוס)'}`);
  log(`  DailyMenu חדשים:          ${report.menus_created}`);
  log(`  DailyMenu שיעודכנו:       ${report.menus_updated}`);
  log(`  DailyMenu ללא שינוי:      ${report.menus_unchanged}`);

  if (report.conflicts.length) {
    log(`\n  ── ${report.conflicts.length} תאריכים עם יותר מ-snapshot אחד ──`);
    const other = report.conflict === 'richest' ? 'latest' : 'richest';
    for (const c of report.conflicts) {
      // 2026-01-13 was archived forty-three times while Kaplan was being set
      // up. Printing all of them buries the one line that matters, so the
      // chosen one and the runners-up by score, and a count for the rest.
      const ranked = c.options.slice().sort((a, b) => b.score - a.score);
      const shown = ranked.slice(0, 3).map(o => `${o.timestamp} (${o.score} שדות)`).join('   |   ');
      const rest = ranked.length > 3 ? `   [+${ranked.length - 3} נוספים, המרבי שבהם ${ranked[3].score} שדות]` : '';
      log(`    ${c.date}  ×${c.options.length}:  ${shown}${rest}`);
      log(`      נבחר ${c.chosen}${c.would_differ ? `   ⚠  ב---conflict ${other} היה נבחר האחר` : ''}`);
    }
  }

  if (report.unresolved.size) {
    log(`\n  ── ${report.unresolved.size} ילדים במקור שלא נמצאו במסד — ימיהם לא יובאו ──`);
    for (const [name, i] of list(report.unresolved)) {
      log(`    ${name}   ${i.count} ימים, ת. לידה ${i.dob || '?'}, accessId ${String(i.access_id).slice(0, 8)}…`);
    }
  }
  if (report.ambiguous.size) {
    log(`\n  ── ${report.ambiguous.size} ילדים לא חד-משמעיים — דולגו במכוון ──`);
    for (const [name, i] of list(report.ambiguous)) log(`    ${name}   ${i.count} ימים — ${i.reason}`);
  }

  if (report.collisions.length) {
    log(`\n  ⚠ ── ${report.collisions.length} רשומות קיימות שדולגו ולא נגעתי בהן ──`);
    log('    התנגשות כאן היא סימן שהנחה כלשהי שגויה — לא משהו להכריע אוטומטית.');
    for (const c of report.collisions.slice(0, 25)) {
      const who = c.edited_by ? `נערך ע"י ${c.edited_by}` : (c.imported ? `מייבוא ${c.imported}` : 'מקור לא ידוע');
      log(`    ${c.date}  ${c.name}  [${c.fields.join(', ')}]  ${who}`);
    }
    if (report.collisions.length > 25) log(`    … ועוד ${report.collisions.length - 25}`);
  }

  if (report.merged_names.length) {
    log(`\n  ── ${report.merged_names.length} איותי שם שאוחדו לפי accessId ──`);
    for (const m of report.merged_names) log(`    "${m.from}" (${m.days} ימים)  →  "${m.to}"`);
  }

  if (report.unmapped_fields.size) {
    log(`\n  ── שדות במקור בלי מקבילה ביעד ──`);
    for (const [f, i] of list(report.unmapped_fields)) log(`    ${f}   ${i.count} פעמים, למשל "${String(i.sample).slice(0, 40)}"`);
  } else {
    log('\n  כל שדות המקור מופו. אין שדה שנפל בדרך.');
  }

  if (report.rejected_values.length) {
    log(`\n  ── ${report.rejected_values.length} ערכים שנפסלו (פורמט לא תקין) ──`);
    for (const r of report.rejected_values.slice(0, 15)) log(`    ${r.date} ${r.name} — ${r.field}: "${r.value}"`);
  } else {
    log('  שום ערך לא נפסל.');
  }

  if (report.unknown_dishes.size) {
    log(`\n  ── ${report.unknown_dishes.size} מנות בתפריט ההיסטורי שאינן ברשימת התפריט הנוכחית ──`);
    for (const [dish, i] of list(report.unknown_dishes, 40)) log(`    ${dish}   (${i.count} ימים)`);
    log('    → הן נכתבות ל-DailyMenu כמו שהן. --settings מוסיף אותן גם לרשימה שהצוות בוחר ממנה.');
  }
  if (report.unknown_menu_keys.size) log(`\n  ── מפתחות תפריט לא מוכרים: ${[...report.unknown_menu_keys].join(', ')}`);

  if (report.broken.length) {
    log(`\n  ── ${report.broken.length} שורות היסטוריה פגומות ──`);
    for (const b of report.broken.slice(0, 10)) {
      log(`    שורה ${b.row} ${b.date || ''} — ${b.reason}${b.raw ? `: "${b.raw}"` : ''}`);
    }
  }

  if (report.today_rows.length) {
    log(`\n  ── גיליון "סדר יום": ${report.today_rows.length} שורות — לא מיובא, במכוון ──`);
    log('    הוא מזהה ילדים לפי מיקום שורה בלבד — אין בו שם ואין accessId — והוא לוח היום,');
    log('    שהצוות יכתוב מחר ממילא. כך נראות שורותיו אחרי ההמרה, כהוכחה שהשברים מטופלים:');
    for (const r of report.today_rows.slice(0, 4)) {
      log(`      שורה ${r.row}: ${Object.entries(r.set).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ') || '(ריקה)'}`);
    }
  }

  if (report.settings) {
    log(`\n  ── רשימות (--settings) ──`);
    if (report.settings.added.length === 0) log('    אין מה להוסיף.');
    for (const a of report.settings.added) log(`    + ${a}`);
  }

  if (report.write) {
    log(`\n  ── מסלול חזרה ──`);
    log(`    ${report.created_ids.length} DailyLog ו-${report.created_menu_ids.length} DailyMenu נושאים import_source = "${report.run_id}"`);
    log(`    ביטול:  node scripts/import-nursery-history.js --undo "${report.run_id}" [--write]`);
  }

  log(report.write ? '\n  נכתב.\n' : '\n  DRY RUN — לא נכתב כלום. הוסף --write כדי לכתוב.\n');
}

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const arg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return fallback;
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
  };
  const has = (name) => argv.includes(`--${name}`);
  const str = (v) => (typeof v === 'string' ? v : null);

  return {
    file: str(arg('file')),
    branch: str(arg('branch')),
    write: has('write'),
    overwrite: has('overwrite'),
    settings: has('settings'),
    verbose: has('verbose'),
    conflict: str(arg('conflict')) || 'richest',
    scope: str(arg('scope')) || 'branch',
    from: str(arg('from')),
    to: str(arg('to')),
    undo: str(arg('undo')),
    manifest: str(arg('manifest')),
    expect: str(arg('expect-db')),
    declaredDry: has('dry-run'),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const usage = (message) => {
    console.error(`\n  ${message}\n`);
    console.error('  node scripts/import-nursery-history.js --file <xlsx> --branch "<שם סניף>" [--write]');
    console.error('  node scripts/import-nursery-history.js --undo "<run id>" [--write]\n');
    process.exit(1);
  };

  const uri = process.env.MONGODB_URI;
  if (!uri) usage('חסר MONGODB_URI');
  const target = describeTarget(uri);

  console.log('');
  console.log(`  מסד יעד:  ${target.host}  /  ${target.db}`);
  if (options.expect && options.expect !== target.db) {
    console.error(`\n  עצירה: ציפית ל-"${options.expect}" והחיבור הוא ל-"${target.db}".\n`);
    process.exit(1);
  }

  if (options.undo) {
    await mongoose.connect(uri);
    const r = await undoImport({ runId: options.undo, write: options.write });
    console.log(`\n  ביטול ייבוא: ${r.runId}`);
    console.log(`  נמצאו:    ${r.found} DailyLog, ${r.menus} DailyMenu`);
    console.log(`  יימחקו:   ${r.removed} DailyLog, ${r.menus} DailyMenu`);
    console.log(`  יישמרו:   ${r.kept.length} רשומות שנערכו מאז הייבוא`);
    for (const k of r.kept.slice(0, 20)) console.log(`    ${k.date} ${k.child_name} — נערך ע"י ${k.updated_by_name || '?'}`);
    console.log(r.write ? '\n  נמחק.\n' : '\n  DRY RUN — לא נמחק כלום. הוסף --write.\n');
    await mongoose.disconnect();
    return;
  }

  if (!options.file) usage('חסר --file');
  if (!options.branch) usage('חסר --branch');
  if (!fs.existsSync(options.file)) usage(`הקובץ לא קיים: ${options.file}`);
  if (!['richest', 'latest'].includes(options.conflict)) usage('--conflict חייב להיות richest או latest');
  if (!['room', 'branch', 'all'].includes(options.scope)) usage('--scope חייב להיות room, branch או all');
  if (options.write && options.declaredDry) usage('--write ו---dry-run יחד — תחליט');

  await mongoose.connect(uri);
  try {
    const report = await importHistory(options);
    printReport(report);

    // The ids as a file as well as a field. The field is what survives a crash
    // halfway through; the file is what a person can read, diff and keep.
    if (options.write && options.manifest) {
      fs.writeFileSync(options.manifest, JSON.stringify({
        run_id: report.run_id,
        branch: report.branch,
        file: report.file,
        at: new Date().toISOString(),
        daily_log_ids: report.created_ids,
        daily_menu_ids: report.created_menu_ids,
        undo: `node scripts/import-nursery-history.js --undo "${report.run_id}" --write`,
      }, null, 2));
      console.log(`  מניפסט: ${options.manifest}\n`);
    }
  } catch (e) {
    if (e.known) { console.error(`\n  ${e.message}\n`); process.exitCode = 1; }
    else throw e;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  importHistory, printReport, parseArgs, nameKey, resolveChild, birthKey,
  undoImport, describeTarget, makeRunId,
};
