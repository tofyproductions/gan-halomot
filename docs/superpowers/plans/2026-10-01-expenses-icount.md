# Expenses — iCount (Finance Part 2ב) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gan's own iCount account is mirrored into the expenses module (bookkeeper-typed documents become pairable documents), and closed documents can be filed to iCount and reported paid — with every tofy safety rule.

**Architecture:** A gan-specific iCount client (session, throttle) + supplier resolver + read-only mirror that upserts `IcountExpense` and bridges into `ExpenseDocument` (`source:'icount'`) so the 2א engine needs no change; a filing service gated on the closed lane; UI additions in the closed and tools tabs.

**Tech Stack:** Node/Express, Mongoose, React + MUI, mongodb-memory-server, injectable fake iCount transport.

**Spec:** `docs/superpowers/specs/2026-10-01-expenses-icount-design.md`
**Binding reference:** `docs/superpowers/specs/2026-10-01-icount-port-notes.md`

## Global Constraints

- Env: `GAN_ICOUNT_COMPANY_ID`, `GAN_ICOUNT_USER`, `GAN_ICOUNT_PASS` (NOT the platform's `ICOUNT_API_TOKEN`). Unset → every iCount path reports "לא מחובר" and does nothing; status endpoint returns booleans only.
- Methods (constants): `/expense/search`, `/expense/create`, `/expense/update`, `/supplier/get_list`; login per port notes §1; throttle: plain-text "Too many requests" or 429 → 90 s cooldown; supplier pull concurrency 4, gap 50 ms.
- Filing sends exactly: `supplier_id, expense_type_id, expense_doctype, expense_docnum, expense_sum, expense_date, currency_code:'ILS'`. NEVER `payments`, VAT fields, description, scan.
- Doctype map: tax_invoice→invoice, invoice_receipt→invrec, receipt→receipt, credit_note→refund, other→other.
- Filing gates: closed lane only (closed | unpaid_marked) else 409 `NOT_CLOSED`; not needs_review; not `source:'icount'`; not already `icount_id`; blockers per spec §4; pre-create live search (same iCount supplier + docnum) → adopt id instead of creating.
- `expense_type_id`: Setting `icount_expense_type_id` (number); unset → blocked; per-document override in preview.
- Write grant `icount_upload` (`path:null`, `writeGrantFor:'expenses'`) defaultRoles `['system_admin','accountant']`, client + server tab files.
- Mirror only from `expenses_start_date`; storno docs never become documents; gone without payments → void; gone with payments → keep, flag `icount_gone_at`.
- Identity: `same_document` → link; `probable` → never auto-merge, decision via `ExpenseIdentityDecision`; per port notes §6.
- Report-paid: only when covered within 2 ₪ and doc is in iCount; `expense_paid` + `expense_paid_date` only; `IcountPaidReport` unique per doc; undo.
- Tests: memory Mongo, dotenv stubbed, fake transport injected; NEVER real network; NEVER load `server/.env`. UI: theme colours only (hex 602), Hebrew, apiError, phone cards.

---

### Task 1: iCount client

**Files:** create `server/src/services/ganIcount.client.js`; modify `server/src/config/env.js` (3 vars). Test `server/scripts/gan-icount-client.test.js`.

**Produces:** `createIcountClient({ transport = defaultFetchTransport, now = Date.now } = {})` → `{ isConfigured(), status() → {configured:boolean, logged_in:boolean}, post(method, params) → resp, cooldownUntil() }`; module singleton `getClient()`. `post`: logs in when needed (port §1 exact login call/params), retries once on session expiry, detects throttle (plain text or 429) → throws `Error('אייקאונט מגביל קצב — נסו שוב בעוד דקה')` with `code:'THROTTLED'` and sets 90 s cooldown during which calls fail fast with the same code; `status:false` responses → `Error(reason verbatim)` `code:'ICOUNT_ERROR'`; never logs credentials.

- [ ] Steps: tests with fake transport (login once, reused; expired session → relogin + retry once; plain-text throttle → THROTTLED and fail-fast within 90 s, works after; status:false → reason verbatim; unconfigured → isConfigured false and post throws 'לא מחובר'); implement per port §1–§3; pass; script `test:gan-icount-client`; commit.

### Task 2: Suppliers + mirror models + pull

**Files:** create `models/IcountExpense.js`, `models/IcountPull.js`, `models/ExpenseIdentityDecision.js`, `models/IcountPaidReport.js`; `services/icountSuppliers.service.js`, `services/icountMirror.service.js`; add `icount_id`, `icount_docnum`, `icount_filed_at`, `icount_filed_by`, `icount_gone_at` to `ExpenseDocument`, `'icount'` to its `source` enum; register models. Test `server/scripts/icount-mirror.test.js`.

**Produces:**
- `listSuppliers({ refresh })` (cache), `resolveSupplier({ tax_id, name })` → `{ id, name } | null` (tax id digits first, then normalised name via `expenseCore.vendorKey`).
- `pullMirror({ client })` → `{ suppliers, fetched, upserted, gone, partial, errors }`: per supplier `/expense/search` paged (port §5), only `doc_date >= expenses_start_date`, upsert `IcountExpense` by `icount_id` with the §5 fields, mark `gone_at` for previously-seen rows not returned when that supplier was read completely; records an `IcountPull`.
- `IcountExpense` fields: port §5 "EXACT list" mapped to camel/snake Mongo fields + `supplier_tax_id`, `gone_at`, `is_storno`.

- [ ] Steps: tests (paged search assembled; storno flagged; partial pull when one supplier throttles → partial:true, other suppliers saved, gone NOT applied to the partial supplier; re-pull idempotent; before start date ignored) → implement → pass → commit.

### Task 3: Bridge mirror → expense documents

**Files:** create `services/icountBridge.service.js`; modify `services/expenseIntake.service.js` (mail item matching an `icount` doc attaches `mail_sorter_id` instead of duplicate-skip). Test `server/scripts/icount-bridge.test.js`.

**Produces:** `compareToIcount(ours, theirs)` → `'same_document'|'probable'|'different'` (port §6 exact); `syncBridge()` → `{ linked, created, probable, voided, kept_gone }`: for each non-storno, non-gone `IcountExpense` ≥ start date: if an active `ExpenseDocument` already has its `icount_id` → nothing; else find same_document among active non-icount docs → set `icount_id`; else if a `probable` exists without a decision → record as pending identity question (no merge); else create `ExpenseDocument{source:'icount', icount_id, vendor_name, supplier_tax_id, supplier_id (matchSupplier), doc_type (reverse doctype map), doc_number, doc_date, amount_total, needs_review:false}`; for gone rows: icount doc without payments → `status:'void'`, with payments → `icount_gone_at` set. `decideIdentity(documentId, icountExpenseId, same:boolean, by)` → same: link (and void the icount-sourced twin if one was created, moving its payments); different: remember. `pendingIdentityQuestions()`.
- `pullMirror` then `syncBridge` run together in the daily job and the button.

- [ ] Steps: tests (iCount-only doc → icount document that appears in pairQueue; same supplier+number → linked not duplicated; probable never merged until decision; decision same → linked + twin voided with payments moved; gone w/o payments → void; gone with payments → kept + flagged; mail item duplicate of icount doc → mail_sorter_id attached, acked, no new doc; storno never created) → implement → pass → commit.

### Task 4: Filing + report-paid

**Files:** create `services/icountFiling.service.js`. Test `server/scripts/icount-filing.test.js`.

**Produces:** `fileBlockers(doc, ctx)` → Hebrew strings (spec §4 list); `previewFiling(documentId, { expense_type_id? })` → `{ ok, blockers, payload, icount_supplier }` (no network write; supplier list read allowed); `fileToIcount(documentId, { expense_type_id?, by, client })` → gates in order: 404, 409 ALREADY (icount_id), 409 NOT_CLOSED, 400 NEEDS_REVIEW / SOURCE_ICOUNT, 400 BLOCKED (first blocker), 503 NOT_CONFIGURED; pre-create search → adopt; create with EXACT payload (Global Constraints); save icount fields; returns `{ filed | adopted, icount_id }`. Per-document lock (`withLocks`). `reportPaid(documentId, { date, by, client })` (only covered + in iCount; `/expense/update` with `expense_paid:1`, `expense_paid_date`), `undoReportPaid`.

- [ ] Steps: tests (not closed → 409; needs_review → 400; icount-sourced → 400; blockers each; type unset → blocked; preview never calls create; pre-create hit → adopted, no create; create payload deep-equals the exact allowed keys (no payments, no vat, no description); success saves fields; double-click → second call 409 ALREADY; reportPaid refused when not covered; payload only paid fields) → implement → pass → commit.

### Task 5: Settings, job, API, permissions

**Files:** modify `server/src/index.js` (daily job: pull + bridge, first run 15 min after boot, only if configured), `routes/expenses.routes.js`, `controllers/expenses.controller.js`, `constants/tabs.js` + client `config/tabs.js` (`icount_upload`). Test: extend `server/scripts/expenses-api-e2e.test.js` with a fake transport injected via a test hook (e.g. `ganIcount.client.__setTransportForTests`).

**Endpoints:** reads (`expenses` tab): `GET /icount/status`, `GET /icount/settings`, `GET /icount/suppliers-missing`, `GET /icount/identity-questions`, `GET /documents/:id/icount-preview`; writes: `PUT /icount/settings` (expenses_write; `icount_expense_type_id`), `POST /icount/pull` (expenses_write; withJobLock 'icount-mirror', 409 if held), `POST /icount/identity` (expenses_write), `POST /documents/:id/icount-file` and `POST|DELETE /documents/:id/icount-paid` (`requireTabWrite('icount_upload', 'system_admin','accountant')` — check how requireTabWrite composes grant ids and use the `icount_upload` grant correctly). `/closed` and `/pairs` rows include `icount: { status: 'in_icount'|'filed'|'not_in_icount'|'gone', docnum }`.

- [ ] Steps: e2e (unconfigured → status {configured:false}, file → 503; viewer cannot file/report; accountant can; teacher 403; preview has no side effects; file flow with fake transport end to end) → implement → pass → commit.

### Task 6: UI

**Files:** modify `client/src/components/expenses/ClosedTab.jsx`, `ToolsTab.jsx`, `ExpenseCards.jsx`; create `IcountFileDialog.jsx`. Verify vite build, hex 602, tabs sync.

Requirements: spec §6 — closed-tab iCount column + "⬆ העלה לאייקאונט" (only with `hasTabAccess(user,'icount_upload')`) opening a preview dialog (payload summary, iCount supplier, blockers list, type override, confirm) and "📤 עדכן ששולם"/undo; "מאייקאונט" chip on icount-sourced docs everywhere; tools: connection status, expense-type setting with explanation, pull button + last pull result, missing suppliers, "זה אותו מסמך?" yes/no list. Visible reasons, no tooltip-only disabled controls.

- [ ] Steps: implement → build → ratchet → commit. Controller browser-checks.

### Task 7: Release (controller + owner)

- [ ] Merge, push, wait for deploy; with no env set: `/expenses/icount/status` → `configured:false`.
- [ ] Owner sets `GAN_ICOUNT_COMPANY_ID/USER/PASS` on Render; controller checks status → configured+logged_in; owner (or Orly) sets the expense type id; "משוך מאייקאונט".
- [ ] First filing only after the owner sees the preview.
