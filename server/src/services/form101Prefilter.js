/**
 * Rejecting a file without asking Claude.
 *
 * The notebook (models/ScannedAttachment.js) stops us paying twice for the same
 * file. This stops us paying the FIRST time, for the files that never had a
 * chance: a mailbox carries payslips, invoices, supplier PDFs and email
 * footers, and every one of them costs a full vision call to be told it is not
 * a form 101.
 *
 * Most of those are PDFs produced by software, so they carry a real text layer.
 * A טופס 101 has the digits 101 printed on it — it is the name of the form, in
 * the header, and in the filename more often than not. So a PDF with a
 * substantial text layer that contains no "101" anywhere is not a form 101, and
 * that can be established locally, in milliseconds, for nothing.
 *
 * The test is deliberately ONE signal, and a digit one. pdf-parse returns the
 * Hebrew in these files garbled or reversed depending on the embedded font
 * (services/tmtPdf.js documents the same problem), so any rule that depends on
 * matching Hebrew words would drop real forms. Digits survive.
 *
 * Everything else — images, scans, PDFs with no text layer, PDFs that do
 * contain 101 — goes to the AI exactly as before. This only ever says "no",
 * never "yes": a file it clears has not been approved, only left alone.
 */

/** Below this, the "text layer" is page furniture, not content — treat as a scan. */
const MIN_TEXT_CHARS = 200;

let _PDFParse = null;
async function loadPDFParse() {
  if (_PDFParse) return _PDFParse;
  const mod = await import('pdf-parse');
  _PDFParse = mod.PDFParse || mod.default;
  if (!_PDFParse) throw new Error('pdf-parse: missing PDFParse export');
  return _PDFParse;
}

/**
 * @returns {Promise<{decided: boolean, isForm101: boolean, reason: string}>}
 *   decided=false means "no opinion — send it to the AI".
 */
async function prefilter(buffer, mimetype = '', filename = '') {
  const isPdf = /pdf/i.test(mimetype) || /\.pdf$/i.test(filename);
  if (!isPdf) return { decided: false, isForm101: false, reason: 'לא PDF' };

  let text = '';
  try {
    const PDFParse = await loadPDFParse();
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    text = String(result?.text || '');
    // pdf-parse holds the document open; releasing matters in a loop over a
    // whole mailbox.
    if (typeof parser.destroy === 'function') await parser.destroy();
  } catch {
    // A PDF this cannot read is exactly the kind the AI still might. No opinion.
    return { decided: false, isForm101: false, reason: 'לא ניתן לקרוא טקסט' };
  }

  const stripped = text.replace(/\s+/g, '');
  if (stripped.length < MIN_TEXT_CHARS) {
    // A scan or a photo saved as PDF — there is nothing to read locally.
    return { decided: false, isForm101: false, reason: 'סרוק — אין שכבת טקסט' };
  }

  // The one test. `101` anywhere in the text, or in the file name.
  if (/101/.test(text) || /101/.test(filename)) {
    return { decided: false, isForm101: true, reason: 'נמצא 101 — נשלח לבדיקה' };
  }

  return {
    decided: true,
    isForm101: false,
    reason: `מסמך טקסט בן ${stripped.length} תווים שאין בו "101" — נדחה מקומית`,
  };
}

module.exports = { prefilter, MIN_TEXT_CHARS };
