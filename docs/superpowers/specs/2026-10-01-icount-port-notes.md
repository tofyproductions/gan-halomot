# iCount EXPENSE integration - porting notes from tofy-friends

Source: `~/dev/tofy-friends`, `origin/main`, read 2026-10-01. All paths are under `server/src/` unless noted.
Target: JS + Mongo. SQLite tables in tofy map to Mongo collections (see section 12).
Short names used below:
- `ICNT` = services/icount.service.ts
- `FILE` = services/icountExpenseFile.service.ts
- `LEDGER` = services/icountExpenseLedger.service.ts
- `DOCS` = services/expenseDocuments.service.ts
- `LINKS` = services/expenseDocLinks.service.ts
- `CLOSED` = services/expenseClosed.service.ts
- `ROUTES-INV` = routes/expenseInvoices.routes.ts
- `ROUTES-DOC` = routes/expenseDocuments.routes.ts
- `EXP` = services/expense.service.ts
- `SCAN` = services/icountScanProbe.service.ts
- `BRIEF` = REVIEW_BRIEF.md (repo root)
- `PLAN` = EXPENSES_RECONCILE_PLAN.md (repo root)

Two principles to copy as-is (BRIEF section 6):
1. Reads may guess, writes may not. Every write path is a person's press, never a schedule.
2. "Not in iCount" is a claim about ALL rows. A partial read returns an error or a `complete:false` flag, never a verdict.

---

## 1. Auth / session (ICNT:7-58)

- Base URL: `https://api.icount.co.il/api/v3.php` (ICNT:7). Endpoints are appended: `/auth/login`, `/expense/search`, ...
- Env vars (ICNT:27-29): `ICOUNT_COMPANY_ID`, `ICOUNT_USER`, `ICOUNT_PASS`. Missing any -> throw `iCount credentials not configured`.
  - BRIEF:84 warns that tofy's `.env.example` once documented `ICOUNT_USERNAME`/`ICOUNT_PASSWORD`, which no code reads. Use the three names above.
- Login request (ICNT:38-43): `POST {BASE}/auth/login`, `Content-Type: application/x-www-form-urlencoded`, body `cid=<company>&user=<user>&pass=<pass>`, 20s timeout (`AbortSignal.timeout(20_000)`).
- Login response: JSON `{status:true, sid:"..."}`. Failure = `!data.status || !data.sid`.
- Session state is module-level (ICNT:11-14): `sessionId`, `sessionExpiry`, `loginInFlight`, `loginCooldownUntil`.
- Reuse: cache `sid` for 25 min (`sessionExpiry = now + 25*60*1000`, ICNT:50). Return it while `now < expiry`.
- Coalesce concurrent logins (ICNT:20): if `loginInFlight` exists, await it. iCount invalidates all but the last `sid`, so racing logins kill each other.
- Login backoff (ICNT:23, 46): after a failed login set `loginCooldownUntil = now + 10_000`. While cooling, `getSession` throws `iCount login backoff` without calling iCount.
- Re-login on expiry (ICNT:151-157): `icountPost` checks `data.status === false` AND the reason matches
  `/\bsid\b|session|logged|login required|unauthor|expired|invalid token/i`. It tests `JSON.stringify(data.reason ?? data.error_description ?? data.error ?? '')`.
  - If it matches and `now - lastForcedReset > 20_000` (a GLOBAL 20s guard against a login storm): `lastForcedReset = now; resetSession(); return icountPost(endpoint, params, retryOnAuth=false)`. Retry once only.

```js
// pseudo
let sid=null, sidExp=0, inflight=null, loginCool=0, lastReset=0;
async function getSession(){
  if (sid && Date.now()<sidExp) return sid;
  if (inflight) return inflight;
  if (Date.now()<loginCool) throw new Error('iCount login backoff');
  need(env.ICOUNT_COMPANY_ID, env.ICOUNT_USER, env.ICOUNT_PASS);
  inflight = (async()=>{
    const r = await fetch(BASE+'/auth/login',{method:'POST',signal:AbortSignal.timeout(20000),
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({cid,user,pass})});
    const d = await r.json();
    if(!d.status||!d.sid){ loginCool=Date.now()+10000; throw new Error('iCount login failed: '+(d.reason||'unknown')); }
    sid=d.sid; sidExp=Date.now()+25*60*1000; return sid;
  })();
  try { return await inflight } finally { inflight=null }
}
```

## 2. Throttle handling (ICNT:76-124, 126-133; LEDGER:46-88, 90-101)

iCount throttles by answering with PLAIN TEXT ("Too many requests", 429 or HTML), not JSON. Real incident (ICNT:97-101): `Unexpected token 'T', "Too may re"... is not valid JSON` mid-pull of 745 suppliers.

- `parseIcountResponse` (ICNT:107-124): read `res.text()`, then `JSON.parse`. On parse failure:
  - throttled if `res.status === 429 || /too many requests|rate limit|slow down|429/i.test(text)` (ICNT:92, 112). Then set `throttledUntil = now + 90_000` (`THROTTLE_COOLDOWN_MS`, ICNT:85) and throw a throttle error.
  - otherwise throw `non-JSON response from <endpoint> (status N): <first 160 chars, whitespace collapsed>` (ICNT:121-122). A 502 page is a different problem from a throttle.
- Fail-fast gate (ICNT:130-133): at the top of EVERY `icountPost`, if `now < throttledUntil` throw immediately with seconds left. This is global, so one refusal closes the door for the whole app for 90s. Reason: retrying through a throttle makes a short one long and breaks every other iCount feature.
- Escape hatch: `clearIcountThrottle()` (ICNT:88), a test seam and manual reset.
- Pull pacing (LEDGER):
  - `ICOUNT_SUPPLIER_CONCURRENCY` default 4 (min 1), read at CALL time not module load (LEDGER:71). Six was too many.
  - `ICOUNT_SUPPLIER_GAP_MS` default 50 (min 0), a per-worker sleep after each supplier, skipped after the last (LEDGER:88, 257-258). Raise it on the host if refused again, with no deploy.
  - `MAX_SUPPLIERS_PER_PULL = 5000` (LEDGER:46). It was 400 and silently truncated, so about a third of the books were reported "missing from iCount". The cap is REPORTED, not silent.
  - Workers pull the next index from a shared counter (`for (i=next++; i<n; i=next++)`), not fixed slices (LEDGER:255).
- How a partial pull is reported (`PullSummary`, LEDGER:90-101): `{ok, date_from, suppliers_total, suppliers_read, rows_seen, matched, complete, failures:[{supplier, reason}], error?}`.
  - `failures` are NAMED per supplier (reason cut to 120 chars), because "3 failed" is not actionable.
  - A supplier whose paging was incomplete is pushed to `failures` with reason "not all documents read" and is not counted as read (LEDGER:214-217).
  - `complete = !capped && failures.length===0 && suppliers_read===toRead.length` (LEDGER:274).
  - Each pull is recorded in `icount_expense_pulls` (started_at, finished_at, date_from, suppliers_total, suppliers_read, rows_seen, complete, error). The screen shows "stale" if the last pull is missing or not complete (ROUTES-DOC:72).
- The pull runs on a press only, never on a schedule (LEDGER:139-145): dozens of calls against live accounting.

## 3. `icountPost` shape (ICNT:60-74, 126-159)

- It is NOT JSON. `POST {BASE}{endpoint}`, `Content-Type: application/x-www-form-urlencoded`, 30s timeout (ICNT:139-145).
- The body is a `URLSearchParams` with `sid=<sid>` first, then each param. Nested values are flattened with bracket keys (`appendParams`, ICNT:65-74):
  - arrays: `key[0]`, `key[1]`...
  - objects: `key[sub]`
  - scalars: `String(v)`
  - `undefined`/`null` are skipped.
  - Example: `scan: {file, name, type}` becomes `scan[file]=...&scan[name]=...&scan[type]=...`.
- Return the parsed JSON as is. Callers test `resp.status` (boolean). It is `status:false` with `reason` (or `error_description`/`error`) on failure.
- `icountPost` does NOT throw on `status:false` (except the auth retry above). Every caller checks `data?.status` and builds its own error: `String(data?.reason ?? data?.error_description ?? ...)` (FILE:407-409, 710, 748).

```js
function append(sp,k,v){ if(v==null)return;
  if(Array.isArray(v)) v.forEach((x,i)=>append(sp,`${k}[${i}]`,x));
  else if(typeof v==='object') for(const [kk,vv] of Object.entries(v)) append(sp,`${k}[${kk}]`,vv);
  else sp.append(k,String(v)); }
async function icountPost(ep, params, retryOnAuth=true){
  if (Date.now()<throttledUntil) throw new Error('iCount throttled, retry in Ns');
  const body=new URLSearchParams(); body.append('sid', await getSession());
  for (const [k,v] of Object.entries(params)) append(body,k,v);
  const res=await fetch(BASE+ep,{method:'POST',signal:AbortSignal.timeout(30000),
     headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  const data=await parseIcountResponse(res,ep);
  if(retryOnAuth && data?.status===false && AUTH_RE.test(JSON.stringify(data.reason??data.error_description??data.error??'')) && Date.now()-lastReset>20000){
    lastReset=Date.now(); sid=null; sidExp=0; return icountPost(ep,params,false); }
  return data; }
```

## 4. Suppliers (FILE:44, 462-526)

- Endpoint: `/supplier/get_list` (default; env override `ICOUNT_SUPPLIER_LIST_METHOD`, FILE:44). BRIEF:35-ish says this one was observed answering. The account had 574 suppliers on 10.08 and 745 by 30.09.
- Read via the same `fetchPaged` as expenses (section 5), so it pages 500 at a time, is cached 5 min and carries a `complete` flag.
- Row fields used: `supplier_id`, `vat_id` (fallbacks `supplier_vat_id`, `tax_id`), `supplier_name` (fallback `company_name`).
- Built maps (`supplierTaxIds`, FILE:462-503):
  - `byId: supplier_id -> digits(vat)`
  - `idByVat: digits(vat) -> supplier_id`. FIRST wins on a duplicate ח.פ, so the result is stable.
  - `nameById: supplier_id -> name`
  - `idByName: supplierKey(name) -> supplier_id`. A normalised name shared by two DIFFERENT supplier ids is AMBIGUOUS and removed from the map, so the name never picks between them. A supplier WITH a vat is still added to the name index (the old "skip" caused duplicate supplier creation).
  - `complete` comes from the paging.
- `digits(v) = String(v??'').replace(/\D/g,'')` (FILE:136).
- `supplierKey(name)` (FILE:165-174): lowercase; strip `" ' ’ ״ ׳ ,`; `-_.` -> space; remove the tokens `בעמ|ltd|inc|llc|pbc|corp|gmbh|plc|bv|ag` using `(^|\s)(...)(?=\s|$)`; collapse whitespace; trim.
  - NEVER use `\b` with Hebrew in JS regex (Hebrew letters are not `\w`; BRIEF:section 6).
- `trustedTaxId(v)` (FILE:205-209): `digits(v)`; valid only if length <= 9 and `isValidIsraeliId(d.padStart(9,'0'))` passes (Luhn-style ID check from `shared/types`). A failing number is IGNORED, not believed (incident 30.09: 510298946 misread as 516298946 made a supplier look different). The name then decides.
- `resolveSupplierId(suppliers, rawVat, vendorName)` (FILE:513-526):
  1. `vat = trustedTaxId(rawVat)`. If `vat` and `idByVat.get(vat)` exists, return it.
  2. `byName = idByName.get(supplierKey(vendorName))`. If none, return undefined.
  3. `cardVat = byId.get(byName)`. Return `byName` only if `!cardVat || !vat` (the iCount card has no ח.פ, or we have none). A card carrying a DIFFERENT number is a different company.
- When missing: filing is BLOCKED, never auto-created. Messages (FILE:329-331, 669-671):
  - with vat: `supplier "X" (ח.פ N) does not exist in iCount - add it there before filing`
  - without vat: `supplier "X" not found by name and has no ח.פ - add it there or make sure the name is identical`
  - iCount `/expense/create` takes ONLY `supplier_id` (no ח.פ, no name; BRIEF:section 2).
  - Supplier list incomplete -> blocker `supplier list not fully read` (FILE:326, 663).
  - Note: a product-side supplier-create exists (ICNT:4321+ `/supplier/add`) but it is not part of expense filing.

## 5. Ledger mirror (FILE:353-448; LEDGER:146-280)

### /expense/search read (fetchPaged, FILE:365-425)
- Method from env `ICOUNT_EXPENSE_SEARCH_METHOD` (set `/expense/search`; BRIEF:78). Empty = reads OFF (`expenseSearchConfigured()` false; the pull returns an error string).
- Params sent per call: `supplier_id=<id>`, `limit=500` (`PAGE_SIZE`), `offset=page*500`. (iCount also supports `start_date`, `end_date`, `expense_date` filters per BRIEF:section 2, but tofy deliberately does NOT use dates: FILE:438-441, 564-569. A doc entered under a date years off is exactly the duplicate worth catching. The date window is applied client-side in the pull: `if (mapped.doc_date < dateFrom) continue`, LEDGER:232.)
- Response: `{status, total_count, results_count, results_list:[...]}`.
  - `!data.status` -> throw `reason ?? error_description`.
  - `total` is taken from the first page's `total_count`.
  - `rowsOf(data)` uses `results_list`. Fallback: the first array/object-of-objects key other than `status`/`sid`.
  - Loop stop conditions: empty batch; `rows.length >= total`; short page (`batch.length < 500`).
  - `MAX_PAGES = 40` (20,000 rows for one supplier means something is wrong). If page 39 is reached and still going, `exhausted=false`.
  - `complete = exhausted && (total===null || rows.length >= total)`.
- Cache: in-memory `Map` keyed `method|JSON(params)`, TTL 5 min (`CACHE_MS`). `forgetIcountLedger()` clears it (the pull and `?fresh=1` call it).

### Pull loop (LEDGER:146-280)
```
pull(dateFrom):
  if !SEARCH_METHOD -> error
  insert icount_expense_pulls(date_from) -> pullId
  forget cache
  suppliers = supplierTaxIds(); if throws or !complete -> finish with error (partial pull would look like missing docs)
  supplierIds = union(nameById.keys, byId.keys)
  toRead = first 5000 (capped flag if more)
  ours = expense_invoices where status!='void' and doc_date>=dateFrom
  run 4 workers (gap 50ms): for each supplierId:
     fetched = readIcountExpensesForSupplier(id)   // {supplier_id: id}
     if !fetched.complete -> failures.push(named); continue
     suppliers_read++
     for raw of rows: mapped = mapIcountExpenseRow(raw)
        skip if !mapped.docnum or mapped.doc_date < dateFrom
        taxId = mapped.supplier_tax_id ?? suppliers.byId.get(supplierId)
        name  = suppliers.nameById.get(supplierId)
        hit   = matchAgainstOurs({...mapped, supplier_tax_id:taxId, supplier_name:name}, ours)
        UPSERT icount_expenses by icount_id=String(mapped.docnum)
        seen.add(icount_id); rows_seen++; if hit matched++
  // gone marking, ONLY if every supplier was read and seen is non-empty:
  UPDATE icount_expenses SET gone_at=now WHERE gone_at IS NULL AND doc_date>=dateFrom AND icount_id NOT IN seen
  complete = !capped && no failures && all read
```

### Row mapping (`mapIcountExpenseRow`, FILE:277-291) - field names observed on this account
- `docnum` (our `icount_id`) = first non-empty of `expense_id`, `docnum`, `id`. NOTE: this is iCount's running counter and is the ID used later for `/expense/update`.
- `doc_number` (the supplier's printed number) = `expense_docnum` | `invoice_number` | `supplier_docnum` | `doc_number` | `docnum`. Punctuation, spaces and leading zeros are preserved ("0052 /1").
- `amount_total` = `nis_sum` | `expense_sum` | `total` | `amount` | `sum` (use `nis_sum`, the shekel total). Cast `Number(...)||0`.
- `doc_date` = `expense_date` | `invoice_date` | `doc_date` | `date`, first 10 chars, must match `^\d{4}-\d{2}-\d{2}$`, else `1970-01-01`.
- `supplier_tax_id` = `supplier_vat_id` | `vat_id` | `supplier_tax_id` | `tax_id`. An expense row carries NO ח.פ on this account; it is joined from the supplier via `supplier_id`.
- `supplier_id` = `supplier_id`.
- Cancelled docs: `isCancelled(row) = flag(row.is_storno) || flag(row.is_stornoed)` (FILE:351). `flag(v)` is false for `''|'0'|'false'|'null'|'no'|'undefined'` (case-insensitive, trimmed), true otherwise. iCount mixes `"false"`, `"0"` and `""`, which are all truthy JS strings.

### `icount_expenses` fields stored (migration 241) - EXACT list
`id` (autoinc), `icount_id` (TEXT UNIQUE, = expense_id), `supplier_id`, `supplier_name`, `supplier_tax_id`, `doc_number`, `doc_date` (NOT NULL), `amount_total` (REAL NOT NULL), `matched_expense_id` (FK expense_invoices, SET NULL), `match_kind` (`'same_document'|'probable'`), `match_why`, `first_seen_at`, `last_seen_at`, `gone_at`. Indexes: `doc_date`; `matched_expense_id`; `(supplier_tax_id, doc_number)`.
On upsert conflict: overwrite supplier_id, supplier_name, supplier_tax_id, doc_number, doc_date, amount_total, matched_expense_id, match_kind, match_why; set `last_seen_at=now, gone_at=NULL` (a returning doc un-gones).
Note: the pull does not store `is_storno` rows specially. Cancelled docs are only excluded in the filing check, not from the mirror (worth fixing in a port: skip or flag cancelled rows in the mirror).

### gone_at semantics
- Never DELETE. A doc that vanished from iCount is marked `gone_at=now` (PLAN:262).
- Marked only after a COMPLETE read of all suppliers (LEDGER:266). Only rows with `doc_date >= dateFrom` are marked.
- Reads: gone rows are dropped from the working list UNLESS a bank charge is linked to them (DOCS:124-138):
  `WHERE doc_date BETWEEN ? AND ? AND (gone_at IS NULL OR EXISTS(SELECT 1 FROM icount_expense_payments p WHERE p.icount_expense_id = icount_expenses.id))`.
  Dropping a linked one would silently return its charge to "unexplained" and reopen an answered question. The kept row carries `gone_from_icount: true` (DOCS:60).
- The reconcile report counts only `gone_at IS NULL` (LEDGER:320, 330, 338, 383).

### Reconcile report (`reconcileIcountLedger`, LEDGER:312-386)
- `in_both` = count of `gone_at IS NULL AND doc_date>=from AND match_kind='same_document'`.
- `only_here` = our non-void, non-filed docs in window with no non-gone iCount row `matched_expense_id = e.id`. Each carries `blockers_count = fileBlockers(r).length`.
- `only_in_icount` = non-gone rows with `matched_expense_id IS NULL`. Each gets up to 5 `bank_candidates`: unmatched outgoing bank txns where `amount<0`, not an internal transfer, `matched_expense_id IS NULL`, `ABS(ABS(t.amount) - doc.amount) < 0.5`, `t.date BETWEEN doc_date-10d AND doc_date+45d`. Loose on date (card charges post weeks later), exact on amount.
- `probable` = non-gone rows with `match_kind='probable'`.

## 6. Identity join - ours vs iCount (FILE:141-251; DOCS:96-300)

### compareToIcount(ours, theirs) -> `same_document | probable | different` (FILE:211-251)
Identity shape: `{supplier_tax_id, supplier_name, doc_number, amount_total, doc_date}`.
1. `ourTax = trustedTaxId(ours.tax)`, `theirTax = trustedTaxId(theirs.tax)`. `sameByTax = ourTax && ourTax===theirTax`.
2. `ourName/theirName = supplierKey(...)`. `sameByName = !(ourTax && theirTax) && ourName && ourName===theirName`.
   - So the name is consulted only if at least one side lacks a trusted ח.פ (overseas supplier, or an iCount card opened without one). Two DIFFERENT trusted numbers disqualify, and then the name is never consulted.
3. `sameSupplier = sameByTax || sameByName`.
4. `docKey(v) = String(v??'').replace(/[^0-9a-zA-Z]/g,'').replace(/^0+/,'').toLowerCase()`. If `sameSupplier && ourDoc && ourDoc===theirDoc` -> `same_document`. This is the ONLY certainty: supplier plus the supplier's own printed number.
5. If `!sameSupplier` -> `different` (a bare doc number can collide across suppliers).
6. Else `closeAmount = |ours.amount - theirs.amount| < 0.5` and `days = |date diff| (UTC midnight)`. If `closeAmount && days <= 3` -> `probable`. Otherwise `different`.
   - Amount+date are NEVER promoted to certainty: a monthly retainer is the same supplier and amount every month.

### Where it is used
- Pull: `matchAgainstOurs` loops our ledger. First `same_document` wins and returns; the first `probable` is held in case no certain one is found (LEDGER:125-136). Result goes into `matched_expense_id/match_kind/match_why`.
- Unified list (DOCS:174-243), recomputed on every read, never stored. For each iCount row (`theirList`), `partnerFor`:
  - skip ours already in `taken` (stops one of our docs being claimed by two iCount rows);
  - decision `'different'` -> skip;
  - `same_document` verdict -> return that doc;
  - else return the first doc a person confirmed `'same'` (merges even if only "probable").
  - Output row: `key = ours:<id>` if merged else `icount:<id>`; `source = 'both'|'icount'`; `vendor_name = iCount supplier_name || ours`; `doc_date = ours.doc_date || iCount`; `amount_total = ours ?? theirs`.
  - Our rows not `taken` are appended with `source:'ours'`.
  - Second pass: an iCount-only row whose still-unmerged probable twin has NO stored decision gets `probable_partner = {expense_id, ..., why}`, a QUESTION for a human. Only the first probable twin is shown (`break`).
- Decisions table `expense_identity_decisions(expense_id, icount_expense_id, verdict 'same'|'different', decided_by, decided_at, UNIQUE(expense_id, icount_expense_id))` (migration 308; LINKS:146-162). It is upserted, so a person may change their mind. It is only needed for pairs the comparison called probable; certain matches re-derive identically and are never stored.
- Lanes (`documentsWithState`, DOCS:493-540): shown at section 9. A doc "from iCount" (hand-typed by the bookkeeper) has `source:'icount'`, `doc_type` defaults to `'tax_invoice'`, `amount_ils = amount_total` (iCount is already in shekels), and is NEVER receipt-like (`isReceiptLike` returns false when `source==='icount'`, DOCS:408). That is why they appear in `pair`/`closed` lanes like any other and carry the "in_icount" standing in the closed lane (CLOSED:90-94).
- "from iCount" in the UI is the Hebrew label "מאייקאונט" for `source in {icount, both}`.

### Duplicate filing prevention (pre-create search)
`checkIcountForExpense(ours)` (FILE:537-610) is ALWAYS called by the file route before create; it is not skippable by the caller:
1. `SEARCH_METHOD` empty -> `{configured:false}`.
2. `supplierTaxIds()`; incomplete -> error (cannot assert absence).
3. `supplierId = resolveSupplierId(suppliers, digits(ours.tax), ours.vendor_name)`. None -> `different` (a supplier iCount does not know cannot hold a duplicate).
4. `fetchPaged(SEARCH, {supplier_id})`, ALL rows for that supplier, no date filter. Incomplete -> error "iCount reported N docs for this supplier and we could not read them all - filing stopped".
5. For each row: skip `isCancelled`; map; fill `supplier_tax_id` from `suppliers.byId` and `supplier_name` from `nameById`; `compareToIcount`. `same_document` returns immediately with `existing_docnum = expense_id`; the first `probable` is remembered; otherwise `different`.
- Route handling (ROUTES-INV:584-599):
  - `error` -> 502 `ICOUNT_READ_FAILED`;
  - `same_document` -> `markAlreadyFiled(id, existing_docnum, why)` (UPDATE `status='filed'`, `icount_docnum`, `icount_filed_at=now`, appends `already exists in iCount: <why>` to notes) and return `{filed:false, already:true}`. NOTHING created;
  - `probable` and body lacks `confirm_duplicate === true` -> 409 `PROBABLE_DUPLICATE`.
- Known gap (BRIEF 5.2): the check only searches inside the RESOLVED supplier. A doc typed under a duplicate supplier card in iCount is not caught.

## 7. Filing (FILE:22-123, 303-348, 630-714; ROUTES-INV:517-632)

### Env / config (FILE:29-61, 106)
- `ICOUNT_EXPENSE_SEARCH_METHOD=/expense/search`, `ICOUNT_EXPENSE_CREATE_METHOD=/expense/create`, `ICOUNT_EXPENSE_TYPE_ID=2`, `ICOUNT_EXPENSE_TYPE_ID_VEHICLE=8`, optional `ICOUNT_EXPENSE_UPDATE_METHOD` (default `/expense/update`), optional `ICOUNT_SUPPLIER_LIST_METHOD` (default `/supplier/get_list`), optional `ICOUNT_SCAN_ENCODING`.
- Methods have NO default on purpose (a guessed write path could create a real document in live books). `filingConfigured() = SEARCH && CREATE && EXPENSE_TYPE_ID`.
- `filingStatus()` returns booleans only, never values (a diagnostic that prints values gets pasted into chats). Route `GET /icount-filing-status` also tries the supplier read to prove credentials work.

### expense_type_id (`expenseTypeIdFor`, FILE:71-84)
Priority: explicit `expense_type_id` (manual, from the request body) > `vat_treatment==='partial_66'` -> `ICOUNT_EXPENSE_TYPE_ID_VEHICLE` (blocked if unset, never falls back to general) > `ICOUNT_EXPENSE_TYPE_ID` (blocked if unset).
iCount per-account categories seen: 2 self-invoice (179 docs), 5 receipt (12), 8 vehicle 3.5t (5), 15 automatic expense (2), 10 insurance (1), 12 import (1) (BRIEF section 2). Reason for vehicle: an Israeli vehicle expense is 66% deductible.

### doctype mapping (`DOCTYPE_BY_KIND`, FILE:98-104)
| our `doc_type` | iCount `expense_doctype` |
|---|---|
| tax_invoice | invoice |
| invoice_receipt | invrec |
| receipt | receipt |
| credit_note | refund |
| other | other |

iCount's full doctype list (BRIEF section 2): invoice, invrec, receipt, order, delcert, refund, import, paycheck, other. An unmapped `doc_type` -> blocker `unknown doc type`.

### /expense/create exact params (`createIcountExpense`, FILE:690-705)
Sent through `icountPost(CREATE_METHOD, {...})`, form-urlencoded:
```
supplier_id        resolved id (string)
expense_type_id    section above
expense_doctype    mapped
expense_docnum     input.doc_number (supplier's printed number; required)
expense_sum        input.amount_total  (SHEKELS, numeric, as BANK charged; see section 11)
expense_date       input.doc_date  (YYYY-MM-DD)   <- the ONLY date field sent
currency_code      'ILS'  (always)
adv_expense        'true'                     \  only when vat_amount > 0
expense_manual_vat input.vat_amount           /
...scan params                                 only if a scan is attached and encoding known
```
- iCount required (BRIEF section 2): `supplier_id`, `expense_type_id`, `expense_doctype`, `expense_docnum`, `expense_sum`. Optional: `expense_date`, `currency_id`/`currency_code`, `adv_expense`, `expense_manual_vat`, `manual_no_vat`.
- VAT rule: manual VAT only when `vat_amount > 0`. A zero is ambiguous (exempt vs unreadable). `manual_no_vat` would turn "could not read" into a false declaration. Left off, iCount applies its own rate, wrong in a visible way instead of a silent one.
- `description` is accepted by the function but NOT sent. No `payments`, no due date, no separate `invoice_date`.
- Response: ok = `!!resp.status`. `docnum = String(resp.docnum ?? resp.expense_id ?? resp.id ?? '') || null`. Failure reason = `resp.reason ?? error_description ?? error ?? 'unknown iCount error'`, surfaced VERBATIM so a wrong field or path is visible at once.
- Local refusals before any network write (FILE:639-652): create method unset; type id unresolved; unknown doctype; no `doc_number`; amount not > 0; supplier unresolved/incomplete list.

### fileBlockers (EXP:78-135) - every reason a doc cannot be filed
Returned as an array, not thrown; the ledger holds incomplete captures and shows what is missing. Messages are Hebrew in tofy; English paraphrase:
1. Currency not ILS and `fx_confirmed` false -> "invoice in <CUR> (<orig>) - enter the shekel amount as charged by the bank". FIRST, since every other number is in wrong units until answered.
2. No `supplier_tax_id` AND currency is ILS -> "missing ח.פ / osek number - an invoice without it is disallowed on audit". NOT asked of foreign-currency docs (an overseas supplier has none).
3. No `doc_number` -> "missing document number".
4. `!(amount_total > 0)` -> "invalid amount".
5. `doc_type==='receipt'` and ILS: no `receipt_disposition` -> "receipt - decide: has an invoice, or supplier is osek patur / nonprofit"; `has_invoice` -> "receipt of an invoice - the invoice itself is what is filed"; `not_relevant` -> "marked not relevant for filing". `no_invoice_issuer` clears only this blocker.
6. `doc_type==='tax_invoice'`, ILS, `vat_amount===0`, `vat_treatment==='full'` -> "tax invoice with no VAT - mark 'no VAT' if supplier is not a licensed dealer".
Route-level gates in `POST /:id/file-to-icount` (ROUTES-INV:553-577), in order:
- 404 `NOT_FOUND`; 409 `ALREADY_FILED` (`status==='filed'`);
- 409 `NOT_CLOSED` (see below);
- 400 `NEEDS_REVIEW` (`needs_review` true, a machine reading nobody confirmed);
- 400 `BLOCKED` (`row.blockers[0]`);
- 503 `NOT_CONFIGURED` (search, create or type id env missing).
Then supplier resolution + preview-style blockers inside `previewIcountFiling` (supplier missing, supplier list incomplete, create/search method unset, type unresolved, unknown doctype, no doc number, no amount).
Related helpers: `claimableVat` (EXP:65): receipt/other -> 0; `vat_treatment==='none'` -> 0; `partial_66` -> x0.66; rounded to 2 decimals. `vatOfTotal(total, pct)` = `round(total - total/(1+pct/100), 2)`.

### file-preview (dry run) (FILE:303-348; ROUTES-INV:517-542)
`GET /:id/file-preview[?expense_type_id=]`, read-only all the way down. Returns `{expense:{id,vendor_name,doc_type,doc_number}, ready, blockers[], would_send, why_type, already_in_icount (verdict or null), existing_docnum, read_error}`.
- `would_send` is the exact create payload minus scan: `{supplier_id, expense_type_id, expense_doctype, expense_docnum, expense_sum, expense_date, currency_code:'ILS', [adv_expense:'true', expense_manual_vat]}`; it is `null` if any blocker exists.
- Rule: verify configuration by looking at it here, never by filing a real document (BRIEF A/C: "no undo, only a credit note").

### NOT_CLOSED 409 gate (ROUTES-INV:558-567)
`isClosed(expenseId)` (CLOSED:137-147): reads `documentsWithState` over a window of doc_date +-120 days (wide enough to see an iCount twin dated differently) and checks `doc.lane==='closed'`. If not: 409 `{code:'NOT_CLOSED', message:"upload to iCount only from the 'closed' tab - link a bank charge or mark 'not paid yet'"}`. Enforced server-side for every caller (owner ruling 30.09.2026). Closed = `state==='settled'` (charges cover it, or paid-outside-bank / closed-anyway) OR `awaiting_payment` (marked "not paid yet - file anyway").

### After success (`markFiled`, EXP:563-570)
`UPDATE expense_invoices SET status='filed', icount_docnum=<docnum or null>, icount_filed_at=now, updated_at=now WHERE id=?`. Response `{filed:true, already:false, docnum, scan_skipped}`. Failure paths: create failed -> 502 `ICOUNT_CREATE_FAILED`; any thrown error -> 502 `ICOUNT_ERROR` (message cut to 200 chars). Reminder: after a created doc, a local failure leaves it filed in iCount but not marked here; the pre-create check on retry will find it by supplier+number and mark it filed.

### Scan attachment (SCAN:59-175; FILE:674-688; BRIEF section 2, 5.1)
- Off by default: `scanAttachSupported() = scanEncoding() !== 'unknown'`. Encoding source: env `ICOUNT_SCAN_ENCODING` (wins) else app setting `icount_scan_encoding`. Valid shapes: `base64`, `data_uri`, `base64_named`, `data_uri_named`, `object`, `object_data_uri`. Env empty and no stored value -> OFF. Filing proceeds without the scan and returns `scan_skipped: "<reason>"` (a filed expense without its scan is still filed).
- Payload (`scanParams`): `base64 -> {scan:b64}`; `data_uri -> {scan:'data:<type>;base64,<b64>'}`; `*_named -> + scan_filename`; `object -> {scan:{file:b64, name, type}}` (flattened to `scan[file]`, `scan[name]`, `scan[type]`); `object_data_uri -> file is a data URI`. Media types: pdf, png, jpg/jpeg, webp, heic. Max file 10 MB (`MAX_BYTES`).
- The scan goes in the SAME `/expense/create` call (no window where the expense exists without evidence).
- iCount facts (BRIEF section 2): a separate `/expense/scan` (multipart) CREATES an expense and returns `expense_id`, then `/expense/update`. tofy avoided it because a failed update leaves a half-filled doc in the books. All six simple shapes were "accepted and silently dropped" at first probe, hence the probe/confirm workflow (routes `icount-scan-report`, probe, confirm). Treat scan as UNPROVEN and keep it off in a port until verified against a real draft.
- Security: the scan path comes from `resolveAttachment(row.attachment_path)`, which returns an absolute path only inside the expense documents directory (stops a crafted path posting an arbitrary file off disk). Use `attachment_path`, not the legacy `file_path`.
- Attach to an EXISTING iCount doc: `attachScanToIcountExpense` posts `/expense/update` with ONLY `{expense_id, ...scanParams}` (FILE:731-749; route `POST /attach-scan` requires a merged doc, ROUTES-DOC:167-198).

### "Payments must never be sent"
Both `/expense/update` calls (attach scan, report paid) and `/expense/create` NEVER include `payments`. iCount docs say supplying `payments` on update REPLACES the bookkeeper's payment rows (FILE:723-729, 754-761). Never send amount/date "for completeness" on update either: it would overwrite her manual corrections. A test in tofy asserts the exact key set of the body. Replicate that test.

## 8. Report-paid (FILE:751-787; ROUTES-DOC:248-326)

Only for iCount-held docs (hand-typed or already filed). Body of `/expense/update` (`updateMethod()`, default `/expense/update`):
- paid: `{expense_id: <icount_id from icount_expenses>, expense_paid: 1, expense_paid_date: 'YYYY-MM-DD'}`.
- undo: `{expense_id, expense_paid: 0}` (no date).
- `expense_id` = the mirrored `icount_expenses.icount_id`. Missing -> `missing iCount expense id`.
- Paid date must match `^\d{4}-\d{2}-\d{2}$`, else refuse "payment date missing or invalid - it is the transaction date, not today". Date = the LATEST linked bank charge date (`payments.map(p=>p.date).sort().slice(-1)[0]`), never the press date.
`POST /report-paid {key}` (ROUTES-DOC:264-299):
1. find the doc via `documentsWithState` (404 `NOT_FOUND`).
2. `icount_expense_id == null` -> `{ok:true, skipped:'not_in_icount'}` (nothing to update; not an error).
3. Allowed only if `state==='settled' && !paid_outside_bank && !closed_anyway && payments.length>0` else 400 `NOT_SETTLED`. So only genuine bank coverage can say "paid"; paid-outside-bank has no bank date and a closed-anyway gap received less money (withholding).
4. Call iCount. Failure -> 502 `ICOUNT_FAILED`.
5. ONLY after iCount accepted: upsert `icount_paid_reports(icount_expense_id UNIQUE, paid_date, amount_at_report = doc.paid_total, reported_by, reported_at)`. A row written before the call would claim a statement possibly never made.
`POST /report-paid/undo {key}`: requires `icount_expense_id != null` and a recorded report (`icount_paid_reported_date`), else 400 `NOT_REPORTED`. Calls update with `expense_paid:0`, then DELETEs the `icount_paid_reports` row. A press of its own, never automatic: unlinking a charge locally leaves iCount saying paid, and the UI shows the disagreement via `icount_paid_reported_date` instead of auto-correcting.

## 9. Closed lane and iCount standing (CLOSED:90-128; DOCS:343-540)

### State (DOCS:518-523), in this order
```
state = amount_ils == null            -> 'awaiting_fx'
      : paid_outside_bank||closed_anyway -> 'settled'
      : payments.length == 0           -> 'needs_match'
      : paid_total >= amount_ils - 2   -> 'settled'      // COVERAGE_TOLERANCE_ILS = 2 (rounding only)
      : 'partial'
paid_total = round(sum(payments.amount), 2)
```
A merged doc collects payments and decisions from BOTH keys (`ours:<id>` and `icount:<id>`).
`awaiting_payment = marked "unpaid" (expense_unpaid_marks) && state !== 'settled'`.
`amount_ils`: ILS doc -> `amount_total`; foreign doc -> `amount_total` only if `fx_confirmed` else null; iCount-only -> its `amount_total`.

### Lane (DOCS:527-531)
`not_relevant` receipt -> `hidden`; `isReceiptLike` -> `receipts` (a receipt waiting for its invoice; never offered a charge, because pairing a receipt with the bank books the expense twice when the invoice arrives); `state==='settled' || awaiting_payment` -> `closed`; else `pair`.
`isReceiptLike`: not iCount-sourced, `doc_type==='receipt'`, disposition not `no_invoice_issuer`, and no exempt rule (`receipt_exempt_suppliers` by ח.פ then `vendorKey`) matches.

### iCount standing (`icountStanding`, CLOSED:90-94)
```
if d.status==='filed' || d.icount_filed_at  -> 'filed'        // we filed it (or "already existed" marked filed)
else if d.source==='icount' || 'both'       -> 'in_icount'    // bookkeeper typed it / exists in mirror
else                                         -> 'not_filed'    // waiting for the press
```
Closed row (`ClosedRow`) also carries `sub: 'settled'|'awaiting_payment'`, `receipts[]` (receipt docs with `linked_invoice_id`), full `payments[]`, `filed_docnum = d.icount_docnum`, and `outside_bank {paid_outside_bank, closed_anyway, note}`. The "to file" count is the closed rows with `icount==='not_filed'` (ROUTES-DOC:367).

### Links and decisions (LINKS)
- Doc key `ours:<id>|icount:<id>` (regex `^(ours|icount):(\d+)$`).
- `linkCharge`: bank tx must exist and have `amount < 0`; amount defaults to the CHARGE (abs), not the document (a 400 charge on a 1,000 invoice is a part payment); UNIQUE(doc, tx) -> `DUPLICATE`. A void doc cannot be linked.
- `unlinkCharge`: DELETE only that link (doc returns to needing a match; everything derived).
- `setDocDecision`: one row per `(side, ref_id)`: `paid_outside_bank`, `closed_anyway`, `note`. Upserted (two rows disagreeing would be a question with two answers).

## 10. Routes (summary)
`ROUTES-INV` (tabGuard 'expenses', requireAdmin), all under the expenses router:
- `GET /icount-filing-status`
- `GET /icount-suppliers[?fresh=1]` (searches iCount's supplier list by name; `fresh` clears the cache)
- `POST /icount-ledger/pull {date_from?}` (defaults to a year back, `defaultLedgerFrom`)
- `GET /icount-ledger?from=` (mirror only, no network)
- `GET /:id/file-preview`
- `POST /:id/file-to-icount {confirm_duplicate?, expense_type_id?}`
- probes: `/icount-scan-report`, scan probe/confirm, `/icount-expense-probe` (read-only discovery of the expense API)
`ROUTES-DOC`: `POST /attach-scan`, `/identity`, `/report-paid`, `/report-paid/undo`, link/unlink/decision/unpaid-mark routes.

## 11. Known open issues (BRIEF sections 4-5)
1. Category 2 vs 15: owner said 2 (self-invoice), but the bookkeeper's existing manual record for Anthropic is category 15 (automatic expense) and doc type "tax invoice" even though the PDF is a Receipt. Needs a ruling from her before filing more foreign subscriptions.
2. FX: iCount stores foreign currency natively (a hand record holds USD 200 with rate 3.058). tofy sends shekels only with `currency_code:'ILS'` and loses the face value. Support did not name a rate field for `create`. The amount that enters the books is what the BANK charged, never a computed rate (a card company rate has a spread and the charge lands days later; example NIS 618 bank vs 611.60 by rate). The rate only pre-fills a field. `fx_rate` is not persisted on manual conversion in the UI.
3. Duplicate check scope: only within the resolved supplier (a doc under a duplicate supplier card is missed; 574-745 suppliers makes it realistic).
4. Manual `expense_type_id` is accepted by the API but has no picker (insurance 10, import 12 land under the default).
5. Cancelled (storno) docs: excluded from the duplicate check but still mirrored (see section 5 note).
6. Create is irreversible except by a credit note; partial failure (created in iCount, local mark fails) is healed by the pre-create check on retry.

## 12. Mongo mapping suggestions
Collections: `icount_expenses` (unique index on `icount_id`; index `(supplier_tax_id, doc_number)`, `doc_date`), `icount_expense_pulls`, `icount_expense_payments` (unique `(icount_expense_id, transaction_id)`), `icount_paid_reports` (unique `icount_expense_id`), `expense_identity_decisions` (unique `(expense_id, icount_expense_id)`), `expense_doc_decisions` (unique `(side, ref_id)`), `expense_unpaid_marks`. Replace SQL joins in `unifiedDocuments`/`documentsWithState` by loading the windowed lists plus the small side tables into maps (tofy does exactly this in memory). Keep the gone-with-payment rule as `$or: [{gone_at: null}, {_id: {$in: idsWithPayments}}]`.
Replace in-process module state (session, throttle, cache) with a single instance cache or a shared store if the service runs on more than one dyno. The 90s throttle and the 20s forced-relogin guard must be shared across processes or the app can storm iCount from two instances.

## 13. Checklist for the port (minimum viable, safest order)
1. `icountPost` + session + throttle (sections 1-3), with tests for plain-text throttle and auth retry.
2. Supplier list + resolve (section 4). Preview endpoint (section 7) before ANY create.
3. Read-only mirror pull + reconcile report (section 5).
4. Filing behind: closed-lane gate, `fileBlockers`, pre-create check, `confirm_duplicate`.
5. Report-paid + undo (section 8) last.
6. Leave scan attach OFF.
