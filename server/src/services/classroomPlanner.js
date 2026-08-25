/**
 * Opening a year's classrooms — for a whole network, in one press.
 *
 * WHY THIS EXISTS. A child absorbed with no classroom is absorbed into
 * nothing: they do not appear on the rooms screen, in attendance, in
 * collections, or on the supplies list. The placement screen says so and
 * refuses to place. So until the rooms for a year exist, the whole intake is
 * stuck — and creating them one at a time, across four branches and three age
 * groups, is twenty presses of a dialog nobody wants to open twenty times.
 *
 * TWO WAYS, because there are two situations.
 *
 *   copy — last year's rooms, into this year. What a gan almost always wants:
 *          the names are the ones the staff already say out loud, and the
 *          capacities were argued about once already.
 *   create — N rooms per age group, named תינוקייה א, תינוקייה ב… For a branch
 *          with no usable previous year.
 *
 * COPYING SKIPS THE JUNK. Some rooms in the database carry names mangled by an
 * old encoding bug — "תינ" and worse. They are already excluded from the
 * screens by hand; copying them forward would reintroduce them into a clean
 * year, so the copy leaves them behind and says how many it left.
 *
 * NOTHING IS OVERWRITTEN. A name that already exists in the target year is
 * skipped, not replaced. Running this twice must be safe, because the way
 * somebody finds out it did the wrong thing is by running it again.
 */

const CATEGORIES = ['תינוקייה', 'צעירים', 'בוגרים'];

// א ב ג …, which is how the gan already names rooms ("תינוקייה א").
const LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];

/** A name mangled by the old encoding bug — never copied into a new year. */
const isGarbledName = (name) => /[�?]{2,}/.test(String(name || ''));

/**
 * The name for the n-th room of a category, skipping names already taken.
 *
 * Takes the first free letter rather than counting: a branch that already has
 * "תינוקייה א" and "תינוקייה ג" should get "תינוקייה ב", not a second "ג".
 */
function nextFreeName(category, taken) {
  for (const letter of LETTERS) {
    const name = `${category} ${letter}`;
    if (!taken.has(name)) return name;
  }
  return null;
}

/**
 * What a `create` request would produce for one branch.
 *
 * `existing` is the names already in the target year for that branch. Returns
 * the rooms to create and, separately, what it declined to do and why —
 * a report that says only "created 6" cannot be checked by the person who
 * pressed the button.
 */
function planCreate(existing, plan) {
  const taken = new Set(existing);
  const create = [];
  const skipped = [];

  for (const row of plan || []) {
    const category = String(row?.category || '').trim();
    if (!CATEGORIES.includes(category)) {
      skipped.push({ reason: 'קבוצת גיל לא תקינה', category });
      continue;
    }
    // `count` is how many rooms of this kind should EXIST, not how many to
    // add. A manager filling this in is describing the gan — "we run two
    // infant rooms" — not issuing a delta, and the target reading is the one
    // that makes a second run a no-op instead of doubling the year.
    const target = Math.max(Number(row?.count) || 0, 0);
    const already = [...taken].filter((n) => n.startsWith(`${category} `)).length;
    const count = Math.max(target - already, 0);
    const capacity = Number(row?.capacity) > 0 ? Number(row.capacity) : null;

    if (count === 0 && target > 0) {
      skipped.push({ reason: `כבר קיימות ${already} — לא נוצרו נוספות`, category });
      continue;
    }

    // NOT clamped silently. Asking for more rooms than there are letters is a
    // typo, and a run that quietly makes ten of the ninety-nine and reports
    // "created 10" reads as success. The loop runs, runs out, and says so.
    let made = 0;
    for (let i = 0; i < count; i += 1) {
      const name = nextFreeName(category, taken);
      if (!name) {
        skipped.push({
          reason: `אין יותר אותיות פנויות — נוצרו ${made} מתוך ${count}`,
          category,
        });
        break;
      }
      taken.add(name);
      create.push({ name, category, capacity });
      made += 1;
    }
  }
  return { create, skipped };
}

/**
 * What a `copy` request would produce for one branch.
 *
 * `source` is last year's rooms; `existing` the names already in the target
 * year. A room whose name is already there is left alone — the point is to
 * fill a gap, not to reset a year somebody has started arranging.
 */
function planCopy(source, existing) {
  const taken = new Set(existing);
  const create = [];
  const skipped = [];

  for (const room of source || []) {
    const name = String(room?.name || '').trim();
    if (!name) continue;
    if (isGarbledName(name)) {
      skipped.push({ reason: 'שם פגום — לא הועתק', name });
      continue;
    }
    if (taken.has(name)) {
      skipped.push({ reason: 'כבר קיימת', name });
      continue;
    }
    taken.add(name);
    create.push({
      name,
      category: CATEGORIES.includes(room.category) ? room.category : null,
      capacity: Number(room.capacity) > 0 ? Number(room.capacity) : null,
    });
  }
  return { create, skipped };
}

module.exports = { CATEGORIES, LETTERS, isGarbledName, nextFreeName, planCreate, planCopy };
