require('dotenv').config();
const mongoose = require('mongoose');
const models = require('../src/models');
const { Branch, Punch } = models;
const il = d => d ? new Date(d).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'}) : 'null';
const BASE = new Date('2026-06-23T22:30:00+03:00');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const md = await Branch.findOne({ name: /משה דיין/ }).select('_id').lean();
  for (let i=0;i<40;i++){ // ~40 min @60s
    try {
      const b = await Branch.findById(md._id).lean();
      const conn = b.agent_last_seen_at && new Date(b.agent_last_seen_at) > BASE;
      const dev = await Punch.countDocuments({ branch_id: md._id, timestamp_source:'device', received_at:{ $gt: BASE } });
      const t = new Date().toLocaleTimeString('he-IL',{timeZone:'Asia/Jerusalem'});
      console.log(`[${t}] last_seen=${il(b.agent_last_seen_at)} | 24-29 synced=${dev} ${conn?'✅ HEARTBEAT!':'⏳'}`);
      if (conn){ console.log('   🎉 Pi ONLINE!'); if(dev>0){ console.log('🎉 BACKFILL FLOWING'); break; } }
    } catch(e){ console.log('poll err:', e.message); }
    await new Promise(r=>setTimeout(r,60000));
  }
  await mongoose.disconnect();
})().catch(e=>{console.error('fatal:',e.message);process.exit(1);});
