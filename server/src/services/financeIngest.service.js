/**
 * The bank feed's one way in — the agent's signed payload and the Max xlsx
 * both land here. Rules ported from tofy-friends finance.service.ingest:
 *
 *  - identity is computed HERE, never trusted from the sender;
 *  - two byte-identical rows in one batch are two real charges (same coffee
 *    twice) — numbered, not merged;
 *  - pending rows of an account are wiped and re-laid on every ingest: a
 *    pending charge changes amount and text until it settles;
 *  - payee name / transfer note enrich an existing row and are never blanked
 *    by a later batch that lacks them.
 */
const crypto = require('crypto');
const { BankAccount, BankTransaction, FinanceSyncLog } = require('../models');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const clip = (v, max = 160) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

function normaliseDate(value, field) {
  const s = String(value || '').slice(0, 10);
  if (!ISO_DATE.test(s)) throw new Error(`${field} חייב להיות בפורמט YYYY-MM-DD`);
  return s;
}

function txHash(externalId, t, seq = 1) {
  const parts = [externalId, t.date, Number(t.amount).toFixed(2), String(t.description || '').trim()];
  const ref = String(t.bank_ref ?? '').trim();
  if (ref) parts.push(ref);
  if (seq > 1) parts.push(`#${seq}`);
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function numberDuplicates(transactions) {
  const seen = new Map();
  return transactions.map((t) => {
    const key = [t.date, Number(t.amount).toFixed(2), String(t.description || '').trim(), String(t.bank_ref ?? '').trim()].join('|');
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return n;
  });
}

async function ingestAccount(raw, source) {
  if (!raw || !raw.external_id || !raw.institution || !raw.label) {
    throw new Error('חשבון חסר external_id / institution / label');
  }
  const txs = Array.isArray(raw.transactions) ? raw.transactions : [];
  const rows = txs.map((t) => {
    const amount = Number(t.amount);
    if (!Number.isFinite(amount)) throw new Error('סכום לא תקין');
    return {
      date: normaliseDate(t.date, 'date'),
      processed_date: t.processed_date ? normaliseDate(t.processed_date, 'processed_date') : null,
      amount,
      currency: clip(t.currency, 8) || 'ILS',
      description: clip(t.description) || 'ללא תיאור',
      original_description: clip(t.original_description) || clip(t.description) || '',
      provider_category: clip(t.provider_category, 80),
      status: t.status === 'pending' ? 'pending' : 'completed',
      bank_ref: clip(t.bank_ref, 64),
      counterparty: clip(t.counterparty),
      transfer_note: clip(t.transfer_note),
    };
  });

  const account = await BankAccount.findOneAndUpdate(
    { external_id: raw.external_id },
    {
      $set: {
        institution: raw.institution,
        label: clip(raw.label) || raw.external_id,
        account_number: clip(raw.account_number, 32),
        type: raw.type === 'card' ? 'card' : 'bank',
        currency: clip(raw.currency, 8) || 'ILS',
        ...(typeof raw.balance === 'number' ? { balance: raw.balance, balance_at: new Date() } : {}),
      },
      $setOnInsert: { is_active: true },
    },
    { upsert: true, new: true },
  );

  const wiped = await BankTransaction.deleteMany({ account_id: account._id, status: 'pending' });
  const out = { inserted: 0, updated: 0, pending_replaced: wiped.deletedCount || 0 };

  const seqs = numberDuplicates(rows);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const seq = seqs[i];
    const hash = txHash(raw.external_id, r, seq);
    const set = {
      account_id: account._id, date: r.date, processed_date: r.processed_date || r.date,
      amount: r.amount, currency: r.currency, description: r.description,
      original_description: r.original_description, provider_category: r.provider_category,
      status: r.status, bank_ref: r.bank_ref, dup_seq: seq > 1 ? seq : null, source,
    };
    // Enrich, never blank: a batch without the payee leaves the stored one.
    if (r.counterparty) set.counterparty = r.counterparty;
    if (r.transfer_note) set.transfer_note = r.transfer_note;
    const res = await BankTransaction.updateOne({ hash }, { $set: set, $setOnInsert: { hash } }, { upsert: true });
    if (res.upsertedCount) { if (r.status !== 'pending') out.inserted++; }
    else out.updated++;
  }
  return out;
}

async function ingest(accounts, { agentVersion = null, source = 'agent' } = {}) {
  if (!Array.isArray(accounts)) throw new Error('accounts חייב להיות מערך');
  const result = { accounts_seen: 0, inserted: 0, updated: 0, pending_replaced: 0, skipped: 0, card_settlements: 0 };
  try {
    for (const acc of accounts) {
      const r = await ingestAccount(acc, source);
      result.accounts_seen++;
      result.inserted += r.inserted;
      result.updated += r.updated;
      result.pending_replaced += r.pending_replaced;
    }
    // Existence is resolved on its own: an error thrown INSIDE an existing
    // cardSettlement.service (e.g. its own missing dependency) must not look
    // like "module not built yet".
    let detect = null;
    try {
      require.resolve('./cardSettlement.service');
      detect = require('./cardSettlement.service').detectCardSettlements;
    } catch (e) {
      if (!(e.code === 'MODULE_NOT_FOUND' && /^Cannot find module '\.\/cardSettlement\.service'/.test(e.message))) throw e;
    }
    if (detect) {
      try {
        result.card_settlements = (await detect()).length;
      } catch (e) {
        console.error('[finance] card settlement pass failed:', e.message);
      }
    }
    await FinanceSyncLog.create({ source, agent_version: agentVersion, status: 'ok', ...result });
    return result;
  } catch (err) {
    await FinanceSyncLog.create({ source, agent_version: agentVersion, status: 'error', error: err.message, ...result })
      .catch(() => {});
    throw err;
  }
}

module.exports = { ingest, txHash, numberDuplicates };
