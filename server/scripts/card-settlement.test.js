#!/usr/bin/env node
/**
 * The card bill in the bank is not a second expense.
 *
 * Once a month the bank pays Max one sum for everything charged on a card.
 * Without this pass every card purchase is counted twice — once on the card,
 * once as the bank's lump payment.
 *
 *   node scripts/card-settlement.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l) => { console.log(`  ${c ? '✅' : '❌'} ${l}`); if (!c) failures++; };

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const { BankTransaction } = require('../src/models');
  const { ingest } = require('../src/services/financeIngest.service');
  const { detectCardSettlements, unlinkSettlement } = require('../src/services/cardSettlement.service');

  console.log('\n💳 חיוב הכרטיס בבנק\n');

  await ingest([{
    external_id: 'max:••••7996', institution: 'max', label: 'Max ••••7996', type: 'card',
    transactions: [
      { date: '2026-08-05', processed_date: '2026-09-02', amount: -300, description: 'שופרסל' },
      { date: '2026-08-20', processed_date: '2026-09-02', amount: -200, description: 'דלק' },
    ],
  }], { source: 'max_xlsx' });
  await ingest([{
    external_id: 'beinleumi:••••0463', institution: 'beinleumi', label: 'בינלאומי', type: 'bank',
    transactions: [
      { date: '2026-09-03', amount: -500, description: 'מקס איט פיננסים', bank_ref: '9' },
      { date: '2026-09-03', amount: -500, description: 'שכר דירה', bank_ref: '10' },
    ],
  }]);

  const bill = await BankTransaction.findOne({ bank_ref: '9' }).lean();
  ok(bill.is_internal_transfer === true, 'שורת "מקס" בסך חיובי הכרטיס סומנה העברה פנימית');
  ok(bill.matched_card_account_id, 'וקושרה לכרטיס');
  const rent = await BankTransaction.findOne({ bank_ref: '10' }).lean();
  ok(rent.is_internal_transfer === false, 'שכר דירה באותו סכום — לא נגעו בו (התיאור לא של כרטיס)');

  await unlinkSettlement(bill._id);
  await detectCardSettlements();
  const after = await BankTransaction.findOne({ bank_ref: '9' }).lean();
  ok(after.is_internal_transfer === false && after.settlement_dismissed === true, 'ביטול ידני נשמר — המעבר הבא לא מקשר שוב');

  console.log('\nחיוב שני לאותו חשבון');
  await ingest([{
    external_id: 'max:••••8093', institution: 'max', label: 'Max ••••8093', type: 'card',
    transactions: [{ date: '2026-08-10', processed_date: '2026-09-02', amount: -400, description: 'פז' }],
  }], { source: 'max_xlsx' });
  await ingest([{
    external_id: 'beinleumi:••••0463', institution: 'beinleumi', label: 'בינלאומי', type: 'bank',
    transactions: [
      { date: '2026-09-03', amount: -400, description: 'מקס איט פיננסים', bank_ref: '21' },
      { date: '2026-09-04', amount: -400, description: 'מקס איט פיננסים', bank_ref: '22' },
    ],
  }]);
  const twoLines = await BankTransaction.find({ bank_ref: { $in: ['21', '22'] } }).lean();
  ok(twoLines.filter(t => t.matched_card_account_id).length === 1, 'שני חיובים תואמים לחשבון אחד — רק אחד קושר');

  console.log('\nחיובים בהפרש יומיים לאותו כרטיס (8093: 3, 5, 7 במאי 2026)');
  await ingest([{
    external_id: 'max:••••8093', institution: 'max', label: 'Max ••••8093', type: 'card',
    transactions: [
      { date: '2026-05-01', processed_date: '2026-05-03', amount: -236.53, description: 'א' },
      { date: '2026-05-02', processed_date: '2026-05-05', amount: -91.37, description: 'ב' },
      { date: '2026-05-04', processed_date: '2026-05-07', amount: -291, description: 'ג' },
    ],
  }], { source: 'max_xlsx' });
  await ingest([{
    external_id: 'beinleumi:••••0463', institution: 'beinleumi', label: 'בינלאומי', type: 'bank',
    transactions: [
      { date: '2026-05-03', amount: -236.53, description: 'מקס הבינלאומי - 8093', bank_ref: '31' },
      { date: '2026-05-05', amount: -91.37, description: 'מקס הבינלאומי - 8093', bank_ref: '32' },
      { date: '2026-05-07', amount: -291, description: 'מקס הבינלאומי - 8093', bank_ref: '33' },
    ],
  }]);
  const may = await BankTransaction.find({ bank_ref: { $in: ['31', '32', '33'] } }).lean();
  ok(may.every(t => t.is_internal_transfer && t.matched_card_account_id), 'שלושה חיובים ביומיים הפרש — כל אחד קושר לחיוב שלו');

  console.log('\nשני כרטיסים, אותו יום ואותו סכום — לפי הספרות בתיאור');
  await ingest([{
    external_id: 'max:••••7996', institution: 'max', label: 'Max ••••7996', type: 'card',
    transactions: [{ date: '2026-06-01', processed_date: '2026-06-15', amount: -500, description: 'ד' }],
  }], { source: 'max_xlsx' });
  await ingest([{
    external_id: 'max:••••8093', institution: 'max', label: 'Max ••••8093', type: 'card',
    transactions: [{ date: '2026-06-02', processed_date: '2026-06-15', amount: -500, description: 'ה' }],
  }], { source: 'max_xlsx' });
  // The 8093 line comes FIRST, so a match by amount alone would give it to 7996.
  await ingest([{
    external_id: 'beinleumi:••••0463', institution: 'beinleumi', label: 'בינלאומי', type: 'bank',
    transactions: [
      { date: '2026-06-15', amount: -500, description: 'מקס הבינלאומי - 8093', bank_ref: '41' },
      { date: '2026-06-15', amount: -500, description: 'מקס הבינלאומי - 7996', bank_ref: '42' },
    ],
  }]);
  const { BankAccount } = require('../src/models');
  const c7996 = await BankAccount.findOne({ external_id: 'max:••••7996' }).lean();
  const c8093 = await BankAccount.findOne({ external_id: 'max:••••8093' }).lean();
  const l41 = await BankTransaction.findOne({ bank_ref: '41' }).lean();
  const l42 = await BankTransaction.findOne({ bank_ref: '42' }).lean();
  ok(String(l41.matched_card_account_id) === String(c8093._id), 'השורה של 8093 קושרה ל-8093');
  ok(String(l42.matched_card_account_id) === String(c7996._id), 'השורה של 7996 קושרה ל-7996');

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו` : '\n✅ הכל עבר');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
