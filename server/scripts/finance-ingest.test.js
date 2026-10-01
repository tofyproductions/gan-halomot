#!/usr/bin/env node
/**
 * Bank feed ingest — the rules that keep a re-sent statement from doubling the
 * gan's money, and a pending charge from living forever.
 *
 *   node scripts/finance-ingest.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

const acct = (txs, extra = {}) => ({
  external_id: 'beinleumi:••••0463', institution: 'beinleumi', label: 'בינלאומי ••••0463',
  account_number: '••••0463', type: 'bank', balance: 1000, transactions: txs, ...extra,
});
const tx = (o) => ({ date: '2026-09-10', amount: -100, description: 'ספק א', bank_ref: '111', ...o });

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const { BankAccount, BankTransaction, FinanceSyncLog } = require('../src/models');
  const { ingest, txHash } = require('../src/services/financeIngest.service');

  console.log('\n🏦 קליטת תנועות בנק\n');

  console.log('זהות תנועה');
  {
    const a = txHash('x', tx({}));
    eq(a, txHash('x', tx({})), 'אותה תנועה — אותו מזהה');
    ok(a !== txHash('x', tx({ bank_ref: '222' })), 'אסמכתא אחרת — תנועה אחרת');
    ok(a !== txHash('x', tx({}), 2), 'עותק שני זהה לחלוטין — מספר רץ מבדיל');
    eq(txHash('x', tx({ counterparty: 'מישהו' })), a, 'שם מוטב לא משנה את הזהות');
  }

  console.log('\nקליטה ראשונה וחוזרת');
  {
    const r1 = await ingest([acct([tx({}), tx({ bank_ref: '112', amount: 500, description: 'העברה' })])]);
    eq(r1.inserted, 2, 'שתי תנועות נכנסו');
    const r2 = await ingest([acct([tx({}), tx({ bank_ref: '112', amount: 500, description: 'העברה' })])]);
    eq(r2.inserted, 0, 'קליטה חוזרת — אין חדשות');
    eq(r2.updated, 2, 'ושתיהן עודכנו');
    eq(await BankTransaction.countDocuments(), 2, 'ובמסד עדיין שתיים');
    const a = await BankAccount.findOne({ external_id: 'beinleumi:••••0463' }).lean();
    eq(a.balance, 1000, 'היתרה נשמרה');
    ok(a.balance_at instanceof Date, 'ומתי');
  }

  console.log('\nשתי רכישות זהות באותו יום');
  {
    await ingest([acct([tx({ bank_ref: null, description: 'קפה', amount: -12 }), tx({ bank_ref: null, description: 'קפה', amount: -12 })])]);
    eq(await BankTransaction.countDocuments({ description: 'קפה' }), 2, 'שתיהן נשמרות — לא אחת דורסת את השנייה');
  }

  console.log('\nתנועה ממתינה');
  {
    await ingest([acct([tx({ bank_ref: null, description: 'ממתין', amount: -50, status: 'pending' })])]);
    const r = await ingest([acct([tx({ bank_ref: null, description: 'ממתין סופי', amount: -55, status: 'pending' })])]);
    eq(r.pending_replaced, 1, 'הממתינה הישנה הוחלפה');
    eq(await BankTransaction.countDocuments({ status: 'pending' }), 1, 'נשארה ממתינה אחת — העדכנית');
  }

  console.log('\nשם מוטב מגיע אחר כך');
  {
    await ingest([acct([tx({ counterparty: 'אבי ספקים בע"מ', transfer_note: 'חשבונית 77' })])]);
    const t = await BankTransaction.findOne({ bank_ref: '111' }).lean();
    eq(t.counterparty, 'אבי ספקים בע"מ', 'המוטב נכנס לתנועה הקיימת');
    await ingest([acct([tx({})])]);
    const t2 = await BankTransaction.findOne({ bank_ref: '111' }).lean();
    eq(t2.counterparty, 'אבי ספקים בע"מ', 'קליטה בלי מוטב לא מוחקת אותו');
  }

  console.log('\nקלט שבור');
  {
    let threw = null;
    try { await ingest([{ institution: 'x', label: 'y', transactions: [] }]); } catch (e) { threw = e; }
    ok(threw && /external_id/.test(threw.message), 'חשבון בלי מזהה נדחה');
    threw = null;
    try { await ingest([acct([tx({ date: '10/09/2026' })])]); } catch (e) { threw = e; }
    ok(threw && /YYYY-MM-DD/.test(threw.message), 'תאריך בפורמט לא נכון נדחה');
  }

  console.log('\nיומן');
  {
    const n = await FinanceSyncLog.countDocuments({ source: 'agent', status: 'ok' });
    ok(n >= 5, 'כל קליטה נרשמה ביומן');
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו` : '\n✅ הכל עבר');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
