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
 * branch nobody ever scheduled. This job closes that gap itself, right after
 * `runPass` returns or throws, writing only `last_error`/`last_run_at`/
 * `sheet_id` — never `shadow` — so the failure becomes visible without ever
 * claiming the two sides agreed on anything. This does not belong inside
 * `runPass`: its ordering (write, then shadow, and nothing else) was reviewed
 * and is load-bearing, and folding a failure write into it would mean the one
 * function whose whole contract is "touch state only when everything held"
 * starts touching state on the way out the door when it didn't.
 *
 * The nightly check (`verifyDay`) is a second, unrelated job sharing this
 * clock, and it gets its own two rules rather than reusing the day pass's:
 *
 *   - It must run at most ONCE per branch per date, not on every tick that
 *     lands inside the 23:00 hour (the tick fires every two minutes, so a
 *     naive `hour >= NIGHTLY_HOUR` re-fetches the archive and reprints the
 *     same alarm — or the same all-clear — roughly thirty times a night). The
 *     rollout gate this feature exists to serve is "a human reads a night's
 *     result and sees zero disagreements"; thirty copies of that result is
 *     how a real alarm gets lost in its own echo. `reconcileDigestJob.js`
 *     solves the identical shape of problem — "did today's version of this
 *     already happen" — with a date-keyed Setting, so this follows that
 *     pattern rather than inventing one: a Setting per branch holds the last
 *     date the check completed, and a tick skips the fetch entirely once
 *     today's date is already there. It is written only after a call that
 *     did NOT throw, mirroring `reconcileDigestJob`'s own rule of only
 *     marking a date "done" once the real attempt actually went through — a
 *     transient failure (below) must still get retried on the next tick
 *     within the same hour, not silently wait for tomorrow.
 *   - A THROW from `verifyDay` (its network read, or a database read of its
 *     own) must never reach `recordFailure`. `verifyDay` is an audit of a
 *     day the sync pass already finished; a Sheets API hiccup while auditing
 *     it says nothing about whether that pass held together, and
 *     `SheetSyncState.last_error`'s entire meaning is "did the sync pass
 *     fail". So the nightly check gets its own try/catch, entirely separate
 *     from the day pass's, and a throw here is logged as the audit failing —
 *     never as a sync failure.
 */
const KEY = 'nursery_sheet_sync';
const NIGHTLY_RAN_KEY = 'nursery_sheet_sync_nightly_ran';
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
    // One Setting per branch, same idiom as reconcileDigestJob's SENT_KEY:
    // its value is simply the last date this branch's nightly check went
    // through, and a tick compares today's date against it.
    readNightlyRan: async (branchId) => {
      const s = await Setting.findOne({ key: `${NIGHTLY_RAN_KEY}:${branchId}` }).lean();
      return (s && s.value) || null;
    },
    markNightlyRan: async (branchId, date) => {
      await Setting.findOneAndUpdate(
        { key: `${NIGHTLY_RAN_KEY}:${branchId}` },
        { $set: { value: date } },
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

    if (hour >= OPEN_FROM && hour < OPEN_TO) {
      try {
        const passResult = await d.runPass({ branchId: b.branch_id, sheetId: b.sheet_id, date, mode });
        out.push({ branch: String(b.branch_id), ...passResult });
        // The second silent-failure mode: pairRows refused the structure, so
        // runPass returned before reading a child or writing a cell. Nothing
        // threw, so the catch below never sees this one — it has to be
        // checked for on the happy path.
        if (passResult.errors && passResult.errors.length) {
          // `pairRows` (roster.js) reports its refusals as plain strings, not
          // objects — this stays defensive about that shape rather than
          // assuming it, so a future error carrying more structure still
          // produces a readable message instead of "[object Object]".
          const message = passResult.errors
            .map((e) => (typeof e === 'string' ? e : (e.reason || e.message || JSON.stringify(e))))
            .join('; ');
          await d.recordFailure(b.branch_id, b.sheet_id, date, message);
        }
      } catch (e) {
        console.error(`[sheet-sync] ${b.sheet_id} failed:`, e.message);
        // The first silent-failure mode: a thrown error, most likely
        // `writeCells` refusing the write. `runPass` is correct not to touch
        // `SheetSyncState` on its way out — see the file header — so it
        // falls to this catch to record that the branch was attempted and
        // failed, without claiming anything about the shadow it never
        // advanced.
        try {
          await d.recordFailure(b.branch_id, b.sheet_id, date, e.message);
        } catch (re) {
          console.error(`[sheet-sync] ${b.sheet_id}: could not even record the failure:`, re.message);
        }
        out.push({ branch: String(b.branch_id), error: e.message });
      }
    }

    if (hour >= NIGHTLY_HOUR) {
      // eslint-disable-next-line no-await-in-loop
      const already = await d.readNightlyRan(b.branch_id);
      if (already !== date) {
        try {
          // eslint-disable-next-line no-await-in-loop
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
          // Marked only now, having actually gone through — a call that
          // throws (below) must not mark tonight as done, or a transient
          // hiccup would silently cancel the one alarm this design has for
          // the rest of the night.
          // eslint-disable-next-line no-await-in-loop
          await d.markNightlyRan(b.branch_id, date);
        } catch (e) {
          // This is the audit failing, not the sync pass — see the file
          // header. Logged as its own thing, on purpose worded so it cannot
          // be mistaken for the day's sync failing, and never routed to
          // `recordFailure`: SheetSyncState.last_error must keep meaning
          // only "the sync pass did not hold together".
          console.error(`[sheet-sync] nightly audit failed for ${b.sheet_id} (the archive check, not the sync pass):`, e.message);
          out.push({ branch: String(b.branch_id), auditError: e.message });
        }
      }
    }
  }
  return { ran: out };
}

module.exports = { tick, KEY, israelNow };
