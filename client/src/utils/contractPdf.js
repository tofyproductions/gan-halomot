import html2pdf from 'html2pdf.js';

// Client-side contract → PDF rendering. The server has no HTML→PDF engine, so
// the contract (a full HTML document with an embedded <style> block) is
// rasterized here with html2pdf/html2canvas.
//
// BLANK-PAGE GOTCHA: html2pdf clones the node handed to .from(). If THAT node
// carries an off-screen offset (e.g. position:fixed; right:-10000px), the clone
// lands outside html2canvas's capture box and the PDF comes out blank. So the
// off-screen positioning lives on an OUTER wrapper, and the inner node we pass
// to html2pdf has no positioning. We also force a white background (a
// transparent canvas flattened to JPEG can render blank/black) and wait for
// fonts before rasterizing.
function mount(html) {
  const wrapper = document.createElement('div');
  Object.assign(wrapper.style, {
    position: 'absolute',
    left: '-10000px',
    top: '0',
    width: '900px',
    background: '#ffffff',
  });
  const content = document.createElement('div');
  content.dir = 'rtl';
  content.style.background = '#ffffff';
  content.innerHTML = html;
  wrapper.appendChild(content);
  document.body.appendChild(wrapper);

  const worker = html2pdf()
    .set({
      margin: [10, 10, 10, 10],
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, allowTaint: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      // NOTE: no 'avoid-all' — it bumps any block that would straddle a page
      // boundary wholesale to the next page, leaving large white gaps. 'css' +
      // 'legacy' slices the rendered canvas at the page height instead.
      pagebreak: { mode: ['css', 'legacy'] },
    })
    .from(content);

  return { wrapper, content, worker };
}

// Open the contract in a hidden iframe and trigger the browser's NATIVE print
// dialog ("Save as PDF"). The browser paginates the full HTML document itself —
// real text (selectable, sharp), correct RTL list numbering, honored @page
// margins, no mid-line cuts, and the signature <img> rendered natively. This is
// far more reliable than html2canvas rasterization. Downside: the user picks
// "Save as PDF" in the dialog instead of a silent download.
export async function printContractHtml(html) {
  const iframe = document.createElement('iframe');
  Object.assign(iframe.style, {
    position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0',
  });
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const doc = win.document;
  doc.open();
  doc.write(html);
  doc.close();

  // Wait for the document to load, fonts to be ready, and every image
  // (signature + logo data-URIs) to decode before opening the print dialog.
  await new Promise((resolve) => {
    let done = false;
    const ready = () => { if (!done) { done = true; resolve(); } };
    if (doc.readyState === 'complete') ready();
    win.addEventListener('load', ready, { once: true });
    setTimeout(ready, 2000); // fallback
  });
  try { if (doc.fonts?.ready) await doc.fonts.ready; } catch { /* noop */ }
  const imgs = Array.from(doc.querySelectorAll('img'));
  await Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return null;
    return new Promise((res) => {
      img.addEventListener('load', res, { once: true });
      img.addEventListener('error', res, { once: true });
    });
  }));

  // The "Save as PDF" default filename comes from the TAB's title, not the
  // hidden iframe's — so borrow the contract's own <title> ("שם הילד - חוזה -
  // שנה") for the duration of the dialog and put the app's title back after.
  const appTitle = document.title;
  const contractTitle = doc.title || appTitle;

  const cleanup = () => setTimeout(() => {
    document.title = appTitle;
    try { document.body.removeChild(iframe); } catch { /* already gone */ }
  }, 500);
  win.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(cleanup, 120000); // hard fallback if afterprint never fires

  document.title = contractTitle;
  win.focus();
  win.print();
}

async function settle(content) {
  try {
    if (document.fonts?.ready) await document.fonts.ready;
  } catch {
    /* fonts API unavailable — fall back to the timeout below */
  }
  // Wait for every <img> (logo + the parent's signature data-URI) to finish
  // decoding — html2canvas captures un-loaded images as blank, which is why the
  // signature was missing from the PDF.
  const imgs = Array.from(content.querySelectorAll('img'));
  await Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return null;
    return new Promise((res) => {
      img.addEventListener('load', res, { once: true });
      img.addEventListener('error', res, { once: true });
    });
  }));
  await new Promise((r) => setTimeout(r, 200));
}

// Render the contract HTML and trigger a PDF download.
export async function renderHtmlToPdf(html, filename) {
  const { wrapper, content, worker } = mount(html);
  try {
    await settle(content);
    await worker.set({ filename: filename || 'contract.pdf' }).save();
  } finally {
    document.body.removeChild(wrapper);
  }
}

// Render the contract HTML to a PDF data-URI string (no download) — used to
// upload the signed contract to the server.
export async function renderHtmlToPdfDataUri(html) {
  const { wrapper, content, worker } = mount(html);
  try {
    await settle(content);
    return await worker.outputPdf('datauristring');
  } finally {
    document.body.removeChild(wrapper);
  }
}
