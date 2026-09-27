#!/usr/bin/env node
/**
 * READ-ONLY preview of the punch follow-up against the configured database
 * (server/.env = PRODUCTION). Prints counts only — no names.
 *
 *   node scripts/punch-followup-preview.js [startDate=YYYY-MM-DD]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { loadFollowup } = require('../src/services/punchFollowup/load');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const startOverride = process.argv[2] || null;
  const { window, issues } = await loadFollowup({ today, startOverride });
  console.log('today', today, 'window', JSON.stringify(window));
  const tally = {};
  for (const i of issues) {
    const k = `${i.kind}/${i.state}/emp:${i.visibility.employee || '-'}/mgr:${i.visibility.manager || '-'}`;
    tally[k] = (tally[k] || 0) + 1;
  }
  console.log(JSON.stringify(tally, null, 1));
  console.log('employees with an open issue:', new Set(issues.filter(i => i.state === 'open').map(i => i.employee_id)).size);
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
