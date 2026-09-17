/**
 * The sync's clock.
 *
 * Off unless `nursery_sheet_sync` is configured, and readable without a
 * deploy: this runs against a board the staff are using right now, and the way
 * to stop it has to be faster than a push.
 *
 * The setting is
 *   { enabled: bool, write: bool,
 *     branches: [{ branch_id, sheet_id, write }] }
 *
 * `write` is separate from `enabled` on purpose — the safe half (sheet → us)
 * can run for a day while the other half is still being watched — and it lives
 * on the BRANCH, because the rollout it exists to serve is per branch: משה דיין
 * first, watched for a full day and a clean night, then קפלן. A single global
 * flag makes that plan unexecutable, because the only way to hold a newly
 * added branch back would be to leave it out of `branches` entirely, which
 * also switches off the read-only sync and the nightly audit it needs in order
 * to earn its clean night. So a branch writes only when its own entry says so;
 * a branch with no `write` of its own is dry, never inheriting it from
 * anywhere. The top-level `write: false` stays as a master off — one edit
 * stops every branch writing without touching their individual settings.
 *
 * A dry branch changes nothing on either board, but this file still writes
 * two small pieces of state in any mode, deliberately. `recordFailure` upserts
 * a `SheetSyncState` and the nightly marker upserts a `Setting`: diagnostics
 * are needed MOST during the read-only phase, since that phase exists to be
 * judged, and neither of them touches `shadow` or a child's day. "Dry" here
 * means the two boards are left exactly as they were, not that the process is
 * literally write-free.
 *
 * `runPass` (see sheet-sync/run.js) has two ways to fail without ever calling
 * its own `saveShadow`, and that is deliberate there: a failed pass must never
 * advance the shadow, or the next pass would see "nobody changed anything" and
 * both sides' real edits would vanish together.
 *   1. It rejects — a thrown error, e.g. `writeCells` refusing the write, or
 *      a `mode` it does not recognise.
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
 * clock, and it gets its own rules rather than reusing the day pass's:
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
 *     today's date is already there.
 *   - A night is marked done only by an audit that actually COMPARED
 *     something. "Did not throw" is far too weak, and there are three ways to
 *     come back having compared nobody, all of which used to be — or would
 *     otherwise be — byte-identical to a fully-audited, zero-disagreement
 *     night in every field a caller reads:
 *       · tonight's archive row has not been written yet (the archive job's
 *         real write times run 23:28-23:37, so the first tick or two of every
 *         single night sees this) — `archive_found: false`;
 *       · the row exists but its JSON will not parse;
 *       · the row exists, parses, and names nobody — the gan closed on a
 *         Saturday and the archive job fired over an empty board, or the
 *         roster's identity column was cleared.
 *     Each gets its own key in this tick's result — `auditPending`,
 *     `auditUnparsable`, `auditEmpty` — and none of them marks the night
 *     done, so the check keeps trying for the rest of the hour. `verify`
 *     means one thing only: an audit that compared at least one child and
 *     therefore has something to say. Nothing reading `tick()`'s output, now
 *     or later, can mistake "nothing was compared" for "compared and clean",
 *     because the two never share a key.
 *   - The audit's window is the 23:00 hour of the date being audited, which
 *     is about twenty minutes of margin after the archive lands. A deploy, a
 *     restart, or an archive written at 00:05 costs that date its only
 *     chance. The archive row for an old date is still perfectly readable
 *     the next night, so the check reaches back exactly ONE night for a date
 *     nobody ever audited — once, not every tick — and anything older than
 *     that is counted and named rather than audited. This is deliberately
 *     not a backfill: an operator counting clean nights has to be able to
 *     see the nights that never happened, and one night of reach is what
 *     covers the ordinary restart without turning this into a catch-up
 *     machine.
 *   - A THROW from `verifyDay` (its network read, or a database read of its
 *     own) must never reach `recordFailure`. `verifyDay` is an audit of a
 *     day the sync pass already finished; a Sheets API hiccup while auditing
 *     it says nothing about whether that pass held together, and
 *     `SheetSyncState.last_error`'s entire meaning is "did the sync pass
 *     fail". So the nightly check gets its own try/catch, entirely separate
 *     from the day pass's, and a throw here is reported as the audit failing
 *     — never as a sync failure.
 *
 * Nothing in here prints. `tick()` returns what happened and `describeTick`
 * turns it into log lines, which is what lets the suite assert on a clean
 * pass and a clean night — the two outcomes that used to produce no evidence
 * of any kind, and which the rollout decision is made from.
 */
const KEY = 'nursery_sheet_sync';
const NIGHTLY_RAN_KEY = 'nursery_sheet_sync_nightly_ran';
const OPEN_FROM = 5;   // 05:00
const OPEN_TO = 19;    // 19:00
const NIGHTLY_HOUR = 23;
// One night back for a date that never got audited, and no further. See the
// header: this is a restart's worth of reach, not a backfill.
const CATCHUP_NIGHTS = 1;

function israelNow(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false,
  }).format(now));
  return { date, hour };
}

/**
 * A `YYYY-MM-DD` shifted by whole days.
 *
 * Plain calendar arithmetic on the date the rest of this file already speaks,
 * done in UTC so that a shift never lands on a DST boundary and comes back a
 * day out. These strings also sort lexicographically, which is why the
 * comparisons below can use `>` and `<=` directly.
 */
function shiftDay(date, delta) {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
    + (delta * 86400000);
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Has this condition already been stated today?
 *
 * Some of what this job reports persists — a misconfigured Setting entry, a
 * night whose archive lists nobody, a run of nights nobody audited. The tick
 * fires every two minutes, so a condition that lasts an evening would print
 * thirty times, which is the same way a real alarm gets lost that the
 * once-a-night rule above exists to prevent. Each such condition is stated
 * once per day and then carried silently in the result, where anything that
 * wants it can still see it. Cleared on the date rolling over, so the state
 * cannot grow beyond a day's worth of distinct conditions.
 */
let announcedOn = null;
const announced = new Set();
function firstTimeToday(date, key) {
  if (announcedOn !== date) { announced.clear(); announcedOn = date; }
  if (announced.has(key)) return false;
  announced.add(key);
  return true;
}
/**
 * The last day-pass line printed for each branch, and the hour it went out.
 *
 * A pass runs every two minutes for fourteen hours — 420 a day per branch, 840
 * with both — and on an ordinary day every one of them says the same thing.
 * The one line that reads "3 in, 1 conflicts" then scrolls past inside 419
 * copies of its neighbour, on a host with a bounded log buffer, during the
 * read-only day whose log IS the evidence the write-back decision rests on.
 *
 * This module already made that argument once, about the nightly check firing
 * thirty times an hour, and then let the day pass emit fourteen times that
 * volume. So: print when something changed, print every refusal and every
 * failure whatever happened before, and print once an hour regardless so
 * "it is still running and still quiet" stays visible.
 */
const lastPassLine = new Map();
function passIsWorthPrinting(key, signature, hour) {
  const prev = lastPassLine.get(key);
  if (prev && prev.signature === signature && prev.hour === hour) return false;
  lastPassLine.set(key, { signature, hour });
  return true;
}

/** For the suite: a scenario must not inherit the previous one's silence. */
function resetAnnouncements() { announced.clear(); announcedOn = null; lastPassLine.clear(); }

/**
 * Which mode this branch runs in.
 *
 * Opt-in per branch, master off globally. A branch that says nothing about
 * `write` is dry — inheriting write-back is exactly how a branch that has
 * never had a read-only day starts writing to a live board on its first tick.
 */
function modeFor(cfg, branch) {
  if (cfg.write === false) return 'dry';
  return branch.write === true ? 'write' : 'dry';
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
    // its value is the most recent date this branch's nightly check actually
    // completed an audit for. A tick compares today's date against it, and
    // the gap between it and today is how a night nobody audited becomes
    // visible at all.
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

  const { date, hour } = israelNow(now);
  const branches = Array.isArray(cfg.branches) ? cfg.branches : [];
  // Enabled with nothing to run is a half-finished edit of a Setting that is
  // changed without a deploy, so it is said out loud rather than treated as
  // the same silence as being switched off.
  if (branches.length === 0) {
    return { skipped: 'no branches', announce: firstTimeToday(date, 'no-branches') };
  }

  const out = [];

  for (let i = 0; i < branches.length; i += 1) {
    const b = branches[i];
    // The likeliest operator error there is: this Setting is hand-edited, in
    // a database, without a deploy, so `branchId` for `branch_id` is one
    // keystroke away. Such an entry never syncs and never audits, and from
    // the outside it is indistinguishable from a branch that is working —
    // which is precisely why it is reported by name and by missing key
    // instead of being passed over.
    const missing = ['branch_id', 'sheet_id'].filter((k) => !b[k]);
    if (missing.length) {
      out.push({
        entry: i,
        branch: b.branch_id ? String(b.branch_id) : '',
        sheet: b.sheet_id ? String(b.sheet_id) : '',
        misconfigured: missing,
        announce: firstTimeToday(date, `misconfigured:${i}:${missing.join(',')}`),
      });
      continue;
    }

    const branch = String(b.branch_id);
    const sheet = String(b.sheet_id);
    const mode = modeFor(cfg, b);

    if (hour >= OPEN_FROM && hour < OPEN_TO) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const passResult = await d.runPass({ branchId: b.branch_id, sheetId: b.sheet_id, date, mode });
        out.push({ branch, sheet, mode, hour, ...passResult });
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
          // eslint-disable-next-line no-await-in-loop
          await d.recordFailure(b.branch_id, b.sheet_id, date, message);
        }
      } catch (e) {
        // The first silent-failure mode: a thrown error, most likely
        // `writeCells` refusing the write. `runPass` is correct not to touch
        // `SheetSyncState` on its way out — see the file header — so it
        // falls to this catch to record that the branch was attempted and
        // failed, without claiming anything about the shadow it never
        // advanced.
        try {
          // eslint-disable-next-line no-await-in-loop
          await d.recordFailure(b.branch_id, b.sheet_id, date, e.message);
        } catch (re) {
          out.push({ branch, sheet, mode, unrecordedError: re.message });
        }
        out.push({ branch, sheet, mode, error: e.message });
      }
    }

    if (hour >= NIGHTLY_HOUR) {
      // eslint-disable-next-line no-await-in-loop
      const marker = await d.readNightlyRan(b.branch_id);
      const reachBack = shiftDay(date, -CATCHUP_NIGHTS);
      // Only ever reached back for when there IS a marker: with no marker at
      // all this branch has never completed an audit, and reaching into a
      // past it was not even running for would report an absent archive as a
      // problem on the first night it is switched on.
      const wantCatchup = Boolean(marker) && reachBack > marker;

      const dates = [];
      // Once a night, not once a tick: today's audit is worth retrying every
      // two minutes because the archive is expected to land mid-hour, while
      // last night's row either exists already or never will.
      if (wantCatchup && firstTimeToday(date, `catchup:${branch}`)) dates.push(reachBack);
      if (marker !== date) dates.push(date);

      // Everything between the last completed audit and the oldest night this
      // check is willing to reach back for. Those nights had one window each
      // and it has closed. Counted and named, because the whole purpose of the
      // marker is to let a person count clean nights, and a night that never
      // ran must not be counted as one of them.
      if (marker) {
        const from = shiftDay(marker, 1);
        const to = shiftDay(wantCatchup ? reachBack : date, -1);
        if (from <= to) {
          out.push({
            branch, sheet, missedNights: { from, to },
            announce: firstTimeToday(date, `missed:${branch}:${from}:${to}`),
          });
        }
      }

      for (const auditDate of dates) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const v = await d.verifyDay({ branchId: b.branch_id, sheetId: b.sheet_id, date: auditDate });
          if (!v.archive_found) {
            // The ordinary case for the first tick or two of the hour, and
            // not worth a word: the archive job simply has not written
            // tonight's row yet. Left unmarked so the next tick tries again.
            out.push({ branch, sheet, date: auditDate, auditPending: true });
          } else if (v.error) {
            out.push({
              branch, sheet, date: auditDate, auditUnparsable: v.error,
              announce: firstTimeToday(date, `unparsable:${branch}:${auditDate}`),
            });
          } else if (!v.checked) {
            out.push({
              branch, sheet, date: auditDate, auditEmpty: true,
              entries: v.entries || 0, unresolved: (v.unresolved || []).length,
              announce: firstTimeToday(date, `empty:${branch}:${auditDate}`),
            });
          } else {
            out.push({ branch, sheet, date: auditDate, verify: v });
            // Marked only now: an audit that found a real archive row and
            // compared at least one child against it. Anything weaker leaves
            // the night open, because the marker is read both as "do not
            // repeat this tonight" and as "this night was audited", and the
            // second meaning is the one the rollout decision rests on.
            // eslint-disable-next-line no-await-in-loop
            await d.markNightlyRan(b.branch_id, auditDate);
          }
        } catch (e) {
          // This is the audit failing, not the sync pass — see the file
          // header. Reported as its own thing and never routed to
          // `recordFailure`: SheetSyncState.last_error must keep meaning only
          // "the sync pass did not hold together".
          out.push({
            branch, sheet, date: auditDate, auditError: e.message,
            announce: firstTimeToday(date, `auditError:${branch}:${auditDate}`),
          });
        }
      }
    }
  }
  return { ran: out };
}

/**
 * What a tick did, as lines for the log.
 *
 * The spec promises a full log — every field written, which way, by which run
 * — and the rollout gate is a person reading a day of it and then a night of
 * it. Until this existed, a pass that read the board and agreed with it
 * printed nothing at all, which is also exactly what a disabled sync, a
 * misconfigured branch, a crashed interval and an audit that compared nobody
 * all printed. Silence has to mean one thing, so here it means only "switched
 * off".
 *
 * One line per branch per event, and the counts are what a person reads: a
 * pass says how many children it saw and how many fields moved each way, an
 * audit says how many children it compared. Levels are separated so a real
 * disagreement lands in the error stream beside the sibling jobs' failures
 * and an ordinary day does not.
 */
function describeTick(result) {
  const r = result || {};
  const lines = [];
  const log = (text) => lines.push({ level: 'log', text });
  const error = (text) => lines.push({ level: 'error', text });

  if (r.skipped === 'no branches') {
    if (r.announce) error('[sheet-sync] enabled with no branches configured — nothing syncs and nothing is audited');
    return lines;
  }
  // Switched off is how this ships and how it spends most of its life. It is
  // the one state that is allowed to say nothing.
  if (r.skipped) return lines;

  for (const e of (r.ran || [])) {
    const at = `${e.date || ''} ${e.sheet || ''}`.trim();

    if (e.misconfigured) {
      if (e.announce) {
        error(`[sheet-sync] branches[${e.entry}] in the ${KEY} setting is missing ${e.misconfigured.join(' and ')} — that branch never syncs and is never audited`);
      }
    } else if (e.missedNights) {
      if (e.announce) {
        const { from, to } = e.missedNights;
        error(from === to
          ? `[sheet-sync] ${e.sheet}: the night of ${from} was never audited and no longer can be`
          : `[sheet-sync] ${e.sheet}: the nights ${from} to ${to} were never audited and no longer can be`);
      }
    } else if (e.unrecordedError) {
      error(`[sheet-sync] ${e.sheet}: could not even record the failure — ${e.unrecordedError}`);
    } else if (e.error) {
      error(`[sheet-sync] ${at} (${e.mode}) failed: ${e.error}`);
    } else if (e.errors && e.errors.length) {
      error(`[sheet-sync] ${at} (${e.mode}): the pass refused — ${e.errors.map(String).join('; ')}`);
    } else if (e.children !== undefined) {
      const skipped = e.skipped || [];
      const signature = `${e.children}|${e.in}|${e.out}|${e.conflicts}|${skipped.length}`;
      if (passIsWorthPrinting(`${e.branch}|${e.date}`, signature, e.hour)) {
        log(`[sheet-sync] ${at} (${e.mode}): ${e.children} children, ${e.in} in, ${e.out} out, ${e.conflicts} conflicts, ${skipped.length} skipped`);
      }
      // A refusal is never quiet, and never a bare count. "1 skipped" cannot
      // tell anybody that a child's supplies list is unwritable, and the
      // reason is already in hand — it was simply never printed.
      if (skipped.length) {
        const byWhy = new Map();
        for (const s of skipped) {
          const why = s.why || 'לא צוין';
          if (!byWhy.has(why)) byWhy.set(why, []);
          byWhy.get(why).push([s.name, s.field].filter(Boolean).join(' · ') || s.access_id || '?');
        }
        for (const [why, who] of byWhy) {
          if (!firstTimeToday(e.date, `skip|${e.branch}|${why}`)) continue;
          error(`[sheet-sync] ${at}: ${who.length} × ${why} — ${who.slice(0, 10).join(', ')}${who.length > 10 ? ` +${who.length - 10}` : ''}`);
        }
      }
    } else if (e.auditPending) {
      // Nothing. The archive job writes its row around 23:30 and this check
      // starts at 23:00; saying so every two minutes would drown the night's
      // one real result.
    } else if (e.auditUnparsable) {
      if (e.announce) error(`[sheet-sync] ${at}: the nightly archive row does not parse — ${e.auditUnparsable}. Nothing was compared; the night is NOT audited`);
    } else if (e.auditEmpty) {
      if (e.announce) {
        error(e.unresolved
          ? `[sheet-sync] ${at}: the nightly archive names ${e.entries} children and none of them resolved to a single child here (${e.unresolved} unresolved). Nothing was compared; the night is NOT audited`
          : `[sheet-sync] ${at}: the nightly archive row names nobody. Nothing was compared; the night is NOT audited`);
      }
    } else if (e.auditError) {
      if (e.announce) error(`[sheet-sync] ${at}: the nightly audit failed (the archive check, not the sync pass) — ${e.auditError}`);
    } else if (e.verify) {
      const v = e.verify;
      log(`[sheet-sync] ${at}: nightly audit compared ${v.checked} children, ${v.agreed} agreed, ${v.disagreed.length} disagreed`);
      if (v.disagreed.length) {
        error(`[sheet-sync] ${at}: ${v.disagreed.length} disagreements with the nightly archive`);
        // Named, not counted: a positional slip shows itself as a run of
        // children whose days landed one row over, and the names are what
        // makes that recognisable at a glance.
        v.disagreed.slice(0, 20).forEach((x) => error(`  ${x.name} · ${x.field} · ארכיון="${x.archive}" אצלנו="${x.ours}"`));
      }
      if ((v.unresolved || []).length) {
        error(`[sheet-sync] ${at}: ${v.unresolved.length} accessId(s) the nightly check could not resolve to one child`);
      }
      // A data-quality signal, not an identity alarm, and it is reported as
      // such: a garbled cell says nothing about whether the pairing held, and
      // filing it beside a real disagreement is how the disagreement stops
      // being believed. Produced by verifyDay since the day it was written
      // and, until now, read by nobody.
      if ((v.unreadable || []).length) {
        log(`[sheet-sync] ${at}: ${v.unreadable.length} archive cell(s) could not be read and were left out of the comparison`);
      }
    }
  }
  return lines;
}

module.exports = { tick, describeTick, resetAnnouncements, KEY, israelNow, shiftDay };
