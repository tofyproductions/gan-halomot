/**
 * Several documents → one PDF, in the browser.
 *
 * The file cabinet already fetches every document through the endpoint that
 * owns it, with that endpoint's permissions. Merging on the server would mean
 * a seventh place that knows how to read six stores; merging here means the
 * bytes the person could already download are stapled together, and nothing
 * else changes. pdf-lib is loaded on first use — it is ~300KB and most visits
 * never merge anything.
 *
 * PDFs are appended page by page. A JPEG or PNG (a photographed sick note, a
 * scanned ת"ז) becomes a page of its own, fitted to A4. Anything else is
 * reported back as skipped, by name, so the person knows what is missing from
 * the bundle rather than discovering it at the ministry.
 */
const A4 = { w: 595.28, h: 841.89 };

/**
 * @param {Array<{ blob: Blob, name: string }>} parts  in the order they should appear
 * @returns {Promise<{ blob: Blob, pages: number, skipped: string[] }>}
 */
export async function mergePdfs(parts) {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  const skipped = [];

  for (const part of parts) {
    const type = (part.blob.type || '').toLowerCase();
    const bytes = new Uint8Array(await part.blob.arrayBuffer());
    try {
      if (type.includes('pdf') || looksLikePdf(bytes)) {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(p => out.addPage(p));
      } else if (type.includes('jpeg') || type.includes('jpg') || type.includes('png')) {
        const img = type.includes('png') ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        const page = out.addPage([A4.w, A4.h]);
        const margin = 36;
        const scale = Math.min((A4.w - 2 * margin) / img.width, (A4.h - 2 * margin) / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: (A4.w - w) / 2, y: (A4.h - h) / 2, width: w, height: h });
      } else {
        skipped.push(part.name);
      }
    } catch {
      skipped.push(part.name);
    }
  }

  const merged = await out.save();
  return { blob: new Blob([merged], { type: 'application/pdf' }), pages: out.getPageCount(), skipped };
}

function looksLikePdf(bytes) {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

/** Hand a blob to the browser as a download. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
