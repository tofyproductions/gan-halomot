# Expenses — Documents & Pairing (Finance Part 2א) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gan expense documents (from mail-sorter and manual entry) are paired with the bank/card charges from Part 1 on a 5-tab "הוצאות" screen, with receipts, no-invoice rules, branch tagging and order linking — tofy's engine, gan's look.

**Architecture:** Mongoose models + pure services ported from tofy (algorithms in the port notes, cited by section) + REST routes behind `expenses` / `expenses_write` + one React screen. Everything derived on read; only decisions are stored. No iCount in this part.

**Tech Stack:** Node/Express, Mongoose, React 18 + MUI, mongodb-memory-server tests.

**Spec:** `docs/superpowers/specs/2026-10-01-expenses-documents-design.md`
**Algorithm reference (binding for formulas):** `docs/superpowers/specs/2026-10-01-expenses-port-notes.md`

## Global Constraints

- Amounts: `amount_total` includes VAT; there is NO VAT split anywhere (gan is a VAT-exempt non-profit).
- Charges: `BankTransaction.amount < 0` = money out; pool excludes `is_internal_transfer`, fully covered, and NoInvoiceRule-matched charges.
- Scoring/pairing constants exactly as port notes §1–§2 (`SUGGEST_THRESHOLD = 55`, gap window −3..90 days, exact = |diff| ≤ 1 ₪, approx ≤ 5%, alternatives limit 5). Withholding-tax factor: OFF.
- Coverage tolerance: 2 ₪ (port notes §4.1).
- Receipts: overdue at 14 days; NO automatic receipt→invoice linking; NO GET endpoint writes.
- Order link: same supplier; statuses `sent|pending_receive|receiving|received|received_partial`; window −30..+60 days around order received_at (else created_at); mismatch warning when |diff| > 2 ₪.
- Tabs: `expenses` defaultRoles `['system_admin','admin_viewer','accountant']`; write grant `expenses_write` (`path:null`, `writeGrantFor:'expenses'`) defaultRoles `['system_admin','accountant']` — in BOTH client `config/tabs.js` and server `constants/tabs.js`.
- Files: manual uploads ≤ 10 MB in `ExpenseFile` (base64); mail-sorter files fetched on demand via `mailSorter.service.fetchFile`, never stored.
- UI: colours only from theme (hex ratchet stays 602); `apiError`; load failure ≠ empty; ₪ after number; Hebrew copy; phone = cards.
- Tests: `server/scripts/*.test.js`, hand-rolled ok/eq, dotenv stubbed BEFORE any require, mongodb-memory-server, loopback only. NEVER load `server/.env` (production).
- Never push to main (controller deploys).

---

## File Structure

Server (`server/src`):
- `models/ExpenseDocument.js`, `ExpenseFile.js`, `ExpensePayment.js`, `ExpensePairRejection.js`, `ExpenseUnpaidMark.js`, `ExpenseDocDecision.js`, `NoInvoiceRule.js`; modify `Supplier.js`, `models/index.js`.
- `services/expenseCore.service.js` — vendorKey, duplicate check, supplier match, charge pool, document state/lane (coverage).
- `services/expensePairs.service.js` — scorePair, compareFields, pairQueue, alternatives.
- `services/expenseWrites.service.js` — accept/reject/unpair/unpaid/decisions/confirm.
- `services/expenseReceipts.service.js` — lane, candidates, link, exempt supplier, move payments.
- `services/expenseOrders.service.js` — order candidates, link, mismatch.
- `services/expenseIntake.service.js` — manual create/update, mail-sorter pull.
- `services/expenseSearch.service.js` — search + counts.
- `services/noInvoiceRules.service.js` — seed + match.
- `controllers/expenses.controller.js`, `routes/expenses.routes.js`; modify `routes/index.js`, `constants/tabs.js`, `index.js` (pull job).

Client (`client/src`):
- `components/expenses/ExpensesPage.jsx` (shell), `PairTab.jsx`, `ReceiptsTab.jsx`, `ClosedTab.jsx`, `SearchTab.jsx`, `ToolsTab.jsx`, `DocumentDialog.jsx`, `expenseFormat.js`; modify `config/tabs.js`, `App.jsx`.

---

### Task 1: Models, supplier fields, tabs

**Files:** create the 7 models; modify `Supplier.js`, `models/index.js`, `server/src/constants/tabs.js`, `client/src/config/tabs.js`. Test: `server/scripts/expense-models.test.js`.

**Interfaces — Produces:**
- `ExpenseDocument`: fields exactly as spec §1 table: `source` enum `mail_sorter|manual`; `mail_sorter_id` Number (unique sparse); `file_id` ObjectId→ExpenseFile; `attachment_sha256`; `supplier_id`; `vendor_name`; `supplier_tax_id`; `doc_type` enum `tax_invoice|invoice_receipt|receipt|credit_note|other`; `doc_number`; `doc_date` String YYYY-MM-DD; `amount_total` Number; `currency` default 'ILS'; `amount_original`; `fx_confirmed` Boolean default true for ILS; `branch_id`; `is_general` Boolean; `order_id`; `needs_review` Boolean; `linked_invoice_id`; `receipt_disposition` enum `has_invoice|is_document|null`; `receipt_disposition_at`; `status` enum `active|void`; `created_by`, `confirmed_by`, `confirmed_at`; timestamps `created_at/updated_at`. Indexes: `{status:1, doc_date:-1}`, `{supplier_id:1}`, `{attachment_sha256:1}`.
- `ExpenseFile`: `{ data: String (base64), name, mime, size }`.
- `ExpensePayment`: `{ document_id, transaction_id, amount, created_by }`, unique `{document_id, transaction_id}`.
- `ExpensePairRejection`: `{ document_id, transaction_id }` unique.
- `ExpenseUnpaidMark`: `{ document_id (unique), created_by }`.
- `ExpenseDocDecision`: `{ document_id (unique), kind enum 'closed_anyway'|'paid_outside_bank', note, created_by }`.
- `NoInvoiceRule`: `{ label, pattern, built_in Boolean, is_active Boolean default true }`.
- `Supplier` gains `tax_id: { type: String, default: '' }`, `receipt_is_document: { type: Boolean, default: false }`.
- Tabs `expenses` and `expenses_write` per Global Constraints (copy the `bank` / `bank_write` entries' shape and position next to them).

- [ ] Step 1: Write `expense-models.test.js` (dotenv stub + memory Mongo): each model creates a doc with defaults; `ExpensePayment` duplicate `(document_id, transaction_id)` throws E11000; `ExpenseDocument` two docs without `mail_sorter_id` coexist (sparse unique) but two with the same `mail_sorter_id` throw; `Supplier` defaults `tax_id:''`, `receipt_is_document:false`. Run → fails (missing models).
- [ ] Step 2: Implement models + register in `models/index.js` (after `FinanceSyncRequest`), add Supplier fields, add tabs in both files.
- [ ] Step 3: Run test → pass; run `node scripts/tabs-constant-sync.test.js` → no NEW mismatch (5 pre-existing remain).
- [ ] Step 4: `"test:expense-models"` script; commit `feat(expenses): document, payment and decision models; supplier tax id; expenses tabs`.

---

### Task 2: Core — charge pool, document state, duplicates, supplier match, no-invoice rules

**Files:** create `services/expenseCore.service.js`, `services/noInvoiceRules.service.js`. Test: `server/scripts/expense-core.test.js`.

**Interfaces — Produces:**
- `noInvoiceRules.seed(): Promise<void>` — idempotent upsert of the built-in rows from port notes §6.2 (labels in Hebrew, `built_in: true`).
- `noInvoiceRules.matchRule(description, rules): rule|null` — case-insensitive "contains" per §6.1.
- `vendorKey(name): string` — port §9 normalisation.
- `findDuplicate({ mail_sorter_id, attachment_sha256, supplier_id, vendor_name, doc_number }, excludeId?): Promise<ExpenseDocument|null>`.
- `matchSupplier({ supplier_tax_id, vendor_name }): Promise<Supplier|null>` — tax id (digits only) first, then `vendorKey` equality on name.
- `chargePool(): Promise<{ open: Tx[], exempt: Array<{tx, rule}> }>` — `amount<0`, not internal, remaining > 0 after `ExpensePayment`s; rule-matched go to `exempt` (returned, not dropped — port §6.3). Each Tx carries `remaining` (positive shekels) and `account_label`.
- `documentsWithState(): Promise<DocState[]>` — active docs with `paid` (sum payments), `remaining`, `state` and `lane` per port §4.2 adapted: lanes `review` (needs_review), `awaiting_fx`, `receipt` (doc_type receipt whose supplier is not `receipt_is_document` and disposition ≠ `is_document`), `open`, `closed` (covered within 2 ₪, or decision `closed_anyway|paid_outside_bank`), `unpaid_marked` (in closed tab, flagged). `isClosed(doc)` exported.

- [ ] Step 1: Tests (write first): rule seeding idempotent (run twice → same count); "משכורת" description matched by the salaries rule; pool excludes internal transfer, excludes fully paid tx, keeps partially paid with correct `remaining`, puts rule-matched tx in `exempt` with its rule; doc with payments 998 of 1000 → `closed` (2 ₪), 990 → `open`; `closed_anyway` decision → `closed`; receipt of a normal supplier → lane `receipt`, of a `receipt_is_document` supplier → `open`; `findDuplicate` hits on same supplier+doc number (vendorKey-normalised) and on sha256; `matchSupplier` prefers tax id over name.
- [ ] Step 2: Run → fail. Step 3: Implement per port notes §4, §6, §9. Step 4: Pass. Step 5: script `test:expense-core`; commit.

---

### Task 3: Pair engine

**Files:** create `services/expensePairs.service.js`. Test: `server/scripts/expense-pairs.test.js`.

**Interfaces — Consumes:** `documentsWithState`, `chargePool` (Task 2). **Produces:**
- `scorePair(doc, tx): { score, reasons: string[] }` — port §1.3 exactly (withholding off).
- `compareFields(doc, tx): { amount: 'ok'|'near'|'bad', date: …, name: … }` — port §1.6.
- `pairQueue(): Promise<{ pairs: Array<{doc, tx, score, reasons, fields}>, unmatchedDocs: DocState[], unmatchedCharges: Tx[], exemptCharges: Array<{tx, rule}> }>` — port §2.2 greedy global assignment over lane `open` + `review` docs (review docs ARE paired — anchored on the document, the tofy trap), skipping rejections.
- `alternativesForDoc(docId, limit = 5)`, `alternativesForTx(txId, limit = 5)` — port §2.4.

- [ ] Step 1: Tests: exact amount same day → ≥ 55; charge 4 days before doc → 0; 91 days after → 0; approx 4% same day passes, 4% 20 days later without name → below 55; two docs competing for one charge → the higher score wins, the other appears in `unmatchedDocs`; rejected pair never proposed; a `needs_review` doc is still proposed (does not vanish); internal transfer never appears; alternatives return ≤ 5 sorted by score.
- [ ] Step 2–5: fail → implement per §1–§2 → pass → script `test:expense-pairs` → commit.

---

### Task 4: Writes

**Files:** create `services/expenseWrites.service.js`. Test: `server/scripts/expense-writes.test.js`.

**Interfaces — Produces:**
- `acceptPair({ document_id, transaction_id, amount?, review?, by })` — port §3.1: optional field corrections from `review` applied and `needs_review=false`; payment amount defaults to `min(doc.remaining, tx.remaining)`; foreign-currency doc: `amount_total` set from the charge shekels and `fx_confirmed=true`; one Mongo transaction if the memory server is a replica set, otherwise ordered writes with rollback on failure (document which in a comment).
- `rejectPair({ document_id, transaction_id, by })`, `unpairCharge({ document_id, transaction_id })` (removes payment), `markUnpaid(document_id, by)` / `unmarkUnpaid`, `decide(document_id, kind, note, by)` / `undecide`, `confirmDocument(document_id, fields, by)` (review→confirmed without pairing), `voidDocument(document_id, by)`.
- Every write validates ObjectIds and refuses on a `void` document.

- [ ] Steps: tests (accept creates payment + clears needs_review + applies corrections; second accept on a fully covered charge refused; reject stored and pair disappears from `pairQueue`; unpair returns charge to pool; fx doc takes bank shekels; decide closed_anyway moves to closed; void refuses further writes) → fail → implement → pass → script → commit.

---

### Task 5: Receipts

**Files:** create `services/expenseReceipts.service.js`. Test: `server/scripts/expense-receipts.test.js`.

**Interfaces — Produces:** `receiptsLane(now = new Date())` → `{ waiting, overdue, linkedRecently }` (port §5.5, grace 14, linked window 60 days) — PURE READ; `invoiceCandidates(receiptId, limit = 8)` (§5.6, ±120 days); `linkReceipt(receiptId, invoiceId, by)` (sets `linked_invoice_id`, `receipt_disposition='has_invoice'`, moves the receipt's payments to the invoice per §5.7); `unlinkReceipt(receiptId)`; `setSupplierReceiptIsDocument(supplierId, value, by)`; `markReceiptIsDocument(receiptId, by)` (single receipt, `receipt_disposition='is_document'`).

- [ ] Steps: tests (14-day overdue boundary; receiptsLane twice → zero writes (compare `updated_at`s / document counts); candidates same supplier within 120 days sorted by amount-match then gap; link moves payment rows to invoice; supplier exempt → its receipts leave the receipt lane and become `open`) → fail → implement → pass → script → commit.

---

### Task 6: Intake — manual entry and mail-sorter pull

**Files:** create `services/expenseIntake.service.js`; modify `server/src/index.js` (6-hour job). Test: `server/scripts/expense-intake.test.js`.

**Interfaces — Consumes:** `findDuplicate`, `matchSupplier`, `mailSorter.service` (`isConfigured`, `listDocuments`, `ack`). **Produces:**
- `createManual({ fields, file: { data, name, mime } | null, by })` → doc (`needs_review:false`, `confirmed_by:by`); file > 10 MB refused; duplicate → `Error` with `code:'DUPLICATE', existing_id`.
- `updateDocument(id, fields, by)` (fields whitelist: supplier_id, vendor_name, supplier_tax_id, doc_type, doc_number, doc_date, amount_total, currency, branch_id, is_general, order_id).
- `createSupplierFromDocument(docId, by)` → `Supplier` with vendor_name/tax id, links it.
- `pullFromMailSorter({ client = mailSorter } = {})` → `{ fetched, created, skipped, errors }`: list `invoice` and `receipt` for gan; skip items whose `mail_sorter_id` exists; map `extracted` fields (spec §3) → doc `source:'mail_sorter', needs_review:true`; `ack` only after save; a failed item never blocks the others. `client` injectable for tests.
- `getFile(docId)` → `{ buffer, name, mime }` from `ExpenseFile` or `mailSorter.fetchFile(mail_sorter_id)`.
- Job: in `index.js` jobs block, `withJobLock('expense-mail-pull', 15*60*1000, () => intake.pullFromMailSorter())` every 6 h, only when `mailSorter.isConfigured()`.

- [ ] Steps: tests with a fake client (same item twice → one doc, ack once; ack not called when save throws; receipt doc_type mapped; supplier matched by tax id; manual duplicate → DUPLICATE with id; 11 MB file refused) → fail → implement → pass → script → commit.

---

### Task 7: Orders link

**Files:** create `services/expenseOrders.service.js`. Test: `server/scripts/expense-orders.test.js`.

**Interfaces — Produces:** `orderCandidates(docId)` → `[{ order, compare_amount, diff }]` sorted by |diff| (rules in Global Constraints; compare_amount = Σ qty_received×unit_price × supplier.vat_rate when any qty_received > 0, else `total_amount`); `linkOrder(docId, orderId, by)` (sets `order_id`; fills `branch_id` from the order when doc has no branch and is not general; refuses if the order is already linked to another active invoice-type doc); `unlinkOrder(docId)`; `orderMismatch(doc, order)` → `{ diff, warning: string|null }` (Hebrew warning when |diff| > 2).

- [ ] Steps: tests (other supplier excluded; outside window excluded; cancelled excluded; received qty drives compare amount; branch filled; second invoice on same order refused; warning text when diff 50) → fail → implement → pass → script → commit.

---

### Task 8: Search and counts

**Files:** create `services/expenseSearch.service.js`. Test: `server/scripts/expense-search.test.js`.

**Interfaces — Produces:** `search({ q, min, max, branch })` → `{ documents, charges }` per port §7 (text over vendor/doc number/tax id/description/counterparty; amount range on |amount|; regex-escaped); `counts()` → `{ pair, review, receipts, overdue, closed, unpaid_marked }` from the same derivations (one call).

- [ ] Steps: tests (`q='.*'` is literal; amount range inclusive; branch filter on documents) → fail → implement → pass → commit.

---

### Task 9: API + permissions

**Files:** create `controllers/expenses.controller.js`, `routes/expenses.routes.js`; modify `routes/index.js` (after `attachBranchScope`, next to `/finance`). Test: `server/scripts/expenses-api-e2e.test.js` (harness copied from `finance-api-e2e.test.js`).

**Endpoints (`/api/expenses`):** reads (`requireTab('expenses', 'system_admin','admin_viewer','accountant')`): `GET /pairs`, `GET /pairs/alternatives?document_id=|transaction_id=`, `GET /receipts`, `GET /receipts/:id/candidates`, `GET /closed`, `GET /search`, `GET /counts`, `GET /documents/:id`, `GET /documents/:id/file`, `GET /documents/:id/orders`, `GET /rules`, `GET /suppliers-missing-tax-id`, `GET /intake/status`. Writes (`requireTabWrite('expenses','system_admin','accountant')`): `POST /documents` (manual, body `{fields, file?}`), `PATCH /documents/:id`, `POST /documents/:id/void`, `POST /documents/:id/confirm`, `POST /documents/:id/supplier`, `POST /pairs/accept`, `POST /pairs/reject`, `POST /pairs/unpair`, `POST|DELETE /documents/:id/unpaid`, `POST|DELETE /documents/:id/decision`, `POST /receipts/:id/link`, `DELETE /receipts/:id/link`, `POST /receipts/:id/is-document`, `POST /suppliers/:id/receipt-is-document`, `POST|DELETE /documents/:id/order`, `POST /rules`, `DELETE /rules/:id` (built-in refused), `POST /intake/pull`. Errors: Hebrew, `apiError`-compatible `{ error }`; validation 400, not found 404, duplicate 409 `{ error, existing_id }`.

- [ ] Steps: e2e (admin creates manual doc with file and reads file back; accountant accepts a pair; viewer's writes do not change data; teacher 403 on reads; duplicate → 409 with id; built-in rule delete refused; GET /receipts makes no writes; `/counts` matches lanes) → fail → implement → pass → also rerun `finance-api-e2e` → commit.

---

### Task 10: The "הוצאות" screen

**Files:** create the client files listed in File Structure; modify `App.jsx` (route `/expenses` behind `ProtectedRoute tab="expenses"`). Verify: `cd client && npx vite build`, hex ratchet stays 602, `tabs-constant-sync` no new mismatch.

Requirements (spec §10): 5 tabs in this order with counts from `/counts`; branch filter; "+ מסמך" opens `DocumentDialog` (file via `FilePickButton`, fields, supplier picker from `/api/suppliers`, branch picker incl. "כללי", order picker from `/documents/:id/orders` after save); PairTab rows show doc side and charge side with per-field green/red (`fields`), "✓ אשר ושייך" (with inline edit when `needs_review`), "✗ לא זה" expanding up to 5 alternatives inline, branch + order chips editable in the row, order mismatch warning; groups "מסמכים בלי הצעה" and "חיובים בלי מסמך — איזו חשבונית זו?"; ReceiptsTab (waiting / overdue / linked recently, candidates, link, "הספק עוסק פטור / עמותה"); ClosedTab (paid amount, payments list, "✗ לא שייך", "עוד לא שולמה" section, iCount column text "לא חובר"); SearchTab; ToolsTab (rules list/add/delete non-built-in, intake status + "משוך עכשיו", suppliers missing tax id). Write controls via `hasTabAccess(user,'expenses_write')`. Transient errors as toasts; load failure ≠ empty; phone cards; ₪ after number; no hex.

- [ ] Steps: implement → build → ratchet → commit. Controller does the browser check.

---

### Task 11: Release (controller)

- [ ] Merge to main, push, wait for Render commit, probe `/api/expenses/counts` → 401 unauthenticated.
- [ ] Seed rules run on first `/rules` read or at boot (idempotent) — confirm in prod by the owner opening ⚙️ כלים.
- [ ] Owner: open `/expenses`, "משוך עכשיו".
