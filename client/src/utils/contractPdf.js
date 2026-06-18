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
      pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
    })
    .from(content);

  return { wrapper, worker };
}

async function settle() {
  try {
    if (document.fonts?.ready) await document.fonts.ready;
  } catch {
    /* fonts API unavailable — fall back to the timeout below */
  }
  await new Promise((r) => setTimeout(r, 350));
}

// Render the contract HTML and trigger a PDF download.
export async function renderHtmlToPdf(html, filename) {
  const { wrapper, worker } = mount(html);
  try {
    await settle();
    await worker.set({ filename: filename || 'contract.pdf' }).save();
  } finally {
    document.body.removeChild(wrapper);
  }
}

// Render the contract HTML to a PDF data-URI string (no download) — used to
// upload the signed contract to the server.
export async function renderHtmlToPdfDataUri(html) {
  const { wrapper, worker } = mount(html);
  try {
    await settle();
    return await worker.outputPdf('datauristring');
  } finally {
    document.body.removeChild(wrapper);
  }
}
