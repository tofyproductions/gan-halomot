/**
 * Walk every payslip PDF in /Users/amitkohta/Downloads/תלושי שכר אפריל 26 *,
 * extract (israeli_id, start_date) per page, match employees by israeli_id,
 * and update Employee.start_date.
 *
 * The Tamal payroll template prints "תחילת עבודה" as the first dd/mm/yy on
 * each page (right after the column-header row). The 9-digit ID always
 * appears near the top of the page as well (it's the only 9-digit number
 * other than the company tax id 924687999).
 *
 * Idempotent: prints what would change; pass --apply to actually write.
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { Employee } = require('../src/models');

const COMPANY_TAX_ID = '924687999';
const PDFS = [
  '/Users/amitkohta/Downloads/תלושי שכר אפריל 26 סניף משה דיין.pdf',
  '/Users/amitkohta/Downloads/תלושי שכר אפריל 26 סניף שאול המלך כפר סבא.pdf',
  '/Users/amitkohta/Downloads/תלושי שכר אפריל 26 סניף הרצוג הרצליה.pdf',
  '/Users/amitkohta/Downloads/תלושי שכר אפריל 26 סניף תל אביב.pdf',
];

function parseDmy(dmy) {
  // dd/mm/yy → Date (assume 20yy because all employees started in 2000s)
  const m = dmy.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const yr = Number(m[3]);
  if (day > 31 || month > 12) return null;
  const year = yr <= 50 ? 2000 + yr : 1900 + yr;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/** Split text into per-page sections. Tamal puts "תלוש משכורת לחודש" at the
 *  top of every payslip — use it as the page start delimiter. */
function splitPages(text) {
  const marker = 'תלוש משכורת לחודש';
  const positions = [];
  let i = 0;
  while ((i = text.indexOf(marker, i)) !== -1) { positions.push(i); i += 1; }
  if (positions.length === 0) return [text];
  const out = [];
  for (let k = 0; k < positions.length; k++) {
    const end = positions[k + 1] != null ? positions[k + 1] : text.length;
    out.push(text.slice(positions[k], end));
  }
  return out;
}

function extractPage(pageText) {
  // Employee ID — first 9-digit number that isn't the company tax id
  const ids = pageText.match(/\b\d{9}\b/g) || [];
  const empId = ids.find(id => id !== COMPANY_TAX_ID) || null;
  // Start date — first dd/mm/yy on the page
  const dmy = pageText.match(/\b(\d{2}\/\d{2}\/\d{2})\b/);
  const startDate = dmy ? parseDmy(dmy[1]) : null;
  // Employee name — Tamal pattern: "ש ח י <name> <small numbers>\t<id>"
  const nameMatch = pageText.match(/ש\s*ח\s*י\s+([^\n\t\d]{1,40}?)\s+\d/);
  const name = nameMatch ? nameMatch[1].replace(/\s+/g, ' ').trim() : null;
  return { empId, startDate, name };
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`Mode: ${apply ? 'APPLY (will update DB)' : 'DRY-RUN'}`);

  const mod = await import('pdf-parse');
  const PDFParse = mod.PDFParse || mod.default;

  const extracted = new Map(); // israeli_id → { name, startDate }
  for (const path of PDFS) {
    if (!fs.existsSync(path)) {
      console.log(`MISSING: ${path}`);
      continue;
    }
    const parser = new PDFParse({ data: fs.readFileSync(path) });
    const text = (await parser.getText()).text;
    const pages = splitPages(text);
    let pageHits = 0;
    for (const p of pages) {
      const { empId, startDate, name } = extractPage(p);
      if (empId && startDate) {
        extracted.set(empId, { name, startDate });
        pageHits++;
      }
    }
    console.log(`  ${path.split('/').pop()}: ${pages.length} pages, ${pageHits} with id+date`);
  }
  console.log(`\nTotal unique IDs extracted: ${extracted.size}`);

  await mongoose.connect(process.env.MONGODB_URI);
  const employees = await Employee.find({ is_active: true }).select('_id full_name israeli_id start_date').lean();
  console.log(`Active employees in DB: ${employees.length}`);

  let updated = 0;
  let skippedUnchanged = 0;
  let noMatch = 0;
  for (const e of employees) {
    if (!e.israeli_id) { noMatch++; continue; }
    const hit = extracted.get(e.israeli_id);
    if (!hit) { noMatch++; continue; }
    const newIso = hit.startDate.toISOString().slice(0, 10);
    const curIso = e.start_date ? new Date(e.start_date).toISOString().slice(0, 10) : null;
    if (curIso === newIso) { skippedUnchanged++; continue; }
    console.log(`  ${e.full_name} (${e.israeli_id}): ${curIso || 'null'} → ${newIso}`);
    if (apply) {
      await Employee.updateOne({ _id: e._id }, { $set: { start_date: hit.startDate } });
    }
    updated++;
  }
  console.log(`\n— summary —`);
  console.log(`updated=${updated} skipped_unchanged=${skippedUnchanged} no_match_in_pdfs=${noMatch}`);
  if (!apply) console.log('\nRe-run with --apply to write the changes.');
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
