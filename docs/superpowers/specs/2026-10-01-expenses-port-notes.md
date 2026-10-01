# Porting notes: tofy expense pairing -> gan-halomot (JS + Mongo)

Source: `~/dev/tofy-friends` at `origin/main` (read-only, fetched 2026-10-01). Paths below are relative to that repo.
Abbreviations: `svc/` = `server/src/services/`, `cl/` = `client/src/pages/manager/expenses/`.
tofy is SQLite + TypeScript; everything here is a pure function of rows, so it ports 1:1 to Mongo documents.
All user-facing strings in tofy are Hebrew; reason strings are quoted verbatim because the UI shows them.

Design principle to preserve (svc/expenseDocuments.service.ts:1-23): **everything displayed is computed on read; only human decisions are stored.**
Stored: charge-to-document links (with amount), rejections, "unpaid" marks, "closed anyway / paid outside bank" decisions, identity decisions, exempt-supplier rules, no-invoice rules.
Never stored: lane, state, proposals, remaining, scores, merged-document view.

---------------------------------------------------------------------------------------------------

## 0. Data model needed (tofy tables -> Mongo collections)

### 0.1 Document = `expense_invoices` (ours) [+ `icount_expenses` (bookkeeper-typed mirror) -- OPTIONAL for gan]
Fields the pairing logic reads (svc/expenseDocuments.service.ts:96-103):
```
id, vendor_name, vendor_key, supplier_tax_id, doc_number, doc_date (YYYY-MM-DD),
amount_total, amount_original, currency (default 'ILS'), fx_confirmed (0/1),
doc_type: 'tax_invoice'|'invoice_receipt'|'receipt'|'credit_note'|'other',
needs_review (0/1: machine reading nobody confirmed),
receipt_disposition: null|'has_invoice'|'no_invoice_issuer'|'not_relevant',
receipt_disposition_at, receipt_disposition_by,
referenced_doc_number (invoice number printed ON a receipt),
linked_invoice_id (receipt -> invoice),
exempt_rule_id (which exempt-supplier rule flipped this receipt),
status: 'captured'|'reconciled'|'filed'|'void',
attachment_path, attachment_sha256, duplicate_of, icount_filed_at, icount_docnum
```
If gan has no iCount-like second source, drop the `ours:`/`icount:` key prefix and the whole merge step (section 9.4) and key documents by `_id`.
Tofy's doc key format is `ours:<id>` | `icount:<id>`, parsed by regex `^(ours|icount):(\d+)$` (svc/expenseDocLinks.service.ts:25-28).

### 0.2 Charge = `bank_transactions` joined to `bank_accounts`
Fields read: `id, date, processed_date, amount (NEGATIVE = money out), description, original_description,
counterparty (payee name, null until the bank agent reads it), transfer_note (free text typed on the transfer; often the invoice number),
bank_ref, provider_category, status ('completed'), is_internal_transfer, match_dismissed, matched_card_account_id`
account: `entity ('business'), type ('bank'|'card'), label`.
`matched_card_account_id` non-null = this is the monthly card settlement line (the itemised card purchases carry the documents, so the settlement is excluded).

### 0.3 Link tables (the only "truth" about payment)
```
expense_payments(expense_id, transaction_id, amount REAL NOT NULL, matched_by, match_confidence DEFAULT 100, UNIQUE(expense_id, transaction_id))
icount_expense_payments(icount_expense_id, transaction_id, amount, matched_by, match_confidence, UNIQUE(...))   -- migration 308:25-40
```
`amount` = how much of THIS charge went to THIS document (one transfer can pay several invoices; one invoice can be paid in parts).
Mongo: either `payments: [{transaction_id, amount, matched_by, at}]` embedded in the document, or a separate `expense_payments` collection with a unique index on `(expense_id, transaction_id)`. A separate collection is easier because pairQueue needs "is this charge linked anywhere" (NOT EXISTS) -- needs an index on `transaction_id`.

### 0.4 Decision tables (migrations 308, 334)
```
expense_doc_decisions(side, ref_id, paid_outside_bank 0/1, closed_anyway 0/1, note, decided_by, decided_at, UNIQUE(side, ref_id))
expense_identity_decisions(expense_id, icount_expense_id, verdict 'same'|'different', UNIQUE pair)
no_invoice_rules(match_text, label, note, is_builtin, created_by)
expense_unpaid_marks(side, ref_id, marked_by, marked_at, UNIQUE(side, ref_id))              -- 334
expense_pair_rejections(side, ref_id, transaction_id, rejected_by, rejected_at, UNIQUE(side, ref_id, transaction_id))  -- 334
receipt_exempt_suppliers(supplier_tax_id NULL, vendor_key NULL, label, created_by; CHECK one of the two non-null) -- 334
```

---------------------------------------------------------------------------------------------------

## 1. Scoring: `scorePair` (svc/expenseMatch.service.ts)

### 1.1 Constants
```
SUGGEST_THRESHOLD = 55                       (expenseMatch.service.ts:120)
WITHHOLDING_EXPECTED = (env EXPENSE_EXPECT_WITHHOLDING === '1')   default OFF  (:117)
```
Max score 100 (`Math.min(100, score)`), integers only (all weights are integers).

### 1.2 Inputs
```
tx  = { amount (negative), date 'YYYY-MM-DD', description (string) }
exp = { vendor_name, amount_total, doc_date }
```
In the pair engine, `exp.amount_total` is passed as **`doc.remaining`** (what is still owed), not the document total (expensePairs.service.ts:91-95),
and `tx.description` is `txText(tx) = [description, original_description, counterparty].filter(Boolean).join(' ')` (expensePairs.service.ts:56).
(`transfer_note` is NOT part of the name text; it is used only for the doc-number bonus.)

### 1.3 Algorithm (exact)
```js
function scorePair(tx, exp) {
  const paid = Math.abs(tx.amount);
  const diff = Math.abs(paid - exp.amount_total);
  const rel  = exp.amount_total > 0 ? diff / exp.amount_total : 1;
  let score = 0; const reasons = [];
  const short = paid < exp.amount_total;

  // AMOUNT (gate: no amount agreement => score 0, return immediately)
  if (diff <= 1)                                                   { score += 55; reasons.push('סכום זהה'); }
  else if (WITHHOLDING_EXPECTED && short && rel >= 0.03 && rel <= 0.35) {
        score += 25; reasons.push(`שולם ${Math.round(rel*100)}% פחות — ייתכן ניכוי מס במקור`); }
  else if (rel <= 0.05)                                            { score += 30; reasons.push(`הפרש ${Math.round(diff)} ₪`); }
  else return { score: 0, reasons: [] };

  // DATE (directional; hard stops)
  const gap = daysBetween(tx.date, exp.doc_date);   // tx.date - doc_date, in whole days, UTC midnight, Math.round
  if (gap < -3 || gap > 90) return { score: 0, reasons: [] };      // charge >3 days BEFORE invoice, or >90 days after
  if      (gap <= 2)  { score += 25; reasons.push('אותו יום'); }   // gap in [-3 .. 2]
  else if (gap <= 45) { score += 20; reasons.push(`שולם ${gap} ימים אחרי`); }
  else                { score += 8;  reasons.push(`שולם ${gap} ימים אחרי`); }   // 46..90

  // NAME (corroboration only)
  const overlap = nameOverlap(exp.vendor_name, tx.description);
  if (overlap >= 0.6) { score += 20; reasons.push('שם הספק מופיע בתנועה'); }
  else if (overlap > 0) { score += 8; reasons.push('שם דומה'); }

  return { score: Math.min(100, score), reasons };
}
```
Notes:
- Amount tolerance: exact = `|diff| <= 1` shekel (absolute). Approximate = `rel <= 5%` of the **owed** amount, symmetric (over- or under-payment) when withholding flag is off.
  With the flag ON the shortfall band 3-35% is checked BEFORE the 5% band, so a 3-5% shortfall scores 25, not 30. Over-payment never gets the withholding band.
  Tofy runs with the flag OFF (business is exempt; a shortfall is a mismatch, expenseMatch.service.ts:106-117).
- `rel` uses the owed amount as denominator; if owed <= 0, rel = 1 => returns 0.
- Date windows: reward band `[-3, 2]` = 25, `(2,45]` = 20, `(45,90]` = 8, outside `[-3,90]` = disqualified. The reason text for the first band is always 'אותו יום' even for -3.
- Score table (no name signal): exact+sameday 80, exact+<=45d 75, exact+46-90d 63, approx+sameday 55 (passes), approx+<=45d 50 (fails alone), approx+far 38.
  Name +20 (>=60% overlap) or +8 (any overlap). Exact amount always clears 55 within 90 days; approx amount needs same-day, or a name hit, or the doc-number bonus.
- Doc-number bonus (expensePairs.service.ts:91-103): applied by the pair engine, not by scorePair:
  `if (s.score > 0 && docNumberInNote(doc.doc_number, tx.transfer_note)) score = min(100, score + 25), reasons.push('מספר החשבונית כתוב בהעברה')`.
  Only on top of an already-agreeing amount (score>0). So it can lift an approx+<=45d (50) to 75.

### 1.4 `docNumberInNote` (expensePairs.service.ts:66-70)
```js
function docNumberInNote(docNumber, note) {
  const want = String(docNumber||'').replace(/\D/g,'');
  if (want.length < 4 || !note) return false;
  return (String(note).match(/\d+/g) || []).some(run =>
      run === want || run.replace(/^0+/,'') === want.replace(/^0+/,''));
}
```
Whole digit runs only, number must be >=4 digits (avoids "1234" inside "912345", and collisions with dates/amounts). Example in comments: note `"חש72971 03.09.26"`.

### 1.5 Name similarity (svc/expenseMatch.service.ts:29-47) -- crude by design
```js
const STOP = ['תשלום','העברה','חיוב','כרטיס','אשראי','בע','חשבון'];
const tokens = s => vendorKey(s).split(/\s+/).filter(w => w.length >= 3 && !STOP.includes(w));
function nameOverlap(vendor, description) {
  const a = tokens(vendor); const b = new Set(tokens(description));
  if (!a.length) return 0;
  const hits = a.filter(t => b.has(t) || [...b].some(x => x.includes(t) || t.includes(x))).length;
  return hits / a.length;          // fraction of VENDOR tokens found in the bank text
}
```
`vendorKey` (svc/expense.service.ts:142-153), the normalisation (Hebrew handling is just this):
```js
function vendorKey(name) {
  return String(name||'')
    .replace(/["'’״׳]/g, '')                              // strip ASCII + Hebrew quotes/geresh/gershayim FIRST (so בע"מ -> בעמ)
    .replace(/(^|\s)(בעמ|ltd|inc|llc)(?=\s|$)/gi, ' ')     // legal suffixes; anchored on whitespace, NOT \b (Hebrew letters are not \w in JS regex)
    .replace(/[-_.]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
```
- No stemming, no transliteration, no Hebrew-prefix stripping (ה/ב/ל), no punctuation removal beyond the above (commas/slashes/parentheses stay attached to tokens).
- Token minimum length 3 means the substring test (`x.includes(t)`) is never on 1-2 char fragments.
- Asymmetric: denominator is the vendor token count. A one-word vendor ("גוגל") found in a long bank line = 1.0.
- Note `'בע'` in STOP is a leftover for "בע"מ" split by punctuation (length 2, so already dropped by the >=3 filter).
- Migration 211 backfilled `vendor_key` with a simpler SQL version (no suffix strip) -- stored keys from before and the JS function can differ; new rows use the JS function.

### 1.6 Field verdicts for the UI (`compareFields`, expensePairs.service.ts:76-89)
Computed server-side so the screen never recomputes ("so the colours and the score can never tell different stories").
```js
paid = |tx.amount|; diff = |paid - owed|; rel = owed>0 ? diff/owed : 1
amount: diff <= 1                          -> 'same'
        rel <= 0.05 || (paid < owed && rel <= 0.35)  -> 'close'     // NB: ignores WITHHOLDING flag; band is 35% here
        else                               -> 'diff'
gap = daysBetween(tx.date, doc.doc_date)
date:   -2 <= gap <= 2 -> 'same';  2 < gap <= 45 -> 'close';  else (gap < -2 or > 45) -> 'diff'
name:   overlap >= 0.6 -> 'same';  overlap > 0 -> 'close';  else 'none'       // overlap = nameOverlap(doc.vendor_name, txText(tx))
ref:    docNumberInNote(doc.doc_number, tx.transfer_note) ? 'same' : 'none'
```
Minor inconsistencies to know (not bugs worth copying): scorePair rewards gap -3 as "same day" but compareFields calls -3 'diff'; compareFields' 'close' on 6-35% shortfall can show amber on rows scorePair would have scored 0 (only visible in the zero-score "nearest amount" alternatives).

UI colouring (cl/fmt.ts:55-60, cl/cards.tsx:13-16): `same` = green (emerald-100/800), `close` = amber, `diff` = red/rose, `none` = no tint.
`Tint` wraps: document vendor name (fields.name), document date (fields.date), document amount (fields.amount); charge title (name), charge date (date), charge amount (amount);
`transfer_note` is tinted green only when `fields.ref === 'same'`.
Score badge colour (cl/cards.tsx:192-196): `score >= 85` green, `>= 55` amber, else grey; shows `"{score}%"` only if score > 0, then `reasons.join(' · ')`.

### 1.7 Older single-charge API in the same file (still used by older screens; port only if needed)
- `suggestMatches(limit=100)`: for each unmatched outgoing charge, best open document with `score >= 55`; then one-document-one-charge dedupe by best score. Open document = `status IN ('captured','reconciled') AND needs_review = 0 AND paid < amount_total - 1`.
  **This is the engine tofy replaced** because it anchored on the charge and ignored `needs_review=1` docs, making a confirmed invoice vanish (see section 10).
- `rankCandidates(txId, limit=60)`: all open docs scored against one charge, best first including zero scorers, tie-break by `abs(daysBetween)` ascending.

---------------------------------------------------------------------------------------------------

## 2. Pair engine: `pairQueue` (svc/expensePairs.service.ts:159-209)

### 2.1 Inputs
```
range r = { from, to }     // route default: from = today - 1 year, to = today (routes/expenseDocuments.routes.ts:334-338)
```
**Documents** = `documentsWithState(r)` filtered to `lane === 'pair'` (section 4 defines lane). So document eligibility is:
not a waiting receipt, not `receipt_disposition='not_relevant'`, not settled (covered / paid-outside / closed-anyway), not marked "unpaid" (unpaid marks move it to the closed lane), `status != 'void'`, doc_date within [from,to].
`needs_review = 1` documents ARE included (accept confirms them in the same transaction).
Doc fields added: `remaining = round2(amount_ils - paid_total)` (0 if amount_ils null), `receipts[]` = linked receipts shown beside it (never paired themselves).

**Charges** = `unexplainedCharges({from, to: max(to, today)})` (charge window runs to today so an invoice dated on the last day of the range can still find its later charge; expensePairs.service.ts:139-142).
`unexplainedCharges` SQL (svc/noInvoiceRules.service.ts:106-122):
```
account.entity = 'business' AND amount < 0 AND status = 'completed' AND date BETWEEN from AND to
AND COALESCE(is_internal_transfer,0) = 0            -- internal transfers out
AND COALESCE(match_dismissed,0) = 0                 -- a person dismissed it
AND matched_card_account_id IS NULL                 -- card settlement line (itemised purchases carry the invoices)
AND NOT EXISTS expense_payments(transaction_id)     -- already linked (ours)
AND NOT EXISTS icount_expense_payments(transaction_id)
ORDER BY date DESC, id DESC
```
then each charge gets `exempt = exemptFor(description, rules)` (section 6). Split: `pool = exempt == null`, `exempt = exempt != null`.
**A charge with ANY link leaves the pool entirely** (even partially allocated) -- documented known limitation: one transfer paying several invoices can only be linked once through this screen.

Rejections: set of strings `"${side}:${ref_id}|${transaction_id}"` from `expense_pair_rejections`.
`rejKey(docKey, txId)` = parse doc key -> `"${side}:${ref_id}|${txId}"`. Trap (my reading, not documented in tofy): rejection is stored under the SIDE of the key used in the call; a merged document's `key` is always `ours:<id>` but `unpairCharge` from the closed tab is called with the payment's own `doc_key`, which is `icount:<id>` when the link lives on the iCount side -> that rejection would not match `ours:` lookup. Irrelevant if gan has a single document source.

### 2.2 Algorithm
```js
function pairQueue(r) {
  const docs = openDocs(r);                       // lane==='pair', each toPairDoc'd
  const { pool, exempt } = splitCharges(r);
  const rejected = rejectedSet();
  const why = new Map();
  const scorable = docs.filter(d => {
    if (d.amount_ils == null)              { why.set(d.key,'מטבע חוץ — חסר הסכום בשקלים שהבנק חייב'); return false; }
    if (d.remaining <= COVERAGE_TOLERANCE_ILS /*2*/) { why.set(d.key,'שולם כמעט במלואו — סגור ידנית או הוסף תנועה'); return false; }
    return true;
  });
  // 1) all scoring pairs above the bar
  const cands = [];
  for (doc of scorable) for (tx of pool) {
    if (rejected.has(rejKey(doc.key, tx.transaction_id))) continue;
    const s = score(tx, doc);                    // scorePair + doc-number bonus
    if (s.score >= SUGGEST_THRESHOLD /*55*/) cands.push({doc, tx, ...s});
  }
  // 2) sort: score desc, then nearer date, then stable ids
  cands.sort((a,b) => b.score - a.score
     || Math.abs(daysBetween(a.tx.date, a.doc.doc_date)) - Math.abs(daysBetween(b.tx.date, b.doc.doc_date))
     || a.doc.key.localeCompare(b.doc.key)
     || a.tx.transaction_id - b.tx.transaction_id);
  // 3) GREEDY GLOBAL assignment: each doc and each charge used at most once
  const usedDoc = new Set(), usedTx = new Set(), out = [];
  for (c of cands) {
    if (usedDoc.has(c.doc.key) || usedTx.has(c.tx.transaction_id)) continue;
    usedDoc.add(c.doc.key); usedTx.add(c.tx.transaction_id);
    out.push({ ...c, fields: compareFields(c.tx, c.doc, c.doc.remaining) });
  }
  out.sort((a,b) => b.score - a.score || b.doc.doc_date.localeCompare(a.doc.doc_date));   // display order
  return {
    pairs: out,
    docsWithoutProposal: docs.filter(d => !usedDoc.has(d.key)).map(d => ({...d, why: why.get(d.key) ?? 'לא נמצאה תנועה מתאימה'})),
    txWithoutDoc: pool.filter(t => !usedTx.has(t.transaction_id)),
    txNoInvoiceNeeded: exempt,
  };
}
```
Complexity is docs x pool (no indexing); fine for thousands.
Not an optimal (Hungarian) assignment: pure greedy by score. "One proposal per document, never per charge." Deterministic: same data gives same pairs.
Important: `docsWithoutProposal` is built from ALL `docs` (including the unscorable foreign-currency / almost-paid ones, with their `why`), not just `scorable`.

### 2.3 Output shapes
```
Pair = { doc: PairDoc, tx: Charge, score: 0..100, reasons: string[], fields: {amount, date, name, ref} }
PairDoc = ExpenseDocWithState + { remaining, receipts: [{id, doc_number, doc_date, amount_total, has_file}] }
Charge  = { transaction_id, date, description, amount(neg), account_type, account_label, processed_date, original_description,
            provider_category, bank_ref, counterparty, transfer_note, exempt: {rule_id,label,note}|null }
PairQueue = { pairs: Pair[], docsWithoutProposal: (PairDoc & {why})[], txWithoutDoc: Charge[], txNoInvoiceNeeded: Charge[] }
```
Four groups on screen: proposals; "documents with no proposal"; "charges with no document"; folded "no invoice needed" (never proposed).

### 2.4 Alternatives ("✗ לא זה" / "איזו חשבונית זו?")  limit default 5
`alternativesForDoc(key, r, limit=5)` (expensePairs.service.ts:216-261):
```
doc = openDocs(r).find(key); open = pool charges minus rejected(doc,tx)
IF doc.amount_ils == null (foreign currency, shekel amount unknown):
    candidates = open charges with gap = days(tx.date - doc.doc_date) in [-3, 45]
    sort by nameOverlap desc, then |gap| asc; take limit
    each: score 0, reasons ['מטבע חוץ — הסכום בשקלים יילקח מהחיוב', gap<=2?'אותו יום':`${gap} ימים אחרי`, +'שם דומה' if overlap>0],
          fields: amount 'close', date same(gap<=2)/close, name per overlap, ref per note
ELSE:
    scored = open.map(score(tx,doc)).filter(score>0).sort(score desc).slice(0,limit)     // NOTE: threshold 55 NOT applied here, any score>0
    if scored.length < limit: fill with "near" = open not already picked, |daysBetween|<=90,
        sorted by | |tx.amount| - doc.remaining | asc, take (limit - picked); each {score:0, reasons:['סכום קרוב']}
    attach fields = compareFields(tx, doc, doc.remaining)
```
`alternativesForTx(txId, r, limit=5)` (:264-286): tx must be in the pool (not exempt, not linked); docs = openDocs with `amount_ils != null` and not rejected(doc,tx); same scoring (score>0, top `limit`) then near-fill by `|doc.remaining - |tx.amount||` within 90 days of date; each `{doc, score, reasons, fields}`.
Alternatives are NOT globally de-duplicated: they can offer a charge already proposed to another document (the user is explicitly overriding).
A rejected pair is excluded from both alternative lists and from pairQueue, permanently (until undone by deleting the rejection row -- tofy has no UI for that).

### 2.5 Endpoints (routes/expenseDocuments.routes.ts)
```
GET  /pairs                                -> PairQueue
GET  /pairs/alternatives?key=              -> { alternatives: [{tx, score, reasons, fields}] }
GET  /pairs/alternatives-for-tx/:txId      -> { alternatives: [{doc, score, reasons, fields}] }
POST /pairs/accept   {key, transaction_id, amount?, review?{...}}   -> {ok:true} | error
POST /pairs/reject   {key, transaction_id}
POST /pairs/undo     {key, transaction_id}        (closed tab: "✗ לא שייך")
POST /unpaid-mark {key}   DELETE /unpaid-mark?key=      (query string, not body)
GET  /counts       -> { pair, receipts, closed }          (shape in section 8.6)
```
Error mapping `sendFail`: `NOT_FOUND`->404; `DUPLICATE`, `RECEIPT_NOT_PAIRABLE`, `ICOUNT_ONLY`->409; everything else 400. Body: `{error:{code,message}}`.
Whole router is admin-only (`tabGuard('expenses', requireAdmin)`).

---------------------------------------------------------------------------------------------------

## 3. Writes (svc/expensePairWrites.service.ts, svc/expenseDocLinks.service.ts)

Every write is a person's click. Nothing is called from a scan, poll or job.

### 3.1 `acceptPair({key, transaction_id, amount?, review?, by})`  -- ONE DB transaction (:37-96)
```
k = parseDocKey(key) else BAD_REQUEST; tx = bank_transactions[transaction_id] else NOT_FOUND
transaction {
  if k.side == 'ours':
     row = expense_invoices[k.ref_id]; if !row or status=='void' -> NOT_FOUND
     patch = pickReview(input.review)        // whitelist ONLY: vendor_name, supplier_tax_id, doc_type, doc_number, doc_date, amount_total, vat_amount, category, description
     if isReceiptLike({doc_type: patch.doc_type ?? row.doc_type, receipt_disposition: row.receipt_disposition,
                       supplier_tax_id: patch.supplier_tax_id ?? row.supplier_tax_id,
                       vendor_name: patch.vendor_name ?? row.vendor_name, source:'ours'}, exemptRules()) -> RECEIPT_NOT_PAIRABLE
     if !(tx.amount < 0) -> BAD_REQUEST 'אפשר לשייך רק חיוב יוצא'
     // FX RULE: foreign doc whose shekel figure is not confirmed takes it FROM THE CHARGE
     foreignUnconfirmed = (row.currency||'ILS') != 'ILS' && !row.fx_confirmed
     if foreignUnconfirmed && patch.amount_total == null: patch.amount_total = |tx.amount|    // what the bank charged, never a rate
     if patch non-empty: updateExpense(id, patch)        // supplying amount_total is what sets fx_confirmed=1 (expense.service.updateExpense)
     if row.needs_review: confirmCapture(id, by)         // needs_review=0, attribution='ours', notes += ' | אושר (משתמש N)', then syncReconciledStatus
     amount = |input.amount ?? tx.amount|; must be finite and > 0 else BAD_REQUEST
     linkPayment(id, tx.id, amount, by)                  // upsert (ON CONFLICT(expense_id,transaction_id) DO UPDATE amount), then syncReconciledStatus; any throw -> LINK_FAILED
  else (icount side): linkCharge({key, transaction_id, amount, by})        // plain INSERT; UNIQUE violation -> DUPLICATE 'התנועה כבר משויכת למסמך הזה'
}
on Refused -> return its Fail; on other exception -> ACCEPT_FAILED
logActivity('expense_pair_accepted', {key, transaction_id, reviewed: !!review})
```
Why one transaction: confirming a reading and linking as two steps could leave a confirmed invoice with no charge when the link is refused.
**Amount defaults to the CHARGE amount, never the document** (a 400 charge on a 1,000 invoice is a part payment; defaulting to the doc would close it on 400 of real money; expenseDocLinks.service.ts:54-59).
`ours`-side status sync (expense.service.ts:519-526): `reconciled` iff `paid > 0 && |paid - amount_total| <= 1` else `captured`; never touches `filed` or `void`. (Status is a cache for old screens; the lane logic uses its own 2 shekel rule, section 4.)

`linkCharge` (generic link, expenseDocLinks.service.ts:39-71): doc exists and not void; tx exists; `tx.amount < 0` else BAD_REQUEST; amount default = |tx.amount|.
`linkPayment` additionally rejects `tx.amount > 0` with 'התנועה היא תקבול, לא תשלום'.

### 3.2 `rejectPair({key, transaction_id})` (:98-107)
`INSERT OR IGNORE INTO expense_pair_rejections(side, ref_id, transaction_id, rejected_by)`. Idempotent. Validates key format and tx existence only. UI keeps the row in place with the charge dimmed ("✗ סימנת שזו לא התנועה — לא תוצע שוב") and opens alternatives.

### 3.3 `unpairCharge({key, transaction_id})` -- closed tab "✗ לא שייך" (:122-142)
Requires the link to exist (else NOT_FOUND 'לא נמצא שיוך להסרה'). One transaction: delete the link (ours via `unlinkPayment` which re-syncs status; icount side plain DELETE) **AND** insert the rejection. Reason: unlinking alone would make the pair tab propose the same charge for the same document again immediately.
Does not touch iCount; UI warns that if the doc is already in iCount the payment there must be fixed manually.

### 3.4 Unpaid marks (:144-160)
`markUnpaid({key})`: doc must exist (ours: not void); `INSERT OR IGNORE expense_unpaid_marks(side, ref_id, marked_by)`. Effect: lane becomes `closed` (sub `awaiting_payment`) if state != 'settled'. `unmarkUnpaid`: DELETE by (side, ref_id) -> returns to pair lane. Marking does not create any payment; "when the payment arrives, pair it."

### 3.5 Other writes
- `unlinkCharge({key, transaction_id})`: plain DELETE of one link; NOT_FOUND if none (expenseDocLinks.service.ts:80-90).
- `setDocDecision({key, paid_outside_bank, closed_anyway, note})`: **upsert one row per document**, whole row overwritten (`ON CONFLICT(side,ref_id) DO UPDATE`); sending neither flag clears both = taking the decision back. Note is trimmed, '' -> null. Doc must exist. (:108-133). POST `/decision`.
- `setIdentity({expense_id, icount_expense_id, verdict})`: upsert (user may change mind).
- Unpaid marks are a SEPARATE table from decisions precisely because the decisions upsert rewrites the whole row (spec §3).

---------------------------------------------------------------------------------------------------

## 4. Coverage rule, lanes, closed (svc/expenseDocuments.service.ts:344-540, svc/expenseClosed.service.ts)

### 4.1 Constants
```
COVERAGE_TOLERANCE_ILS = 2          (expenseDocuments.service.ts:357)  ROUNDING ONLY
```
Deliberately NOT widened to cover withholding (a supplier paid net of withholding receives LESS by 5-30%, "lawfully and forever"); that gap must stay visible and a person closes it with `closed_anyway`.

### 4.2 State and lane (exact, :493-539)
```js
payments  = links on ours:<id> + links on icount:<id> (merged doc collects both)       // [{transaction_id, amount, date, description, account_type}]
paid_total = round2(sum(payments.amount))
paid_outside_bank = any side has decision.paid_outside_bank
closed_anyway     = any side has decision.closed_anyway

state =
   amount_ils == null                         -> 'awaiting_fx'    // checked FIRST, stays waiting even with money linked (no number to cover)
 : paid_outside_bank || closed_anyway         -> 'settled'
 : payments.length == 0                       -> 'needs_match'
 : paid_total >= amount_ils - 2               -> 'settled'        // over-payment also settled
 : else                                       -> 'partial'

marked           = any side has unpaid mark
awaiting_payment = marked && state != 'settled'

lane =
   receipt_disposition == 'not_relevant'      -> 'hidden'
 : isReceiptLike(doc, exemptRules)            -> 'receipts'
 : state == 'settled' || awaiting_payment     -> 'closed'
 : else                                       -> 'pair'          // needs_match | partial | awaiting_fx (unless unpaid-marked)
```
`amount_ils` (shekel figure): ILS doc -> `amount_total`; foreign doc -> `amount_total` if `fx_confirmed` else **null** (null keeps it out of the matcher so $200 is never matched to a 200 shekel charge; shekel amount = what the bank charged, never a conversion). (:339-342). Known imprecision: pre-migration-215 foreign rows have fx_confirmed=1 with the foreign figure.
`remaining` (pair engine) = `round2(amount_ils - paid_total)`.
Partial: a document with some payments but `paid_total < amount_ils - 2` stays in the pair lane with `remaining` as the target; proposals are scored against `remaining`. Accepting a charge smaller than the doc is a part payment.
A charge larger than the remainder is still linkable (amount defaults to the full charge; no clamp).

`isReceiptLike(d, rules)` (:404-412):
```js
if (d.source === 'icount') return false;                         // bookkeeper-typed rows are never "waiting receipts"
if (d.doc_type !== 'receipt') return false;                      // invoice_receipt is an invoice
if (d.receipt_disposition === 'no_invoice_issuer') return false; // receipt IS the document
return exemptRuleFor(d.supplier_tax_id, d.vendor_name, rules) == null;
```

### 4.3 `isClosed(expenseId)` (expenseClosed.service.ts:137-147)
Recomputes `documentsWithState` over `[doc_date-120d, doc_date+120d]` (wide enough to find a differently-dated iCount twin, because merge is computed within the window) and returns `lane === 'closed'`. Used by the file-to-iCount route to refuse anything not closed (`NOT_CLOSED`, HTTP 409; "the server checks it too, not just where the button is drawn").
Port note: if gan has one document source, `isClosed` = `lane(doc) === 'closed'` computed from that doc's own payments+decisions+marks.

### 4.4 Closed lane output (`closedLane(r)`, :104-128)
Per `lane==='closed'` document:
```
ClosedRow = {
  doc, receipts: [linked receipts], payments: [ClosedPayment sorted by date asc],
  sub: doc.awaiting_payment ? 'awaiting_payment' : 'settled',
  icount: icountStanding(doc),          // 'filed' if status=='filed' or icount_filed_at; 'in_icount' if source in (icount,both); else 'not_filed'
  filed_docnum: doc.icount_docnum,
  outside_bank: (paid_outside_bank||closed_anyway) ? {paid_outside_bank, closed_anyway, note: first non-null note from either side's decision} : null
}
ClosedPayment = { doc_key, transaction_id, amount, date, processed_date, description, counterparty, transfer_note, bank_ref, account_label, account_type }
```
`doc_key` per payment is the side that holds the link (needed so undo hits the right side).

### 4.5 "Closed anyway" / "paid outside bank"
- `paid_outside_bank`: cash, offset against a customer, somebody else's card (employee card repaid via salary) -> no charge will ever exist.
- `closed_anyway`: partial that is genuinely finished; "withholding is the ordinary case". Note is mandatory-in-spirit ("a gap closed without a reason is indistinguishable a year later from a gap nobody noticed") but not enforced in code.
- Either flag -> `settled` regardless of payments. In UI (closed tab) shown only when `payments.length == 0`: "💵 שולם מחוץ לבנק" or "✓ נסגר ידנית" + note.
- Withholding tax gap treatment: **not tolerated by coverage and not scored**. With `EXPENSE_EXPECT_WITHHOLDING` off, a shortfall > 5% gets score 0 (no proposal); the user pairs by hand via alternatives (`near` fill, "סכום קרוב"), the doc stays `partial` with a visible remaining, and the user presses `closed_anyway` + note. With the flag on, the shortfall 3-35% scores 25 (+ date + name) and reason 'שולם N% פחות — ייתכן ניכוי מס במקור'.
- Fully paid but not settled by rounding: doc with `remaining <= 2` but not `settled` cannot happen from payments (settled uses the same 2), except foreign/null-amount; the 'שולם כמעט במלואו — סגור ידנית או הוסף תנועה' reason covers `remaining <= 2` while still in pair lane (e.g. due to a marked-unpaid mismatch or race).

---------------------------------------------------------------------------------------------------

## 5. Receipts lane (svc/expenseReceipts.service.ts, svc/expense.service.ts:355-447)

Rule: **a receipt is never paired with a charge** (owner files INVOICES; a receipt hung on a charge books the same expense twice when the invoice arrives). It waits for its invoice.

### 5.1 Constants
```
AWAITING_INVOICE_DAYS = 14        (expense.service.ts:361)  overdue threshold, shown red: "ממתינה N ימים — לבקש מהספק את החשבונית"
LOOKBACK_DAYS = 540               receipts older than this are not shown (expenseReceipts.service.ts:42)
RECENT_DAYS = 60                  "הוצמדו לאחרונה" window, measured on the RECEIPT's doc_date (:44, :130-131)
```
`days_waiting = max(0, floor(now - (receipt_disposition_at ?? doc_date)))` (SQL julianday cast to INTEGER).

### 5.2 How the invoice number on a receipt is found -- NO REGEX
There is no regex over text. `referenced_doc_number` is extracted by the LLM at capture time (svc/invoiceExtract.service.ts:69, 79-83). Prompt rule (Hebrew, paraphrase): on a receipt the invoice it closes is usually printed under "פירוט הסעיפים" or "על חשבון"; copy it EXACTLY as printed into `referenced_doc_number`; it is the number of ANOTHER document, not this one's doc_number; if absent -> null, never guess.
Stored at read time (mailSorter.service.ts:208, 297; paymentEmails.service.ts:690, 982). Port: add the same field to your extraction prompt/schema, or let the user type it.

### 5.3 Auto-link: `findReferencedInvoice(receipt)` (expense.service.ts:373-390)
```sql
SELECT id FROM expense_invoices
 WHERE id != :receipt.id AND status != 'void'
   AND doc_type IN ('tax_invoice','invoice_receipt')
   AND doc_number IS NOT NULL
   AND REPLACE(REPLACE(doc_number,' ',''),'-','') = REPLACE(REPLACE(:ref,' ',''),'-','')     -- exact after removing spaces and hyphens ONLY (case-sensitive, leading zeros significant, no digits-only normalisation)
   AND (vendor_key = :vendorKey(receipt.vendor_name) OR (supplier_tax_id IS NOT NULL AND supplier_tax_id = :receipt.supplier_tax_id))
 ORDER BY id LIMIT 1
```
Number AND supplier must both match ("two suppliers sharing a sequence is ordinary"). Credit notes and `other` never auto-link targets.

### 5.4 `GET /receipts` WRITES (the trap)
`receiptsLane()` first calls `sweepAutoLinks()` (expenseReceipts.service.ts:53-74) on **every read**, and `GET /counts` also calls `receiptsLane()` (so the badge fetch writes too):
```sql
waiting = SELECT id, vendor_name, supplier_tax_id, referenced_doc_number FROM expense_invoices
   WHERE doc_type='receipt' AND status!='void' AND linked_invoice_id IS NULL
     AND referenced_doc_number IS NOT NULL AND referenced_doc_number != ''
     AND (receipt_disposition IS NULL OR receipt_disposition = 'has_invoice')
for each r: inv = findReferencedInvoice(r); if inv:
   UPDATE expense_invoices SET linked_invoice_id = inv, receipt_disposition='has_invoice',
          receipt_disposition_at = COALESCE(receipt_disposition_at, now), updated_at = now WHERE id = r.id
```
Not in a transaction as a whole (each UPDATE autocommits), no activity log, no `by`. Rationale in code: a link that appears only at the next sweep leaves the owner chasing an invoice that arrived an hour ago. `move_plan` (payments on a linked receipt) is computed read-only in the same GET; moving requires a POST.
Second path: `backlinkWaitingReceipts(invoiceId)` (expense.service.ts:425-447), called after a new invoice is captured: scans receipts with `receipt_disposition='has_invoice' AND linked_invoice_id IS NULL AND referenced_doc_number IS NOT NULL`, same `findReferencedInvoice` equality, sets `linked_invoice_id`. Only for invoice docs with doc_number and type tax_invoice/invoice_receipt.
Port advice: do it on write (invoice created/edited, receipt created) instead of on GET; if you copy tofy, keep it idempotent.

### 5.5 `receiptsLane()` output
Query: `doc_type='receipt' AND status!='void' AND disposition != 'not_relevant' AND now - doc_date <= 540d`, then filter `isReceiptLike`. Outputs:
```
waiting = rows with linked_invoice_id == null
overdue = waiting.filter(days_waiting >= 14)
linkedRecently = rows with linked_invoice_id != null and doc_date within 60 days
exemptSuppliers = rules + {receipts: count of expense_invoices with exempt_rule_id = rule.id}
grace_days = 14
ReceiptRow = { id, vendor_name, supplier_tax_id, doc_number, doc_date, amount_total, currency, referenced_doc_number,
               linked_invoice_id, linked_invoice:{id,vendor_name,doc_number,doc_date,amount_total}|null, days_waiting, has_file,
               payments:[{transaction_id, amount, date, description}] }     // charges hung on the receipt before this tab existed
```
GET /receipts returns `{...receiptsLane(), move_plan}`.

### 5.6 Candidates for manual attach: `invoiceCandidates(receiptId, limit=8)` (:143-167)
```
rows = expense_invoices WHERE id != receipt AND status != 'void' AND doc_type != 'receipt' AND |doc_date - receipt.doc_date| <= 120 days
sameSupplier = (receipt.supplier_tax_id && inv.supplier_tax_id == receipt.supplier_tax_id) || inv.vendor_key == vendorKey(receipt.vendor_name)
sameAmount   = |inv.amount_total - receipt.amount_total| <= 1
rank = (sameSupplier?2:0) + (sameAmount?1:0); drop rank 0
sort rank desc, then |gap days| asc; take 8
why = ['אותו ספק'?, 'אותו סכום'?].join(' · ')        // "supplier name is spelled differently on its two documents often enough to matter" -> same amount from anyone is offered
```

### 5.7 `linkReceipt(receiptId, invoiceKey)` and moving payments (:199-223, 176-197)
Errors: bad key BAD_REQUEST; `icount:` key -> `ICOUNT_ONLY` ('attach the invoice file to the system first'); receipt not found/not receipt -> NOT_FOUND; invoice not found -> NOT_FOUND; target is itself a receipt -> BAD_REQUEST.
One transaction: `UPDATE receipt SET linked_invoice_id, receipt_disposition='has_invoice', receipt_disposition_at=COALESCE(.., now), receipt_disposition_by=COALESCE(.., by)` then `movePayments`.
`movePayments(receiptId, invoiceId)`: for each `expense_payments` row on the receipt: if the invoice already has that `transaction_id` -> **keep both** (kept++; "which was right is a person's question"); else DELETE from receipt, INSERT on invoice (same amount, `matched_by` kept else `by`, `match_confidence` kept else 100), log `expense_receipt_payment_moved`. After any move: `syncReconciledStatus` on both docs.
`movePaymentsPlan()` (read-only): every payment on a receipt that is already linked to an invoice, `action = 'move' | 'keep_both'`. `applyMovePayments(by)` dedupes by (receipt, invoice) pair and runs all in one transaction. POST `/receipts/move-payments`.

### 5.8 Exempt supplier ("עוסק פטור / עמותה -- הקבלה היא המסמך"), per SUPPLIER not per receipt (:266-310)
`addExemptSupplier(receiptId)`:
```
tax = trim(receipt.supplier_tax_id) || null;  key = tax ? null : vendorKey(vendor_name)
if neither -> BAD_REQUEST 'לקבלה אין שם ספק או ח.פ לזהות אותו'
transaction {
  ruleId = exemptRuleFor(tax, vendor_name)  (existing) else INSERT receipt_exempt_suppliers(supplier_tax_id=tax, vendor_key=key, label=vendor_name)
  UPDATE expense_invoices SET receipt_disposition='no_invoice_issuer', exempt_rule_id=ruleId, receipt_disposition_at=now, receipt_disposition_by=by
   WHERE doc_type='receipt' AND status!='void' AND linked_invoice_id IS NULL
     AND (receipt_disposition IS NULL OR receipt_disposition='has_invoice')
     AND (tax ? supplier_tax_id = tax : vendor_key = key)
}
-> { rule_id, changed }
```
Rule matching at read time (`exemptRuleFor`, expenseDocuments.service.ts:388-398): by tax id first (`rule.supplier_tax_id == doc.supplier_tax_id`), else `rule.vendor_key == vendorKey(doc.vendor_name)`. Existing and FUTURE receipts of that supplier become invoice-like (lane pair).
`removeExemptSupplier(ruleId)`: transaction: `UPDATE ... SET receipt_disposition=NULL, exempt_rule_id=NULL, receipt_disposition_at=NULL, receipt_disposition_by=NULL WHERE exempt_rule_id=ruleId AND status != 'filed'`, then DELETE the rule. Only receipts carrying that rule id revert.
Other dispositions via `setReceiptDisposition` (expense.service.ts:399-415): refuses `status=='filed'`; `has_invoice` attempts `findReferencedInvoice` immediately and may leave `linked_invoice_id` null (a wait, not an error).

---------------------------------------------------------------------------------------------------

## 6. No-invoice rules (svc/noInvoiceRules.service.ts, migration 308:90-116)

### 6.1 Shape and matching
```
no_invoice_rules { id, match_text (non-empty), label (non-empty), note|null, is_builtin 0/1, created_by, created_at }
exemptFor(description, rules):
   d = trim(description || ''); if !d return null
   for r of rules (order: is_builtin DESC, id ASC): if d.includes(r.match_text) return {rule_id, label, note}     // FIRST match wins
```
**Plain case-sensitive substring on `bank_transactions.description` only** (not original_description, counterparty or note). No regex, no normalisation, no word boundaries. Hebrew has no case; Latin text is case-sensitive.
Guardrails: `addRule` rejects empty `match_text` ("would substring-match every description and silently empty the problem list") and empty label; `deleteRule` only deletes `is_builtin = 0`.
Two invariants (noInvoiceRules.service.ts:11-19): (1) **nothing disappears**: exempt charges are still returned with the rule label + note, shown folded in a "לא צריך חשבונית" section; (2) **a rule only ever concerns a charge, never closes a document.**
Hazard: substring matching is broad ('עמלה' matches any description containing it; 'מע"מ' matches a supplier whose description includes it). 'מע"מ' contains a quote; stored as typed in the bank feed (ASCII quote in the seed).

### 6.2 The 5 seeded groups (10 built-in rows) -- migration 308:103-115
Seeded once, guard `WHERE NOT EXISTS (SELECT 1 FROM no_invoice_rules WHERE is_builtin = 1)` (migrations re-run on boot in tofy).
| match_text | label | note |
|---|---|---|
| `משכורת` | `משכורות` | `התלוש הוא המסמך, לא חשבונית ספק` |
| `העברת משכורות` | `משכורות` | same |
| `עמלה` | `עמלות בנק` | `הבנק לא מוציא חשבונית לכל עמלה` |
| `עמלת העברה` | `עמלות בנק` | same |
| `מע"מ` | `מיסים ורשויות` | `תשלום לרשות, לא לספק` |
| `מקדמות מס` | `מיסים ורשויות` | same |
| `מס הכנסה` | `מיסים ורשויות` | same |
| `ביטוח לאומי` | `ביטוח לאומי` | `תשלום לרשות, לא לספק` |
| `החזר הלוואה` | `החזרי הלוואה` | `החזר, לא הוצאה עם חשבונית` |
| `קרן והצמדה` | `החזרי הלוואה` | same |
(Five label groups: salaries, bank fees, taxes/authorities, national insurance, loan repayments. Note `עמלה` makes `עמלת העברה` redundant; kept for clarity.)

### 6.3 `unexplainedCharges` -- see section 2.1 SQL. Exact same exclusions as `expense.service.unmatchedOutgoing` (expense.service.ts:705-721) EXCEPT that it also excludes charges linked through `icount_expense_payments`.
`unmatchedOutgoing(limit=200)` (older): same filters minus iCount links, `ORDER BY date DESC LIMIT`, no rule exemption. (Trap, section 10.)
REST: `GET /rules`, `POST /rules {match_text,label,note}`, `DELETE /rules/:id`.

---------------------------------------------------------------------------------------------------

## 7. Search (svc/expenseSearch.service.ts)

```
SearchParams = { q, amount_min, amount_max, from, to, ref, kind: 'all'|'invoice'|'receipt'|'bank'|'card', lane: 'all'|'pair'|'receipts'|'closed'|'hidden' }
LIMIT = 200 (result cap; UI shows "200+"); sorted by date DESC at the end then sliced
defaults: from = today - 2 years; to = today
norm(s) = vendorKey(s)                                   // same normalisation as matcher: בע"מ == בעמ, "A-22140" == "A22140"? (vendorKey turns '-' into space, so "a 22140" -- both query and haystack are normalised the same way, so they meet)
refNorm(s) = String(s||'').replace(/[\s\-_/.]/g,'').toLowerCase()
inAmount(a) = (min==null || a >= min) && (max==null || a <= max)          // INCLUSIVE both ends, on ABSOLUTE shekel amount
```
**Documents** (kind all/invoice/receipt): iterate `documentsWithState({from,to})` (so date filter applies to `doc_date`); kind = receipt if `doc_type=='receipt'` else invoice; lane filter on the computed lane; `amount = amount_ils ?? amount_total`;
`ref` filter: `refNorm(doc_number).includes(ref) || refNorm(supplier_tax_id) === ref` (tax id must match exactly, doc number by substring);
`q` filter: `norm([vendor_name, doc_number, supplier_tax_id, extra(description, category, attachment_name, customer_name)].join(' ')).includes(norm(q))`.
Hit: `{kind, key, title: vendor_name, subtitle: [ 'קבלה'|'חשבונית · מאייקאונט'|'חשבונית', 'מס׳ N', 'ח.פ X' ].join(' · '), date: doc_date, amount, currency (doc currency if amount_ils null else 'ILS'), lane}`.
**Charges** (kind all/bank/card): `entity='business' AND amount<0 AND date BETWEEN from AND to` (no status filter; includes linked/internal); kind = `card` if `account.type=='card'` else `bank`;
`ref` filter: `refNorm(bank_ref).includes(ref) || refNorm(transfer_note).includes(ref)`;
`q` filter: `norm(description + original_description + counterparty + transfer_note + provider_category + ' ' + bank_ref).includes(norm(q))`;
`lane` = `linked ? 'closed' : (internal || matched_card_account_id) ? null : exempt ? 'no_invoice' : 'pair'` where `linked` = exists in either payments table, `exempt` = `exemptFor(description, rules)`.
Hit: `{kind, transaction_id, title: counterparty ? 'אל: '+counterparty : description, subtitle: [account_label, refLabel(bank_ref), 'הערה: '+transfer_note, description-if-counterparty].join(' · '), date, amount: |amount|, currency:'ILS', lane}`.
`lane` null shows "מחוץ למסך". `lane` filter on the charge side applies to the computed value (so filter `closed` returns linked charges). Click -> go to lane tab with `focus = doc.key | 'tx-<id>'`; hits with lane `no_invoice`/`hidden`/null are not clickable.
`refLabel(ref)`: `inst:2/3` -> `תשלום 2 מתוך 3` (Max instalments), else `אסמכתא <ref>` (cl/fmt.ts:20-24).
Route: `GET /search?q&ref&from&to&amount_min&amount_max&kind&lane` -> `{hits}`; non-numeric amounts or malformed dates -> 400.

---------------------------------------------------------------------------------------------------

## 8. Client tabs (cl/ExpensesShell.tsx and siblings)

URL: `?view=pair|receipts|closed|search|tools&focus=<doc key | tx-ID>`; focus scrolls the element `#w-<focus>` to centre and rings it. Default view `pair`.
Shell header: "+ מסמך" (opens tools with add=1), "📨 משוך ממיון מיילים (N waiting)" pull button when the mail sorter is configured, and ONE amber status line "⚠️ מיון המיילים לא עונה: <err>" only when upstream is stuck. Tabs show count badges from `/counts` (refreshed after every action via `onChanged`; tab content remounts on `view`+`tick`).

Tab list (labels): `🎯 לשייך`(count) | `🧾 קבלות`(count) | `✅ סגור — לאייקאונט`(count) | `🔎 חיפוש` | `⚙️ כלים` (legacy screen embedded).

### 8.1 Shared cards (cl/cards.tsx)
**DocCard** (orange): icon 🧾; vendor name (or "— ספק לא נקרא —") [tinted by fields.name]; doc-type pill (`DOC_TYPE_LABEL`: חשבונית מס / חשבונית מס/קבלה / קבלה / חשבונית זיכוי / מסמך); sky pill "מאייקאונט" if `source != 'ours'`;
line 2: `מס׳ <doc_number>`, `dd/mm` date [tinted fields.date], bold amount via `docAmount` [tinted fields.amount] (foreign: `$200 · ₪xxx`, or `$200` while shekel unknown);
line 3: `ח.פ <id>`, `📎 המסמך` file link (only for our docs with a scan);
red warning if tax id fails the Israeli check digit: "⚠️ הח.פ לא עובר ספרת ביקורת — כנראה נקרא לא נכון מהמסמך. הספק יזוהה לפי השם." (`taxIdLooksMisread`: digits only, length 1..9, `!isValidIsraeliId(padStart(9,'0'))`);
green strip "שויך ₪X · נותרו ₪Y" when `paid_total > 0` (partial); violet lines for linked receipts "🧾 קבלה <no> dd/mm ₪X 📎";
**inline review form** when `needs_review`: amber box "✎ קריאה אוטומטית — בדוק ותקן לפני האישור" with editable ספק, מס׳ מסמך, ח.פ, תאריך (date input), סכום כולל (label becomes "סכום בשקלים (מהחיוב)" with placeholder "יילקח מהחיוב" for foreign docs, initial value '' if foreign and amount_ils null), סוג (select of doc types). `reviewPatchOf` sends only CHANGED fields (amount parsed `replace(/[^\d.]/g,'')`, must be >0).
**TxCard** (blue): icon 💳 for card else 🏦; title `אל: <counterparty>` else description; grey description line when counterparty exists; `dd/mm` date [tint date], bold `|amount|` [tint amount]; account label, `אסמכתא N`/`תשלום i מתוך n`, for cards `ירד מהחשבון dd/mm` if processed_date != date, provider_category; `הערה: <transfer_note>` [green when ref same]; grey "שם המקבל עוד לא נקרא מהבנק" for bank charges with no counterparty.
**Reasons** column between the two cards: `⟷` (or `↕` on mobile), `"{score}%"`, reasons joined by ` · `.
Layout: grid `lg:grid-cols-[1fr_7.5rem_1fr]` = document | reasons | charge. RTL: doc on the right, charge on the left.

### 8.2 🎯 לשייך (cl/PairTab.tsx), data = `GET /pairs`
Top: embedded "employee expenses awaiting approval" panel (tofy-specific; skip). Status line: `N זוגות מוצעים` (blue) · `N חשבוניות בלי הצעה` (orange) · `N תנועות בלי חשבונית` (rose).
Sections, in order:
1. **Proposals** (one glass card per pair, empty state "אין הצעות פתוחות ✓"): DocCard | Reasons | TxCard. Buttons: green `✓ נכון, שייך` (or `✓ נכון — אשר ושייך` when `needs_review`) -> `POST /pairs/accept {key, transaction_id, review?}`; `✗ לא זה — הראה אפשרויות` -> `POST /pairs/reject`, then loads alternatives; the rejected charge dims with text "✗ סימנת שזו לא התנועה — לא תוצע שוב" and accept/reject buttons disappear, alternatives list opens below (dashed blue box "אפשרויות אחרות ל"<vendor>":" with each option a TxCard + reasons + blue button `שייך לזו` / `אשר ושייך לזו`; empty: "אין תנועה פתוחה שמתאימה."; last button full width `אף אחת — ⏳ עוד לא שולמה, להעלות בכל זאת`).
2. **🧾 חשבוניות בלי הצעה (N)**: grid of DocCards with the `why` text; buttons `🔎 חפש תנועה` (loads `alternatives`) and `⏳ עוד לא שולמה` (confirm dialog -> `POST /unpaid-mark`; message: moves to "סגור", can be filed to iCount from there, "when payment arrives pair it").
3. **💸 תנועות בלי חשבונית (N)** (empty "כל התנועות מוסברות ✓"): TxCards each with `איזו חשבונית זו?` -> `GET /pairs/alternatives-for-tx/:id` -> list rows `<vendor> · <doc_number>` / `₪remaining · reasons` + `שייך` (disabled with tooltip "קודם אשר את קריאת החשבונית למעלה" if the doc `needs_review`); empty: "אין חשבונית פתוחה שמתאימה — אולי היא עוד לא הגיעה."
4. **Folded `◂ לא צריך חשבונית — עמלות, משכורות, מסים (N)`**: TxCards + rule label and note.
Behaviour: after any action, toast + reload + refresh counts. Rejected set resets on reload.

### 8.3 🧾 קבלות (cl/ReceiptsTab.tsx), data = `GET /receipts`
- Amber banner when `move_plan` has `action=='move'`: "N קבלות כבר מוצמדות לחשבונית, אבל תנועת הבנק רשומה על הקבלה" + up to 8 lines (`vendor · dd/mm · ₪`) + button `העבר את השיוך לחשבוניות` (-> `POST /receipts/move-payments`, result "הועברו N שיוכים · M נשארו על שניהם").
- **⏳ ממתינות לחשבונית (N)** + note: receipt not uploaded to iCount nor paired with the bank, after 14 days red. Cards sorted overdue-first. Card: `🧾 vendor`, amount; line `קבלה <no> · dd/mm/yy`, `ח.פ`, `"עבור חשבונית <referenced_doc_number>"`, file link; overdue: red `ממתינה N ימים — לבקש מהספק את החשבונית`; amber warning if it still carries bank payments ("יעבור לחשבונית כשתוצמד"). Buttons: `הצמד לחשבונית…` (loads candidates; each row `vendor · doc_number` / `dd/mm/yy · ₪ · why` + `הצמד` -> `POST /receipts/:id/link {invoice_key}`; empty text "לא נמצאה חשבונית מתאימה. אם היא עוד לא הגיעה — הקבלה תחכה כאן."), `הספק עוסק פטור / עמותה — הקבלה היא המסמך` (confirm shows identification by ח.פ or by name; `POST /receipts/:id/exempt`, toast "N קבלות של הספק עברו ל"לשייך"").
- **✓ הוצמדו לחשבונית לאחרונה (N)**: green lines `vendor · קבלה dd/mm ₪ ↔ חשבונית <no> dd/mm ₪`.
- **ספקים פטורים**: `label · ח.פ X | לפי שם · N קבלות` + `בטל` (-> `DELETE /receipt-exempt/:ruleId`, "N קבלות חזרו לכאן").

### 8.4 ✅ סגור (cl/ClosedTab.tsx), data = `GET /closed` -> `{rows: ClosedRow[]}`
Status: `N ממתינות להעלאה · M סגורות בסך הכל`; toggle `ממתינות להעלאה` (`icount=='not_filed'`, default) / `הכל`. Sort: not_filed first, then doc_date desc. Empty: "הכל הועלה ✓" / "אין עדיין הוצאות סגורות".
Columns (4): **חשבונית** (vendor, "מאייקאונט" pill, `type no · dd/mm/yy · amount`, ח.פ, file, misread-tax-id warning) | **קבלה** (ReceiptLine(s); else "— חשבונית מס/קבלה" if invoice_receipt else "— אין") | **תנועה** (per payment: icon + `אל: counterparty`/description, date · **amount** · account label · reference, `הערה: note`, button `✗ לא שייך` -> confirm -> `POST /pairs/undo {key: payment.doc_key, transaction_id}`; or `💵 שולם מחוץ לבנק`/`✓ נסגר ידנית` + note when outside_bank and no payments; or yellow dashed `⏳ עוד לא שולמה` + `החזר ל"לשייך"` -> `DELETE /unpaid-mark`) | **אייקאונט** (`✓ הועלה · <docnum>` / `✓ כבר באייקאונט` / green button `⬆ העלה לאייקאונט`).
Filing: confirm "בודקת קודם אם המסמך כבר קיים שם", marks awaiting-payment docs as uploaded without payment; server errors `NOT_CLOSED` (not in closed lane), `PROBABLE_DUPLICATE` (asks "להעלות בכל זאת ולהוסיף מסמך חדש?" and retries with `confirmDuplicate=true`). iCount integration itself is out of scope for gan.

### 8.5 🔎 חיפוש (cl/SearchTab.tsx)
Form fields: free text (placeholder "טקסט חופשי: ספק, תיאור, שם מקבל…"), ref ("מס׳ חשבונית / אסמכתא / ח.פ"), amount from / to, date from / to, type select (הכל/חשבוניות/קבלות/תנועות בנק/תנועות Max), state select (כל מצב/לשייך/קבלות/סגור), `🔎 חפש`.
Results: count (`200+` at cap), row = kind icon, title, subtitle, `dd/mm/yy`, amount (foreign shows `<amount> <CUR>`), lane pill (לשייך / קבלות / סגור / הוסר / לא צריך חשבונית / מחוץ למסך); clickable rows jump to the tab with focus.

### 8.6 `GET /counts` shape (routes/expenseDocuments.routes.ts:358-369)
```
{ pair:     pairs.length + docsWithoutProposal.length + txWithoutDoc.length + pendingEmployeeExpenses.length,
  receipts: receiptsLane().waiting.length,
  closed:   closedLane(range).filter(r => r.icount === 'not_filed').length }
```
Note it runs the full pairQueue + receiptsLane (which sweeps/writes) + closedLane on every call; comment says one request replaces three.

---------------------------------------------------------------------------------------------------

## 9. Document identity and duplicates

### 9.1 Vendor key -- `vendorKey` (section 1.5). Stored in `expense_invoices.vendor_key` at create/update (expense.service.ts:301, 331).
A second, separate normaliser exists for cross-system comparison (`supplierKey`, icountExpenseFile.service.ts:165-174): lowercases first, strips `["'’״׳,]`, `[-_.]` -> space, strips suffixes `בעמ|ltd|inc|llc|pbc|corp|gmbh|plc|bv|ag`. Deliberately not `vendorKey` because that one is stored (changing it would silently break matching with stored keys).

### 9.2 Exact duplicate = hard stop (DB constraint)
Migration 211:30-32:
```sql
CREATE UNIQUE INDEX idx_expense_invoices_identity ON expense_invoices(vendor_key, doc_number) WHERE doc_number IS NOT NULL AND status != 'void';
```
Mongo: unique partial index `{vendor_key:1, doc_number:1}` with `partialFilterExpression: {doc_number: {$type: 'string'}, status: {$ne: 'void'}}` -- NOTE Mongo partial indexes do NOT support `$ne`; use `status: {$in: [...non-void statuses]}` or a computed `active` boolean. Voiding frees the number.
`doc_number` is compared as stored (not digit-normalised) in this index.

### 9.3 Attachment sha256 dedupe
Migration 211:19-21: `attachment_sha256 TEXT` + `CREATE UNIQUE INDEX idx_expense_invoices_file ON expense_invoices(attachment_sha256) WHERE attachment_sha256 IS NOT NULL`.
Flow (svc/mailSorter.service.ts:236-253): (1) if the sender-provided hash already exists -> ack and skip (`already++`) BEFORE any model call ("a re-send costs nothing"); (2) fetch bytes, **recompute sha256 from the bytes** (`createHash('sha256').update(bytes).digest('hex')`; do not trust the other service's hash), check again; (3) store file content-addressed `uploads/expense-docs/<sha[0:2]>/<sha><ext>` (`saveAttachment` validates `/^[a-f0-9]{64}$/`, svc/expenseFiles.service.ts:47-55). Order matters: hash before the LLM reading so duplicates cost nothing.
Also first-line guard from before: (email uid, attachment name) for the same message re-scanned.

### 9.4 Suspected duplicate = flag, never refuse (`findSuspectedDuplicate`, expense.service.ts:166-178)
```sql
SELECT id FROM expense_invoices WHERE status != 'void' AND id != :excludeId
  AND (vendor_key = :key OR (supplier_tax_id IS NOT NULL AND supplier_tax_id = :tax))
  AND ABS(amount_total - :amount) < 0.5
  AND ABS(julianday(doc_date) - julianday(:date)) <= 3
ORDER BY id LIMIT 1
```
Result stored in `duplicate_of` (FK, ON DELETE SET NULL) and shown; a caterer can legitimately bill two events at one price on one day, so refusing would lose a real expense. `updateExpense` re-evaluates it ("a correction can create a duplicate as easily as resolve one").

### 9.5 Cross-source identity (ours vs iCount): skip unless gan has two sources
`compareToIcount(ours, theirs)` (icountExpenseFile.service.ts:211-251):
```
trustedTaxId(v) = digits(v) if length<=9 and passes Israeli ID check digit (isValidIsraeliId(padStart(9,'0'))) else ''   // a misread ח.פ is set aside, not believed
sameByTax = ourTax && ourTax == theirTax
sameByName = !(ourTax && theirTax) && supplierKey(ourName) && equal            // name decides only when a tax id is missing on at least one side; two DIFFERENT tax ids -> name never consulted
docKey(v) = String(v).replace(/[^0-9a-zA-Z]/g,'').replace(/^0+/,'').toLowerCase()
if sameSupplier && docKey equal                  -> 'same_document'   (the ONLY auto-merge)
if !sameSupplier                                 -> 'different'
if |amount diff| < 0.5 && |date diff| <= 3 days  -> 'probable'        (asked as a QUESTION, stored in expense_identity_decisions; never auto-merged: a monthly retainer is the same supplier+amount every month)
else 'different'
```
`unifiedDocuments` merge (expenseDocuments.service.ts:174-297): iterate iCount rows; partner = first of our rows not already `taken` with decision != 'different' and (`same_document` or user-confirmed 'same'); merged key = `ours:<id>`, vendor_name = iCount's name, doc_date/amount = ours, payments and decisions collected from BOTH keys. iCount rows missing from the last pull (`gone_at`) are dropped UNLESS a charge is linked to them (otherwise the charge silently returns to the unexplained pile). Second pass attaches `probable_partner` question to iCount-only rows. Document list ordering `doc_date DESC, key ASC`.

---------------------------------------------------------------------------------------------------

## 10. Lessons, traps, and decisions (spec docs/superpowers/specs/2026-09-30-expenses-redesign-design.md sections 1, 2, 12; code comments; REVIEW_BRIEF.md is about iCount API probing -- nothing pairing-specific beyond "iCount rows store shekels already; foreign amount is what the BANK charged")

Owner decisions (spec §1, 30.09.2026, "do not reopen"):
1. The pairing is **invoice <-> charge**, not receipt <-> charge. A receipt waits for its invoice.
2. The pair screen = **proposed pairs**, one row per pair, document right / charge left, ALL details of both visible, green = agrees, red = differs. "✗ לא זה" opens next options INSIDE the row. No separate workbench.
3. Five tabs; header keeps only "+ document" and one status line when something upstream is stuck.
4. Upload to accounting only from the "closed" tab: fully paired expense OR an invoice marked "not paid yet - upload anyway" (gets its charge when payment arrives).
5. Exempt/non-profit supplier remembered **per supplier**.
6. Documents the bookkeeper typed into the accounting system appear in the same lists with a badge.

Root causes found (spec §2) -- these are the traps to avoid:
- **"Confirming an invoice made it vanish and reappear as a nameless lightbulb under the bank line"**: the old `suggestMatches` was anchored on the CHARGE and only considered `needs_review = 0`. Confirming a reading moved the doc out of one list and into a one-line suggestion under the charge, with only name and number visible and no side-by-side comparison. Fix: anchor on the DOCUMENT, show whole pairs, and make accept = confirm + link in one transaction.
- **`unmatchedOutgoing` ignores payments linked from the other (iCount) table and ignores `no_invoice_rules`**: a charge linked to an iCount-typed document kept appearing as "charge without invoice"; fees/salaries/taxes (~500 rows) drowned the real signal. Fix: `unexplainedCharges` (adds the second link table, adds rule exemption). Port lesson: any "unexplained money" query must exclude EVERY link source and must apply rules, or the list is noise.
- A receipt entering the same yellow `needs_review` queue made the UI ask the owner to "approve a receipt as an invoice"; the receipt tray was buried under tools. Fix: lanes derived on the server.
- A document could appear in two tabs; fix = exactly one lane per document, computed in one function.
- The bank scraper reads only 5 columns (date, description, reference, debit, credit); `memo`/payee is empty, so "who was this transfer to" is unknown; the schema column `counterparty` exists but stays null until an agent patch (phase 6, blocked on owner). Port: name-matching on bank transfers is weak without payee; `transfer_note` (free text) is the other evidence and the +25 doc-number bonus.

Known/unhandled (spec §12): a single charge paying several invoices leaves the pool after the FIRST link (`unexplainedCharges` excludes any charge with any link). Attaching a receipt to an invoice that exists only in iCount is refused (`ICOUNT_ONLY`).

Design rules repeated across the code (worth copying):
- One-document-one-charge in proposals (greedy), because accepting both would book one payment twice; alternatives intentionally unrestricted.
- Proposals PROPOSE only; every link is a person's click; links are safe because they are unmakeable (unlink + rejection).
- Rejections are permanent and keyed (document, charge); undo-from-closed also writes one.
- Direction of the date is not symmetric: payment follows invoice (card purchases reach the bank up to a month later); a charge dated before the invoice by >3 days is disqualifying.
- Amount: exact within 1 shekel is by far the strongest evidence; name alone never qualifies; approx amount (<=5%) needs corroboration to clear 55.
- Foreign currency: the shekel figure is what the bank charged, never a rate; doc stays out of the matcher (`amount_ils == null`) until a charge is accepted, which writes `amount_total` from the charge.
- Do not widen the settled tolerance (2 shekel) to absorb withholding.
- No stored lane/state/proposal: recomputed on every read (cost is a full scan of docs x charges per request; `/counts` does it too).
- `GET /receipts` and `GET /counts` mutate (auto-link sweep). If gan ports the sweep, run it on write paths and keep reads pure.
- Tax-id check digit: validate Israeli ID (9 digits, Luhn-like) and treat a failing number as misread (30.09.2026: 510298946 read as 516298946); fall back to name.
- Unique index on `(vendor_key, doc_number)` must exclude void rows; voiding is reversible.

---------------------------------------------------------------------------------------------------

## 11. Minimal port checklist (suggested order)

1. Port `vendorKey`, `nameOverlap`, `scorePair`, `docNumberInNote`, `compareFields` as pure functions + the unit cases from `svc/expenseMatch.test.ts`, `svc/expensePairs.test.ts` (not read here; they exist and are the best spec of edge cases).
2. Port `documentsWithState` as a pure function over `(documents, payments, decisions, unpaidMarks, exemptRules)`; keep `COVERAGE_TOLERANCE_ILS = 2`.
3. Port `unexplainedCharges` (all exclusions + no-invoice rules) and `pairQueue` (greedy) + `alternativesForDoc/ForTx`.
4. Port writes: accept (transactional: confirm + FX amount from charge + link), reject, unpair (unlink + reject atomically), unpaid mark, doc decision upsert. In Mongo use a multi-document transaction (replica set required) or order the writes so the link is last and idempotent.
5. Receipts lane: add `referenced_doc_number` to extraction; port `findReferencedInvoice` equality; auto-link on write; exempt-supplier rules per supplier.
6. Indexes: unique `(vendor_key, doc_number)` on non-void; unique `attachment_sha256`; unique `(expense_id, transaction_id)`; unique `(side, ref_id, transaction_id)` for rejections; index payments by `transaction_id`.
7. Tabs: pair / receipts / closed / search with the counts endpoint.

Source files (all `origin/main`): svc/expenseMatch.service.ts (213 lines), svc/expensePairs.service.ts (287), svc/expensePairWrites.service.ts (161), svc/expenseClosed.service.ts (147), svc/expenseReceipts.service.ts (310), svc/expenseSearch.service.ts (139), svc/noInvoiceRules.service.ts (140), svc/expenseDocuments.service.ts (540), svc/expenseDocLinks.service.ts (163), svc/expense.service.ts (749; vendorKey :142, findSuspectedDuplicate :166, AWAITING_INVOICE_DAYS :361, findReferencedInvoice :373, linkPayment :494, syncReconciledStatus :519, confirmCapture :533, unmatchedOutgoing :705), svc/icountExpenseFile.service.ts (compareToIcount :211), server/src/db/migrations/{211_expense_duplicates, 240_receipt_disposition, 308_expense_reconcile, 334_expenses_redesign}.sql, routes/expenseDocuments.routes.ts, cl/{ExpensesShell,PairTab,ReceiptsTab,ClosedTab,SearchTab,cards}.tsx, cl/fmt.ts.
