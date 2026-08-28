/**
 * What may go into the content bank, and what may never.
 *
 * Shared on purpose. The rule was written once for the extractor, and then the
 * gantt learned to save what a gananet types straight into the bank — which is
 * a second, live door into the same shipped content, and a second chance to put
 * a child's name in front of every other customer. One rule, one file, both
 * doors.
 */

/** Administration, not an idea. Banking these buries the real content. */
const NOT_CONTENT = [
  /^חופש/u, /הגן סגור/u, /^אין /u, /^-+$/u, /^\d+$/u,
  /^יום [א-ו]'?$/u,
];

/**
 * Named children.
 *
 * The שונות row records who is אבא/אמא של שבת and whose birthday it is, by
 * first name and sometimes a surname initial — "בוגרים : ריין+ליה הרפז",
 * "יום הולדת לרפאל". They are four-year-olds, and this bank ships to every
 * customer of the platform. A content bank carrying another gan's children's
 * names is not a content problem, it is a data-protection incident, and it
 * would be found by the person it names.
 *
 * Matched by the SHAPE the gan writes them in — a room or a role, then a
 * separator — rather than by trying to recognise names, which cannot be done
 * reliably and fails towards leaking.
 */
const PERSONAL = [
  /^(תינוקי[יה]?ה|צעירים|בוגרים)\s*[:：+]/u,
  /(אבא|אמא|ילד|ילדת|ילדי)\s+של\s+שבת/u,
  // Every birthday line in every workbook is "יום הולדת ל<שם של ילד>". There is
  // no version of it that is not a named child, so the whole phrase goes.
  /יום הולדת/u,
  /מזל טוב/u,
];

/** True when the text names, or probably names, a child. */
function isPersonal(text) {
  const t = String(text || '').trim();
  return PERSONAL.some(re => re.test(t));
}

/** True when the text is an idea worth keeping. */
function isBankable(text) {
  const t = String(text || '').trim();
  if (t.length < 2 || t.length > 200) return false;
  // Must contain an actual letter. NOT \W — in JavaScript \w is ASCII-only, so
  // \W matches every Hebrew character and a "reject non-word" test silently
  // throws away the entire bank.
  if (!/\p{L}/u.test(t)) return false;
  if (isPersonal(t)) return false;
  return !NOT_CONTENT.some(re => re.test(t));
}

module.exports = { isBankable, isPersonal, NOT_CONTENT, PERSONAL };
