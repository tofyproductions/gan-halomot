/**
 * The name a ZKTeco clock can actually hold.
 *
 * The device stores a name in a fixed 24-BYTE field, written straight out of
 * the record struct (`'<BHB8s24sIB7sx24s'` in the agent's clock library). A
 * Hebrew name is two bytes per letter in UTF-8, so twelve letters fill it and
 * the thirteenth is cut in the middle of a character — and the device does not
 * store UTF-8 in the first place. What comes back is what the export from
 * הרצליה returned for אדולה מהרט:
 *
 *   "name": "WWWWW WWW(W"
 *
 * Bytes reinterpreted as something else. Nobody standing at the clock can read
 * that, and nobody scrolling the device's user list can find anyone.
 *
 * So the clock gets a Latin name: 24 ASCII characters, one byte each, no
 * encoding to disagree about. It exists ONLY for the device — the application
 * shows the Hebrew name everywhere, and this is never displayed.
 *
 * Hebrew is written without vowels, so no transliteration can be exactly right.
 * The goal is not scholarly accuracy: it is that a human at the device can find
 * the person. Consistency beats cleverness — the same Hebrew name always
 * produces the same Latin one — and `Employee.clock_name` is a stored field, so
 * a name this gets wrong is corrected once by writing the right one there.
 */

// One entry per letter. Where a letter has two readings, the more common one in
// Israeli given names and surnames wins.
const LETTERS = {
  'א': 'a',
  'ב': 'b',    // b, not v — בר, בן, אבי are far more common than the v reading
  'ג': 'g',
  'ד': 'd',
  'ה': 'h',
  'ו': 'o',    // positional: 'v' at the start of a word, 'v' when doubled
  'ז': 'z',
  'ח': 'ch',
  'ט': 't',
  'י': 'i',    // positional: 'y' at the start of a word
  'כ': 'k',
  'ך': 'ch',   // final kaf is the ch sound — ברוך = baruch
  'ל': 'l',
  'מ': 'm',
  'ם': 'm',
  'נ': 'n',
  'ן': 'n',
  'ס': 's',
  'ע': 'a',    // a vowel carrier in practice; dropping it loses the syllable
  'פ': 'p',
  'ף': 'f',    // final pe is the f sound — יוסף = yosef
  'צ': 'tz',
  'ץ': 'tz',
  'ק': 'k',
  'ר': 'r',
  'ש': 'sh',
  'ת': 't',
  // Punctuation that appears inside names.
  '\'': '',
  '"': '',
  '״': '',
  '׳': '',
  '-': '-',
  ' ': ' ',
};

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

// Letters that produce two characters for ONE sound. They must be treated as a
// unit — splitting them is how רחל became "Rcahl" and לילך became "Lilcah".
const DIGRAPHS = ['ch', 'sh', 'tz'];

/**
 * Names common enough that a guessed spelling would be the wrong one.
 *
 * The letter rules cannot know that כהן is Cohen — they produce "Khan", which
 * is not merely inelegant: a device list scanned by surname is the entire
 * reason for doing this, and Cohen is the surname it will be scanned for most.
 * Everything here is a name that appears in this gan's roster or is common
 * enough in Israel to be worth spelling the way people actually write it.
 */
const KNOWN = {
  // Surnames
  'כהן': 'Cohen', 'לוי': 'Levi', 'מזרחי': 'Mizrahi', 'ביטון': 'Biton',
  'פרץ': 'Peretz', 'דהן': 'Dahan', 'אזולאי': 'Azoulay', 'אוחיון': 'Ohayon',
  'גבריאל': 'Gabriel', 'אהרון': 'Aharon', 'אהרן': 'Aharon', 'אברהם': 'Avraham',
  'ישראל': 'Israel', 'שבת': 'Shabat', 'סרוסי': 'Srousi', 'בראון': 'Braun',
  // Given names
  'משה': 'Moshe', 'יוסף': 'Yosef', 'דוד': 'David', 'יעקב': 'Yaakov',
  'שרה': 'Sara', 'רחל': 'Rachel', 'אסתר': 'Esther', 'מרים': 'Miriam',
  'חנה': 'Hana', 'לאה': 'Leah', 'רבקה': 'Rivka', 'מלכה': 'Malka',
  'נועה': 'Noa', 'נועם': 'Noam', 'נעם': 'Noam', 'שירה': 'Shira',
  'תמר': 'Tamar', 'הילה': 'Hila', 'הילי': 'Hili', 'אורה': 'Ora',
  'אורלי': 'Orli', 'אונלי': 'Onli', 'אילנה': 'Ilana', 'אילנית': 'Ilanit',
  'לימור': 'Limor', 'לילך': 'Lilach', 'ליאור': 'Lior', 'לירון': 'Liron',
  'לינוי': 'Linoy', 'לידור': 'Lidor', 'ליאל': 'Liel', 'ליאן': 'Lian',
  'ליז': 'Liz', 'עדי': 'Adi', 'עדן': 'Eden', 'עדנה': 'Edna', 'ענת': 'Anat',
  'קרן': 'Keren', 'רותם': 'Rotem', 'נטע': 'Neta', 'שרון': 'Sharon',
  'תאיר': 'Tair', 'אלעד': 'Elad', 'יובל': 'Yuval', 'מאי': 'Mai',
  'עינת': 'Einat', 'ציפורה': 'Tzipora', 'רוזה': 'Roza', 'גולן': 'Golan',
  'טניה': 'Tanya', 'אלה': 'Ella', 'אתי': 'Eti', 'אפרת': 'Efrat',
  'ארנון': 'Arnon', 'גאולה': 'Geula', 'יהודית': 'Yehudit', 'מוריה': 'Moria',
  'עופרי': 'Ofri', 'שילה': 'Shila', 'שילו': 'Shilo', 'תמי': 'Tami',
  'אביב': 'Aviv', 'הדר': 'Hadar', 'שי': 'Shai', 'בן': 'Ben', 'בר': 'Bar',
  'אמונה': 'Emuna', 'אושרת': 'Osherat', 'סאלי': 'Sally', 'איה': 'Aya',
  'קטי': 'Katy', 'בטי': 'Betty', 'רינת': 'Rinat', 'מורן': 'Moran',
  'גלית': 'Galit', 'אלכסנדרה': 'Alexandra', 'טטיאנה': 'Tatiana',
  'ויקה': 'Vika', 'סימה': 'Sima', 'הנרי': 'Henri', 'לוריאן': 'Lorian',
};

/** One Hebrew word -> Latin, applying the positional rules. */
function transliterateWord(word) {
  const chars = [...word];
  let out = '';

  chars.forEach((ch, i) => {
    const first = i === 0;
    const last = i === chars.length - 1;

    if (ch === 'ו') {
      // A word-initial vav is the consonant; a doubled vav always is.
      if (first || chars[i - 1] === 'ו' || chars[i + 1] === 'ו') {
        // Emit a single v for the pair rather than "vv".
        if (chars[i - 1] === 'ו') return;
        out += 'v';
      } else {
        out += 'o';
      }
      return;
    }

    if (ch === 'י') {
      if (first) out += 'y';
      // A doubled yod is the "ay" sound — חיים = chaim keeps one i.
      else if (chars[i - 1] === 'י') return;
      else out += 'i';
      return;
    }

    // A final he is the 'a' ending, not an h — מלכה = malka, not malkah.
    if (ch === 'ה' && last && !first) { out += 'a'; return; }

    // A word-initial alef before a vav or a yod is silent — those letters carry
    // the vowel themselves. אורלי is Orli, not Aorli; אילנה is Ilana.
    if (ch === 'א' && first && (chars[1] === 'ו' || chars[1] === 'י')) return;

    // An initial alef carries the vowel; in the middle it usually is one.
    if (ch === 'א' && last && chars.length > 2) { out += 'a'; return; }

    out += LETTERS[ch] ?? (/[a-zA-Z0-9]/.test(ch) ? ch.toLowerCase() : '');
  });

  return out;
}

/**
 * Break up consonant runs.
 *
 * Hebrew drops its vowels, so a direct letter map yields things like "mhrt"
 * that nobody can read or say. Three consonants in a row get an 'a' after the
 * first — the most common Hebrew vowel — which turns "mhrt" into "mahrt" and
 * "shlmi" into "shalmi". Not always the right vowel; always pronounceable.
 */
function openConsonantRuns(s) {
  let out = '';
  let run = 0;
  let i = 0;
  while (i < s.length) {
    // A digraph is one sound, so it counts once and is never broken in half.
    const digraph = DIGRAPHS.find(d => s.startsWith(d, i));
    const unit = digraph || s[i];
    i += unit.length;

    if (!digraph && VOWELS.has(unit)) { run = 0; out += unit; continue; }
    if (unit === ' ' || unit === '-') { run = 0; out += unit; continue; }
    run += 1;
    if (run === 3) { out += `a${unit}`; run = 1; } else { out += unit; }
  }
  return out;
}

/** Title case, so a device list reads as names rather than as a dump. */
function titleCase(s) {
  return s.replace(/(^|[\s-])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
}

/**
 * The Latin name to write on a clock, capped to the device's 24-byte field.
 *
 * When the cap bites, the FIRST name is shortened rather than the last: a
 * device list is scanned by surname, and "Y Shwartzberg" identifies a person
 * where "Yonatan Shwartzb" does not.
 */
function toClockName(fullName, { max = 24 } = {}) {
  const source = String(fullName || '').trim();
  if (!source) return '';

  // A name already written in Latin is left alone — it is already what the
  // device wants, and re-deriving it would only make it worse.
  if (!/[֐-׿]/.test(source)) {
    return titleCase(source).slice(0, max).trim();
  }

  const words = source.split(/\s+/).filter(Boolean);
  const parts = words
    .map((w) => {
      const bare = w.replace(/[()״׳'"]/g, '');
      // A name we know how to spell is spelled that way, not derived.
      return KNOWN[bare] || openConsonantRuns(transliterateWord(w));
    })
    .map(w => w.replace(/([aeiou])\1+/g, '$1'))   // "aa" -> "a"
    .filter(Boolean);

  let name = titleCase(parts.join(' '));
  if (name.length <= max) return name;

  // Too long: initialise the leading names, keep the last one whole.
  while (parts.length > 1) {
    const idx = parts.findIndex(p => p.length > 1);
    if (idx === -1 || idx === parts.length - 1) break;
    parts[idx] = parts[idx][0];
    name = titleCase(parts.join(' '));
    if (name.length <= max) return name;
  }
  return name.slice(0, max).trim();
}

module.exports = { toClockName, transliterateWord };
