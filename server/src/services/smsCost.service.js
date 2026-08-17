/**
 * What a text message actually costs to send, in messages.
 *
 * A carrier charges by SEGMENT, not by send, and Hebrew is the expensive case:
 * it falls outside GSM-7, so the message is encoded UCS-2 at 70 characters per
 * segment — 67 once a message is long enough to need more than one, because
 * each part carries a header saying how to reassemble it.
 *
 * This is the arithmetic that turns a 200-character announcement into three
 * messages per family and quietly spends a month's allowance on one send. It
 * belongs in front of the manager BEFORE she presses send, which is what
 * `describe` is for.
 */

// UCS-2: what any message containing Hebrew is encoded as.
const SINGLE = 70;
const CONCATENATED = 67;

// The provider's own ceiling on one send. Past this a message is refused
// rather than truncated, and a refusal after the budget was checked is the
// worst order to discover it in.
const MAX_SEGMENTS = 6;

/**
 * How many segments this text takes.
 *
 * Length in code UNITS, not characters: an emoji outside the basic plane is
 * two UTF-16 units and the carrier counts it as two. `[...str].length` would
 * count it as one and undercharge by a segment on exactly the messages people
 * put emoji in.
 */
function segments(text) {
  const len = String(text || '').length;
  if (len === 0) return 0;
  if (len <= SINGLE) return 1;
  return Math.ceil(len / CONCATENATED);
}

/**
 * The whole picture for a send: length, segments, and the real number of
 * messages it will cost across the audience.
 */
function describe(text, recipients) {
  const chars = String(text || '').length;
  const parts = segments(text);
  return {
    chars,
    segments: parts,
    recipients,
    messages: parts * recipients,
    over_limit: parts > MAX_SEGMENTS,
    // What it would cost to say the same thing in one segment — the number a
    // manager needs to decide whether to shorten it.
    single_segment_chars: SINGLE,
    chars_over_single: Math.max(0, chars - SINGLE),
  };
}

/**
 * The text an urgent announcement is sent as.
 *
 * The TITLE, not the body. The portal is where an announcement lives in full;
 * this is the tap on the shoulder that gets somebody to look at it, and every
 * extra line costs one message per family. "הגן סגור מחר" is the whole of what
 * an urgent message has to carry.
 */
function urgentText(title) {
  return `גן החלומות: ${String(title || '').trim()}`;
}

module.exports = { segments, describe, urgentText, SINGLE, CONCATENATED, MAX_SEGMENTS };
