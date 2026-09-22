const storage = require('./storage.service');

/**
 * The bytes behind an EmployeeDocument, from wherever they live.
 *
 * A document used to be base64 inside its own row and every reader could just
 * take `file_data`. Since תיק העובד started accepting phone scans, an upload
 * goes to object storage when a bucket is configured and the row keeps only a
 * key — so a reader that still reaches for `file_data` finds null and reports
 * "no file" about a file that exists. That is the worst possible failure for a
 * טופס 101: the employee portal would tell her she never filed one.
 *
 * Both shapes are read here, in one place, so a future third shape has one
 * place to be taught.
 */
async function readEmployeeDocumentBytes(doc) {
  if (!doc) return null;
  if (doc.storage_key) {
    const signed = await storage.signedReadUrl(doc.storage_key);
    const upstream = await fetch(signed);
    if (!upstream.ok) throw new Error(`שליפת הקובץ מהאחסון נכשלה (${upstream.status})`);
    return Buffer.from(await upstream.arrayBuffer());
  }
  if (doc.file_data) return Buffer.from(doc.file_data, 'base64');
  return null;
}

/** The same, as the base64 string the older JSON endpoints answer with. */
async function readEmployeeDocumentBase64(doc) {
  const buf = await readEmployeeDocumentBytes(doc);
  return buf ? buf.toString('base64') : null;
}

/** Whether this row has a file at all, without fetching it. */
const hasFile = (doc) => Boolean(doc && (doc.file_data || doc.storage_key));

module.exports = { readEmployeeDocumentBytes, readEmployeeDocumentBase64, hasFile };
