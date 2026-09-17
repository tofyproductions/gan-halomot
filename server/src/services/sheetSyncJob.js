/**
 * The sync's clock.
 *
 * Off unless `nursery_sheet_sync` is configured, and readable without a
 * deploy: this runs against a board the staff are using right now, and the way
 * to stop it has to be faster than a push.
 *
 * The setting is
 *   { enabled: bool, write: bool, branches: [{ branch_id, sheet_id }] }
 * with `write` separate from `enabled` on purpose — the safe half (sheet → us)
 * can run for a day while the other half is still being watched.
 *
 * `runPass` (see sheet-sync/run.js) has two ways to fail without ever calling
 * its own `saveShadow`, and that is deliberate there: a failed pass must never
 * advance the shadow, or the next pass would see "nobody changed anything" and
 * both sides' real edits would vanish together.
 *   1. It rejects — a thrown error, e.g. `writeCells` refusing the write.
 *   2. It resolves normally but with `errors.length > 0`, because `pairRows`
 *      refused the roster's structure before anything was read or written.
 * Because `saveShadow` is also the only writer of `SheetSyncState.last_error`
 * and `last_run_at`, neither failure leaves any trace there. A branch that has
 * been refusing to pair for three days looks, in the database, exactly like a
 * branch nobody ever scheduled. This job closes that gap itself, after
 * `runPass` returns or throws, writing only `last_error`/`last_run_at`/
 * `sheet_id` — never `shadow` — so the failure becomes visible without ever
 * claiming the two sides agreed on anything. This does not belong inside
 * `runPass`: its ordering (write, then shadow, and nothing else) was reviewed
 * and is load-bearing, and folding a failure write into it would mean the one
 * function whose whole contract is "touch state only when everything held"
 * starts touching state on the way out the door when it didn't.
 */
const KEY = 'nursery_sheet_sync';
const OPEN_FROM = 5;   // 05:00
const OPEN_TO = 19;    // 19:00
const NIGHTLY_HOUR = 23;

function israelNow(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false,
  }).format(now));
  return { date, hour };
}

function defaultDeps() {
  const { Setting, SheetSyncState } = require('../models');
  const { runPass } = require('./sheet-sync/run');
  const { verifyDay } = require('./sheet-sync/nightly');
  return {
    readSetting: async () => {
      const setting = await Setting.findOne({ key: KEY }).lean();
      return (setting && setting.value) || {};
    },
    runPass,
    verifyDay,
    // Deliberately narrow: only the three fields a failure can honestly claim.
    // `shadow`, `conflicts_count`, `wrote_in`, `wrote_out` are left out of the
    // $set entirely rather than zeroed, so a branch's last real shadow (and
    // the pass that produced it) survives however many failed attempts follow
    // it, exactly as a reader of `SheetSyncState` would expect "the last time
    // this actually agreed" to behave.
    recordFailure: async (branchId, sheetId, date, message) => {
      await SheetSyncState.updateOne(
        { branch_id: branchId, date },
        { $set: { sheet_id: sheetId, last_run_at: new Date(), last_error: message } },
        { upsert: true },
      );
    },
  };
}

async function tick(now = new Date(), deps = null) {
  const d = deps || defaultDeps();
  const cfg = await d.readSetting();
  if (!cfg.enabled) return { skipped: 'disabled' };
  const branches = Array.isArray(cfg.branches) ? cfg.branches : [];
  if (branches.length === 0) return { skipped: 'no branches' };

  const { date, hour } = israelNow(now);
  const mode = cfg.write ? 'write' : 'dry';
  const out = [];

  for (const b of branches) {
    if (!b.branch_id || !b.sheet_id) continue;
    try {
      if (hour >= OPEN_FROM && hour < OPEN_TO) {
        const passResult = await d.runPass({ branchId: b.branch_id, sheetId: b.sheet_id, date, mode });
        out.push({ branch: String(b.branch_id), ...passResult });
        // The second silent-failure mode: pairRows refused the structure, so
        // runPass returned before reading a child or writing a cell. Nothing
        // threw, so the catch below never sees this one — it has to be
        // checked for on the happy path.
        if (passResult.errors && passResult.errors.length) {
          const message = passResult.errors.map((e) => e.reason || e.message || JSON.stringify(e)).join('; ');
          // eslint-disable-next-line no-await-in-loop
          await d.recordFailure(b.branch_id, b.sheet_id, date, message);
        }
      }
      if (hour >= NIGHTLY_HOUR) {
        const v = await d.verifyDay({ branchId: b.branch_id, sheetId: b.sheet_id, date });
        if (v.error) {
          // The archive cell for tonight exists but did not parse — not a
          // disagreement, there is nothing to compare yet.
          console.error(`[sheet-sync] ${date} ${b.sheet_id}: nightly archive did not parse — ${v.error}`);
        } else {
          if (v.disagreed.length) {
            console.error(`[sheet-sync] ${date} ${b.sheet_id}: ${v.disagreed.length} disagreements with the nightly archive`);
            v.disagreed.slice(0, 20).forEach((x) => console.error(`  ${x.name} · ${x.field} · ארכיון="${x.archive}" אצלנו="${x.ours}"`));
          }
          if (v.unresolved.length) {
            console.error(`[sheet-sync] ${date} ${b.sheet_id}: ${v.unresolved.length} accessId(s) the nightly check could not resolve to one child`);
          }
        }
        out.push({ branch: String(b.branch_id), verify: v });
      }
    } catch (e) {
      console.error(`[sheet-sync] ${b.sheet_id} failed:`, e.message);
      // The first silent-failure mode: a thrown error, most likely
      // `writeCells` refusing the write. `runPass` is correct not to touch
      // `SheetSyncState` on its way out — see the file header — so it falls
      // to this catch to record that the branch was attempted and failed,
      // without claiming anything about the shadow it never advanced.
      try {
        await d.recordFailure(b.branch_id, b.sheet_id, date, e.message);
      } catch (re) {
        console.error(`[sheet-sync] ${b.sheet_id}: could not even record the failure:`, re.message);
      }
      out.push({ branch: String(b.branch_id), error: e.message });
    }
  }
  return { ran: out };
}

module.exports = { tick, KEY, israelNow };
