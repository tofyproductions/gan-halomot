/**
 * גיל של מבוגר/ת, בשנים שלמות.
 *
 * WHY NOT THE ONE IN ChildDayCard. The nursery already has an `age()`, and it
 * answers a different question: a two-year-old is "2.4" and a newborn is
 * "8 חודשים", because in a gan the months are the whole point. A member of
 * staff is "34". Reusing that helper would print a גננת as "34.7".
 *
 * Returns `null` — never `0`, never `NaN` — for anything that is not a usable
 * date, so a caller can decide what "no age" looks like (the employees table
 * shows `—`). `0` is a real answer, for somebody born today, and is kept
 * distinct from "we don't know" on purpose.
 *
 * A date outside a human lifetime is a typed-in mistake, not an age: a year
 * before 1900 or any date in the future reads as "no age" rather than
 * rendering a confident absurdity next to a real person's name.
 */

const EARLIEST_YEAR = 1900;
const MAX_HUMAN_AGE = 120;

export function ageFromBirthDate(value, now = new Date()) {
  if (!value) return null;

  const born = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(born.getTime())) return null;
  if (born.getFullYear() < EARLIEST_YEAR) return null;

  let years = now.getFullYear() - born.getFullYear();
  // Not yet had this year's birthday: same month but an earlier day, or an
  // earlier month altogether. This is what keeps somebody born in December
  // from ageing a year every January.
  const monthDelta = now.getMonth() - born.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < born.getDate())) years -= 1;

  if (years < 0 || years > MAX_HUMAN_AGE) return null;
  return years;
}

export default ageFromBirthDate;
