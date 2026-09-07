#!/usr/bin/env node
/**
 * What the default transport actually puts on the wire.
 *
 * The fake-transport tests prove the shape of the request we build; this one
 * proves it survives the send. It matters because `fetch` does NOT: undici
 * overwrites the Host header with the connection's own authority, so on the
 * platform every replay looked like it arrived at 127.0.0.1 and tenant
 * resolution fell to the default connection. A real server is started here and
 * asked what it received.
 *
 *   node scripts/proposed-change-wire.test.js
 */
const http = require('http');
const { applyProposal } = require('../src/services/proposedChanges.service');

let failures = 0;
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const approver = {
  id: 'acc1', email: 'a@x', full_name: 'רו"ח', role: 'accountant',
  branch_id: null, managed_branch_ids: [],
};

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Collect everything the server saw, then answer with `reply`. */
function recorder(seen, reply) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      seen.push({
        host: req.headers.host,
        url: req.url,
        method: req.method,
        proposed: req.headers['x-proposed-change'],
        authScheme: String(req.headers.authorization || '').split(' ')[0],
        contentType: req.headers['content-type'],
        body,
      });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(reply.text);
    });
  };
}

(async () => {
  console.log('\n🔌 מה באמת נשלח בחוט\n');

  console.log('בקשה מוצלחת');
  {
    const seen = [];
    const server = await listen(recorder(seen, { status: 200, text: '{"ok":true}' }));
    const { port } = server.address();
    const doc = {
      _id: 'pc1', method: 'PATCH', path: '/api/employees/e9?x=1',
      host: 'gan-halomot.onrender.com', body: { full_name: 'דנה' },
      content_type: 'application/json',
    };
    const r = await applyProposal(doc, approver, { baseUrl: `http://127.0.0.1:${port}` });

    eq(r, { status: 200, ok: true, error: '' }, '2xx → הצליח');
    eq(seen.length, 1, 'הגיעה בקשה אחת');
    // The whole point: this is the STORED host, not 127.0.0.1:<port>.
    eq(seen[0].host, 'gan-halomot.onrender.com', 'המארח שנשמר הוא המארח שהתקבל (fetch היה דורס אותו)');
    eq(seen[0].url, '/api/employees/e9?x=1', 'הנתיב כולל השאילתה');
    eq(seen[0].method, 'PATCH', 'אותה שיטה');
    eq(seen[0].proposed, 'pc1', 'מסומן במזהה ההצעה');
    eq(seen[0].authScheme, 'Bearer', 'עם טוקן נושא');
    eq(seen[0].contentType, 'application/json', 'JSON');
    eq(seen[0].body, { full_name: 'דנה' }, 'והגוף הגיע שלם');
    server.close();
  }

  console.log('\nתשובת שגיאה מהשרת');
  {
    const seen = [];
    const server = await listen(recorder(seen, { status: 409, text: '{"error":"החודש נעול"}' }));
    const { port } = server.address();
    const doc = {
      _id: 'pc2', method: 'POST', path: '/api/payroll/lock',
      host: 'gan-halomot.onrender.com', body: { month: '2026-09' },
      content_type: 'application/json',
    };
    const r = await applyProposal(doc, approver, { baseUrl: `http://127.0.0.1:${port}` });
    eq(r, { status: 409, ok: false, error: 'החודש נעול' }, '409 → נכשל, עם הודעת השרת');
    server.close();
  }

  console.log('\nבקשה בלי גוף');
  {
    const seen = [];
    const server = await listen(recorder(seen, { status: 204, text: '' }));
    const { port } = server.address();
    const doc = {
      _id: 'pc3', method: 'DELETE', path: '/api/employees/e9',
      host: 'demo.dreamgan.com', body: null,
    };
    const r = await applyProposal(doc, approver, { baseUrl: `http://127.0.0.1:${port}` });
    eq(r, { status: 204, ok: true, error: '' }, '204 → הצליח');
    eq([seen[0].host, seen[0].method, seen[0].body], ['demo.dreamgan.com', 'DELETE', null], 'מארח, שיטה, בלי גוף');
    server.close();
  }

  console.log('\nאין מי שיענה');
  {
    // Port 1 on loopback: nothing listens, so the socket errors out.
    const r = await applyProposal(
      { _id: 'pc4', method: 'GET', path: '/api/employees', host: 'x' },
      approver, { baseUrl: 'http://127.0.0.1:1' },
    );
    eq([r.status, r.ok], [0, false], 'אין חיבור → 0');
  }

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
