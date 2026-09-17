/**
 * Who the gan says is here, against who has a card.
 *
 * Every branch keeps its real roster somewhere other than `Child`:
 *
 *   כפר סבא - קפלן registers in this system, so its truth is `Registration` —
 *   the רישום screen, which is also what the collections flow is built on.
 *
 *   The other three sit under רשת מעונות אמונה and register in קליקטאק, so
 *   their truth arrives as `ExternalEnrollment` — the רישום חיצוני screen.
 *   The data agrees: קפלן has zero external rows and the others have
 *   hundreds.
 *
 * `Child` is downstream of both, and it drifts. A card is created when
 * somebody gets to it, its `academic_year` is stamped once and not revisited,
 * and a year later the roster has moved on without it. In קפלן on 17.09.2026
 * that meant 31 registrations for the current year against 12 matching cards:
 * fifteen cards still said last year, and four children had no card at all —
 * two of them with a completed registration, which is to say children in the
 * gan that the system had never heard of.
 *
 * Nothing here writes. It answers "what disagrees, and with what", and the
 * screen decides what to do about each row — because "this child left" and
 * "this card was never made" look identical from here and only a person at the
 * gan knows which it is.
 *
 * Pure: rows in, findings out. No database, no network.
 */

/** The three ways a roster entry and a child card can fail to line up. */
const KINDS = {
  NO_CARD: 'no_card',       // the roster has her; nothing in Child does
  STALE_YEAR: 'stale_year', // the card exists and still says a previous year
  ORPHAN_CARD: 'orphan_card', // a current-year card no roster entry accounts for
  DUPLICATE_CARD: 'duplicate_card', // two cards claiming the same year
};

/**
 * Names, reduced to what two people typing them would agree on.
 *
 * Deliberately the same helper the rest of the system compares children with
 * (`academic-year.service#normalizeChildName`), passed in rather than imported
 * so this file stays free of everything.
 */
/**
 * One letter apart — דוד against דויד, and nothing looser.
 *
 * Deliberately not a similarity score. A threshold invites tuning, and a tuned
 * threshold eventually pairs two different children with a shrug. One edit is
 * the distance between a name typed twice by two people.
 */
function levenshteinAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function indexByName(rows, normalize) {
  const map = new Map();
  for (const r of rows) {
    const key = normalize(r.name);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/**
 * Compare one branch's roster against its cards.
 *
 * @param {object} input
 * @param {'registration'|'external'} input.source  which screen the roster came from
 * @param {Array<{id,name,id_number,status,classroom_name}>} input.roster
 * @param {Array<{id,name,academic_year,classroom_name,classroom_year}>} input.cards
 *        every card in this branch, whatever year it claims
 * @param {string} input.year  the academic year being asked about
 * @param {(s:string)=>string} input.normalize
 */
function compareRoster({ source, roster, cards, year, normalize }) {
  const byName = indexByName(cards, normalize);
  const seen = new Set();
  const findings = [];
  const duplicates = [];

  // A roster that lists one child twice is its own finding: two registrations
  // for one name is either a genuine second child or somebody registering
  // again, and both are answered by a person rather than by a rule.
  const rosterByName = indexByName(roster, normalize);
  for (const [key, rows] of rosterByName) {
    if (rows.length > 1) {
      duplicates.push({ name: rows[0].name, count: rows.length, entries: rows });
    }
    void key;
  }

  for (const entry of roster) {
    const key = normalize(entry.name);
    const matches = byName.get(key) || [];
    if (matches.length === 0) {
      findings.push({
        kind: KINDS.NO_CARD,
        name: entry.name,
        id_number: entry.id_number || '',
        roster_status: entry.status || '',
        roster_classroom: entry.classroom_name || '',
        roster_id: entry.id,
        card_id: null,
        card_year: null,
      });
      continue;
    }
    // A child normally has more than one card: one per year she has been here.
    // That is not a problem — it is what a year looks like from the inside —
    // so the card FOR THIS YEAR is the one that answers the question, and the
    // others are simply her history.
    //
    // Calling every such child "no card" was this file's first bug, and it
    // turned 4 genuinely missing cards in קפלן into 19.
    const forThisYear = matches.filter((c) => c.academic_year === year);
    if (forThisYear.length > 1) {
      // Two cards claiming the SAME year is a real duplicate, and picking one
      // would hide it.
      findings.push({
        kind: KINDS.DUPLICATE_CARD,
        name: entry.name,
        id_number: entry.id_number || '',
        roster_status: entry.status || '',
        roster_classroom: entry.classroom_name || '',
        roster_id: entry.id,
        card_id: null,
        card_year: year,
        ambiguous: forThisYear.map((c) => ({ id: c.id, name: c.name, year: c.academic_year, classroom: c.classroom_name })),
      });
      matches.forEach((c) => seen.add(String(c.id)));
      continue;
    }
    matches.forEach((c) => seen.add(String(c.id)));
    // Her card for this year if she has one; otherwise the most recent card
    // she has, which is what "the card is still on last year" is about.
    const card = forThisYear[0]
      || matches.slice().sort((a, b) => String(b.academic_year).localeCompare(String(a.academic_year)))[0];
    if (card.academic_year !== year) {
      findings.push({
        kind: KINDS.STALE_YEAR,
        name: entry.name,
        id_number: entry.id_number || '',
        roster_status: entry.status || '',
        roster_classroom: entry.classroom_name || '',
        roster_id: entry.id,
        card_id: card.id,
        card_year: card.academic_year || '',
        card_classroom: card.classroom_name || '',
        card_classroom_year: card.classroom_year || '',
      });
    }
  }

  // A card claiming the current year that no roster entry accounts for. Not
  // necessarily wrong — a child can be entered here directly — but it is the
  // question the screen exists to raise, since the roster is the truth.
  for (const card of cards) {
    if (card.academic_year !== year) continue;
    if (seen.has(String(card.id))) continue;
    findings.push({
      kind: KINDS.ORPHAN_CARD,
      name: card.name,
      card_id: card.id,
      card_year: card.academic_year,
      card_classroom: card.classroom_name || '',
      roster_id: null,
    });
  }

  // A name in one list and nearly the same name in the other.
  //
  // In קפלן three of the four "no card" rows had an orphan card sitting beside
  // them — יהונתן דויד לוי against יהונתן דוד לוי, עמליה שקורי against עמליה,
  // אורי אדיב against אורי. One list writes the full name and the other writes
  // what the family is called, and a person reading the two columns sees it in
  // a second while a string comparison never will.
  //
  // Offered as a HINT and never acted on: two children really can be called
  // אורי, and the whole point of this screen is that a person decides.
  const orphans = findings.filter((f) => f.kind === KINDS.ORPHAN_CARD);
  for (const f of findings) {
    if (f.kind !== KINDS.NO_CARD) continue;
    const a = normalize(f.name);
    const near = orphans.filter((o) => {
      const b = normalize(o.name);
      if (!a || !b || a === b) return false;
      return a.startsWith(b) || b.startsWith(a) || levenshteinAtMostOne(a, b);
    });
    if (near.length) {
      f.maybe = near.map((o) => ({ card_id: o.card_id, name: o.name, classroom: o.card_classroom }));
    }
  }

  const counts = findings.reduce((acc, f) => {
    acc[f.kind] = (acc[f.kind] || 0) + 1;
    return acc;
  }, {});

  return {
    source,
    year,
    roster_count: roster.length,
    card_count: cards.filter((c) => c.academic_year === year).length,
    matched: roster.length
      - (counts[KINDS.NO_CARD] || 0)
      - (counts[KINDS.STALE_YEAR] || 0)
      - (counts[KINDS.DUPLICATE_CARD] || 0),
    counts,
    findings,
    duplicates,
  };
}

module.exports = { compareRoster, KINDS };
