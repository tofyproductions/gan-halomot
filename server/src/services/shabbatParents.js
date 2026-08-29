/**
 * אבא ואמא של שבת — whose turn it is.
 *
 * Every Friday one boy is אבא של שבת and one girl is אמא של שבת. The rule the
 * gan actually runs on is simple and is the whole point: nobody goes twice
 * until everybody has gone once. A four-year-old counts, and the gananet is
 * the one who gets asked why.
 *
 * Until now the two names were free text typed into the plan, so keeping the
 * round straight meant remembering it — across five weeks a month, two rooms,
 * and whoever happened to be writing that month.
 *
 * The round is DERIVED from the plans rather than stored as a counter. A
 * counter drifts the first time somebody edits an old month, deletes a week,
 * or a child leaves in March; reading the turns back out of the plans cannot
 * drift, because the plans are the record.
 */

/** Boys and girls, separately, because they are two independent rotations. */
const GENDERS = ['boy', 'girl'];

/**
 * Walk the turns in order and work out where the current round stands.
 *
 * A round closes the moment every child of that gender has had a turn, and the
 * next turn starts an empty one. Children whose gender nobody has set yet are
 * not in either rotation — they are not "waiting", they are unanswered, and
 * the screen asks rather than guessing.
 *
 * @param {Array} children [{ id, name, gender }]
 * @param {Array} history  [{ date, father_child_id, mother_child_id }], ascending
 */
function rotation(children, history) {
  const roster = {
    boy: children.filter(c => c.gender === 'boy'),
    girl: children.filter(c => c.gender === 'girl'),
  };

  // Who has had a turn in the round that is open right now, and when each
  // child last went at all.
  const servedNow = { boy: new Set(), girl: new Set() };
  const lastAt = new Map();
  const timesAll = new Map();

  const ids = {
    boy: new Set(roster.boy.map(c => String(c.id))),
    girl: new Set(roster.girl.map(c => String(c.id))),
  };

  for (const turn of history || []) {
    for (const gender of GENDERS) {
      const childId = String(turn[gender === 'boy' ? 'father_child_id' : 'mother_child_id'] || '');
      if (!childId) continue;

      lastAt.set(childId, turn.date);
      timesAll.set(childId, (timesAll.get(childId) || 0) + 1);

      // A child who has left the room still had a turn, but they cannot hold
      // the round open for the children who are still here.
      if (!ids[gender].has(childId)) continue;

      servedNow[gender].add(childId);
      if (servedNow[gender].size >= ids[gender].size && ids[gender].size > 0) {
        servedNow[gender].clear();
      }
    }
  }

  const describe = (gender) => {
    const list = roster[gender].map(c => ({
      ...c,
      served_this_round: servedNow[gender].has(String(c.id)),
      last_at: lastAt.get(String(c.id)) || null,
      times: timesAll.get(String(c.id)) || 0,
    }));

    // Longest since their last turn goes first, and a child who has never gone
    // goes before anybody who has. Ties settle by name so the order is the
    // same on two screens looking at the same room.
    const waiting = list
      .filter(c => !c.served_this_round)
      .sort((a, b) => {
        if (!a.last_at && b.last_at) return -1;
        if (a.last_at && !b.last_at) return 1;
        if (a.last_at && b.last_at && a.last_at !== b.last_at) {
          return new Date(a.last_at) - new Date(b.last_at);
        }
        return String(a.name).localeCompare(String(b.name), 'he');
      });

    return {
      children: list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'he')),
      waiting,
      round: { done: servedNow[gender].size, total: roster[gender].length },
    };
  };

  return {
    boys: describe('boy'),
    girls: describe('girl'),
    unknown_gender: children.filter(c => c.gender !== 'boy' && c.gender !== 'girl'),
  };
}

/**
 * Who to put on each of these weeks.
 *
 * Assigns forward through the weeks rather than choosing each one
 * independently, so a month never proposes the same child twice — and so a
 * round that runs out mid-month rolls into the next one instead of stopping.
 *
 * @param {Array} weeks  the weeks to fill, in order, [{ index, has_father, has_mother }]
 * @param {boolean} overwrite  fill weeks that already have a name
 */
function planMonth(state, weeks, { overwrite = false } = {}) {
  const queues = {
    boy: [...state.boys.waiting],
    girl: [...state.girls.waiting],
  };
  // When the waiting list empties, the round is over and everybody is eligible
  // again — the same rule the walk above applies, continued forwards.
  const refill = {
    boy: () => state.boys.children.slice(),
    girl: () => state.girls.children.slice(),
  };

  const take = (gender) => {
    if (!queues[gender].length) queues[gender] = refill[gender]();
    return queues[gender].shift() || null;
  };

  return (weeks || []).map((w) => {
    const father = (overwrite || !w.has_father) ? take('boy') : null;
    const mother = (overwrite || !w.has_mother) ? take('girl') : null;
    return {
      index: w.index,
      father: father ? { id: father.id, name: father.name } : null,
      mother: mother ? { id: mother.id, name: mother.name } : null,
    };
  });
}

module.exports = { rotation, planMonth, GENDERS };
