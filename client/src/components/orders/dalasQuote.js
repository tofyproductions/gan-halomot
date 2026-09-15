/**
 * Reading a DALAS price quote.
 *
 * A quote is a PDF with no table in it. What it actually contains is a few
 * hundred pieces of text, each with a position, and some pictures, each with a
 * position — and a table is what a person sees when those land in tidy columns.
 * So this file rebuilds the table: it groups the pieces into rows by where they
 * sit vertically, and decides which column each piece belongs to by where it
 * sits horizontally.
 *
 * KEPT FREE OF pdfjs, canvas, React AND MUI on purpose, the way config/nav.js
 * is kept free of MUI: everything below is a pure function over plain objects,
 * so the question "does this quote still read as 49 products totalling
 * 2,630.12" can be asked by a test in Node against a fixture, without a
 * browser and without a PDF. The pdfjs and canvas half lives in the component.
 *
 * WHAT THE FORMAT ACTUALLY IS, learned from quote 308710:
 *   - Eight pages, 49 line items, each item one row.
 *   - Columns at fixed x on every page: line number, item code, description,
 *     quantity, unit, price, total.
 *   - A description can wrap over three lines, and the wrapped lines carry no
 *     other cells.
 *   - A row may or may not have a picture. Eight of the 49 have none.
 *   - The page footer sits in the same columns as the last row of the table.
 */

/**
 * Column centres in PDF points, measured on the header row
 * (קוד פריט / תיאור / כמות / יח' מידה / מחיר / סה"כ) and identical on all eight
 * pages. A cell goes to whichever centre it is nearest.
 *
 * `lineno` earns its place by being useless: nothing reads it, but without a
 * column of its own the line number 001 is nearest to the item-code column, and
 * every code arrives as "001 60246" — which matches no product, so the import
 * silently comes out empty.
 */
const COLUMNS = [
  ['lineno', 565],
  ['sku', 531],
  ['name', 483],
  ['qty', 386],
  ['unit', 345],
  ['price', 311],
  ['total', 172],
];

/**
 * A picture belongs to a product if it sits in the leftmost column, at x≈59.
 * The DALAS logo is the only other picture on a page and sits at x≈88, inside
 * the header — told apart by where it is rather than by how big it is, because
 * 45 points against 51 is not a difference worth trusting.
 */
const PRODUCT_IMAGE_MAX_X = 75;

/**
 * A backstop on how tall a row may be. Rows are pitched about 76 points apart,
 * so a cap below that cannot reach into the next one.
 */
const MAX_ROW_HEIGHT = 70;

/**
 * Where the table stops.
 *
 * The last row on a page has no next row to end it, and what follows it is not
 * blank: every page carries a footer in the very same columns, and the final
 * page carries the totals block, the payment terms and the delivery type. Left
 * unbounded, row 049 came out described as
 * "מגבת רב סופר תעשייתי 3 ק\"ג *יחידה* סוג משלוח:" — a real product with a
 * piece of the footer glued to its name, which is the sort of thing that gets
 * ordered before anybody reads it.
 *
 * Bounded by these labels rather than by a tighter height cap, because a height
 * that clears the footer on one quote clips a three-line description on the
 * next.
 */
const FOOTER_MARKERS = [
  /סה[״"]כ\s*לפני/, /הוצאות\s*נוספות/, /תנאי\s*תשלום/, /סוג\s*משלוח/,
  /מספר\s*עוסק\s*מורשה/, /אתר\s*האינטרנט/, /לרישום\s*בעמוד/, /לרישום\s*מעמוד/,
];

const SKU = /^\d{3,6}$/;
const LINE_NO = /^0\d{2}$/;
const NUMERIC = /^[\d.,]+$/;

/** Squash runs of whitespace; PDF text arrives with a lot of incidental space. */
export function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function columnOf(x, width) {
  const centre = x + width / 2;
  let best = null;
  let dist = Infinity;
  for (const [key, cx] of COLUMNS) {
    const d = Math.abs(centre - cx);
    if (d < dist) { best = key; dist = d; }
  }
  return best;
}

/**
 * One page's worth of text and pictures, into rows.
 *
 * `items` are {x, y, width, text} with y measured DOWN from the top of the
 * page — the same direction a reader goes, and the opposite of the direction
 * PDF coordinates go, so the caller converts.
 *
 * `images` are {x, y, height, width, ref}; `ref` is opaque here and is whatever
 * the caller needs to get the bytes later.
 */
export function parsePage(items, images = []) {
  const texts = items
    .map((i) => ({ ...i, text: clean(i.text) }))
    .filter((i) => i.text);

  /**
   * A row begins at its LINE NUMBER, not at its item code.
   *
   * The code was the obvious anchor and it is the wrong one: codes run from
   * three to six digits, so the cell's width — and therefore its centre —
   * drifts with the number, and nine of the forty-nine rows fell outside any
   * tolerance still narrow enough to be a column. Nothing failed; the import
   * was simply nine products short, which is the kind of wrong nobody notices
   * until they are standing in a storeroom. The line number is three digits on
   * every row, in the same place on every page, exactly one per row.
   */
  const starts = texts
    .filter((t) => LINE_NO.test(t.text) && columnOf(t.x, t.width) === 'lineno')
    .map((t) => t.y)
    .sort((a, b) => a - b);

  const productImages = images.filter((im) => im.x <= PRODUCT_IMAGE_MAX_X);

  // The first footer label below the last row start — the floor for that row.
  const lastStart = starts.length ? starts[starts.length - 1] : 0;
  const footerY = texts
    .filter((t) => t.y > lastStart + 4 && FOOTER_MARKERS.some((re) => re.test(t.text)))
    .reduce((min, t) => Math.min(min, t.y), Infinity);

  return starts.map((top, i) => {
    const from = top - 4;
    // The last row on a page has no next row to stop it, and without a cap it
    // swallows the footer — "מספר עוסק מורשה", the running total, and on the
    // final page the whole payment-terms block — arriving with an item code
    // forty words long.
    const to = i + 1 < starts.length
      ? starts[i + 1] - 4
      : Math.min(top + MAX_ROW_HEIGHT, footerY - 2);

    const cells = {};
    for (const t of texts) {
      if (t.y < from || t.y >= to) continue;
      const col = columnOf(t.x, t.width);
      (cells[col] || (cells[col] = [])).push(t);
    }

    /**
     * Join a column's pieces. `rtl` is for the description and only for it: a
     * line of Hebrew is often several pieces laid out right to left, and
     * joining them by ascending x reads the line backwards.
     */
    const take = (col, rtl = false) => (cells[col] || [])
      .slice()
      .sort((a, b) => (a.y - b.y) || (rtl ? b.x - a.x : a.x - b.x))
      .map((t) => t.text)
      .join(' ')
      .trim();

    /**
     * The FIRST bare number in a column, not everything in it. A description
     * ending in "1/50 יח'" put its last fragment near enough to the code
     * column's centre to be filed under it, and that row was dropped.
     */
    const firstMatching = (col, re) => {
      const hit = (cells[col] || [])
        .slice()
        .sort((a, b) => (a.y - b.y) || (a.x - b.x))
        .find((t) => re.test(t.text));
      return hit ? hit.text : '';
    };

    const sku = firstMatching('sku', SKU);
    const price = firstMatching('price', NUMERIC);
    const image = productImages.find((im) => im.y >= from && im.y < to) || null;

    return {
      line: take('lineno'),
      sku,
      name: take('name', true),
      unit: take('unit'),
      price,
      total: firstMatching('total', NUMERIC),
      image,
    };
  }).filter((r) => SKU.test(r.sku) && NUMERIC.test(r.price));
}

/** Every page's rows, in order. */
export function parseQuote(pages) {
  return pages.flatMap((p) => parsePage(p.items || [], p.images || []));
}

/** "1,234.56" -> 1234.56, and anything unreadable -> 0. */
export function toNumber(s) {
  const n = Number(String(s == null ? '' : s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Rows into the shape POST /api/products/import wants.
 *
 * `imageOf` turns a row's opaque image ref into a data URI, or into null. It is
 * a callback because encoding a picture is the browser's job (a canvas) and
 * this file does not get to know that.
 */
export async function toProducts(rows, imageOf) {
  const out = [];
  for (const r of rows) {
    out.push({
      sku: r.sku,
      name: r.name,
      unit: r.unit,
      price_before_vat: toNumber(r.price),
      image_data: r.image && imageOf ? (await imageOf(r.image)) || '' : '',
    });
  }
  return out;
}

/**
 * What the quote says it adds up to.
 *
 * The one number in the document that is not derived from the rows, and
 * therefore the only independent check on whether we read them correctly: if
 * our 49 line totals sum to this, we did not silently skip a product or
 * misread a price. It is shown to the person approving the import for exactly
 * that reason.
 *
 * Found by its label and then by POSITION — the label and the amount are two
 * separate pieces of text on the same line, and the amount carries a shekel
 * sign, so neither "the next piece in the list" nor a bare-number match finds
 * it. Same line means same y, within a point or two.
 */
export function statedSubtotal(pages) {
  const LABEL = /סה[״"]כ\s*לפני\s*:/;
  for (const page of pages.slice().reverse()) {
    const texts = (page.items || []).map((i) => ({ ...i, text: clean(i.text) }));
    const label = texts.find((t) => LABEL.test(t.text));
    if (!label) continue;
    const sameLine = texts
      .filter((t) => t !== label && Math.abs(t.y - label.y) <= 3)
      .map((t) => t.text.match(/([\d,]+\.\d{2})/))
      .filter(Boolean);
    if (sameLine.length) return toNumber(sameLine[0][1]);
  }
  return null;
}
