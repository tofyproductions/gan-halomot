#!/usr/bin/env node
/**
 * Build the shareable copy of the deck.
 *
 *   node sales/build-share.js
 *
 * pitch.html carries presenter notes: what to say, where to pause, which
 * objection to expect, and explicitly not to lower the price. They are hidden
 * behind a CSS class and a keypress, which is exactly enough to hide them from
 * the room behind you and nothing at all against somebody holding the file.
 * Anyone the link is sent to can press N — or open the source — and read the
 * whole playbook, including the parts written about them.
 *
 * So the copy that leaves the building is generated, not edited by hand. Hand
 * editing means two decks that drift, and the one that drifts is the one with
 * the notes still in it.
 *
 * The notes are REMOVED from the markup rather than hidden harder. A hidden
 * element is still in the file.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'pitch.html');
const OUT = path.join(__dirname, 'pitch-share.html');

let html = fs.readFileSync(SRC, 'utf8');

// 1. Every presenter-note block. Non-greedy, and the blocks do not nest.
const before = html.length;
html = html.replace(/[ \t]*<div class="notes">[\s\S]*?<\/div>\n?/g, '');
const removed = before - html.length;

// 2. The button that used to reveal them, and its keyboard shortcut. Leaving
//    either one behind puts a dead control in front of a customer.
html = html.replace(/[ \t]*<button id="ntoggle"[\s\S]*?<\/button>\n?/g, '');
html = html.replace(/[ \t]*document\.getElementById\('ntoggle'\)\.onclick[^\n]*\n/g, '');
html = html.replace(/[ \t]*else if \(e\.key\.toLowerCase\(\) === 'n'\)[^\n]*\n/g, '');

// 3. And the styling that dressed them. Leaving it behind is harmless to look
//    at and loud to read: a stylesheet with a `.notes` panel in it announces
//    that there was one, to exactly the reader who should not be wondering.
html = html.replace(/[ \t]*\/\* ---- presenter notes ---- \*\/[\s\S]*?(?=\n<\/style>)/, '');

// 4. The title says who it is for.
html = html.replace(/<title>[^<]*<\/title>/, '<title>חלום — ניהול הגן</title>');

// A file that still mentions the notes did not get cleaned, and shipping it
// would be worse than not building it at all.
for (const marker of ['class="notes"', 'ntoggle', 'notes-on']) {
  if (html.includes(marker)) {
    console.error(`✗ נותר "${marker}" בקובץ. לא נכתב.`);
    process.exit(1);
  }
}

fs.writeFileSync(OUT, html);
console.log(`✓ ${path.basename(OUT)} — הוסרו ${removed.toLocaleString('he-IL')} תווים של הערות מנחה`);
