import { useCallback, useRef, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, LinearProgress, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { parseQuote, statedSubtotal, toNumber, toProducts } from './dalasQuote';

/**
 * Turning a supplier's price quote into a catalogue.
 *
 * WHY THE READING HAPPENS HERE AND NOT ON THE SERVER. Two reasons, and the
 * second is the real one. A quote's pictures arrive as raw bitmaps that have to
 * be re-encoded before they can be stored, and a browser has an encoder built
 * into every canvas while the server would need a native image library on a
 * 512MB instance that already launches Chromium to print orders. And the whole
 * job — 8 pages, 49 rows, 41 photographs resized — runs on the machine of the
 * one person doing it, once, instead of on the box four gans depend on.
 *
 * NOTHING IS SAVED UNTIL IT HAS BEEN LOOKED AT. The dialog reads the file,
 * shows every row it found with its picture, and says how its own arithmetic
 * compares with the total the document prints for itself. That comparison is
 * the only independent check there is: a parser that drops a row or misreads a
 * price cannot also make the sum come out right. If it disagrees, the import
 * says so and the button still works — the person can see the rows and decide —
 * but it does not pretend.
 */

/** Long enough that a 45-point thumbnail is sharp; small enough to store. */
const THUMB = 240;
const QUALITY = 0.82;

/** Send in batches so a failure names where it stopped, and no one request is huge. */
const BATCH = 10;

let pdfjsPromise = null;
/**
 * pdfjs, fetched the first time somebody actually imports a quote.
 *
 * A static import would put 350KB on the first load of every screen in the app
 * for a job done a few times a year (bundle-budget.test.js fails if it ever
 * does). The worker is pointed at the copy vite emitted rather than at a CDN —
 * the gans' browsers should not need a third party to be up.
 */
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

/** Compose two PDF matrices. An image's box is the current one. */
function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/**
 * A PDF into the plain {items, images} shape dalasQuote.js reads.
 *
 * y is flipped on the way out: PDF counts up from the bottom of the page and a
 * table is read down from the top, and every rule about which row a cell is in
 * is written in reading order.
 */
async function readPages(pdfjs, file, onProgress) {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, disableFontFace: true }).promise;
  const pages = [];

  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();

    const items = tc.items
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({ x: i.transform[4], y: vp.height - i.transform[5], width: i.width, text: i.str }));

    const ops = await page.getOperatorList();
    const images = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let k = 0; k < ops.fnArray.length; k += 1) {
      const fn = ops.fnArray[k];
      if (fn === pdfjs.OPS.save) stack.push(ctm.slice());
      else if (fn === pdfjs.OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === pdfjs.OPS.transform) ctm = mul(ctm, ops.argsArray[k]);
      else if (fn === pdfjs.OPS.paintImageXObject) {
        const w = Math.abs(ctm[0]);
        const h = Math.abs(ctm[3]);
        images.push({ ref: ops.argsArray[k][0], page: n, x: ctm[4], y: vp.height - ctm[5] - h, width: w, height: h });
      }
    }

    pages.push({ page: n, items, images, _page: page });
    onProgress?.(n, doc.numPages);
  }
  return pages;
}

/**
 * One embedded picture, as a JPEG data URI.
 *
 * pdfjs hands back a raw bitmap — bytes and a colour layout, not a file — so it
 * is drawn onto a canvas and the canvas encodes it. Drawn onto WHITE first:
 * these are catalogue shots with transparent corners, and a JPEG has no
 * transparency, so without a ground they come out on black.
 */
async function encodeImage(pages, img) {
  const page = pages.find((p) => p.page === img.page)?._page;
  if (!page) return null;

  const raw = await new Promise((resolve) => {
    try { page.objs.get(img.ref, resolve); } catch { resolve(null); }
  });
  if (!raw?.width || !raw?.height) return null;

  const src = document.createElement('canvas');
  src.width = raw.width;
  src.height = raw.height;
  const sctx = src.getContext('2d');

  let bitmap = raw.bitmap || (raw.data ? null : raw);
  if (bitmap) {
    sctx.drawImage(bitmap, 0, 0);
  } else if (raw.data) {
    // Either RGBA already, or RGB that has to be widened to it.
    const out = sctx.createImageData(raw.width, raw.height);
    const px = raw.width * raw.height;
    if (raw.data.length >= px * 4) {
      out.data.set(raw.data.subarray(0, px * 4));
    } else {
      for (let i = 0, j = 0; i < px; i += 1, j += 3) {
        out.data[i * 4] = raw.data[j];
        out.data[i * 4 + 1] = raw.data[j + 1];
        out.data[i * 4 + 2] = raw.data[j + 2];
        out.data[i * 4 + 3] = 255;
      }
    }
    sctx.putImageData(out, 0, 0);
  } else {
    return null;
  }

  const scale = Math.min(1, THUMB / Math.max(raw.width, raw.height));
  const w = Math.max(1, Math.round(raw.width * scale));
  const h = Math.max(1, Math.round(raw.height * scale));
  const dst = document.createElement('canvas');
  dst.width = THUMB;
  dst.height = THUMB;
  const dctx = dst.getContext('2d');
  // White, and deliberately NOT a theme token. This colour is baked into the
  // stored bytes, so it is the same for every viewer forever — a token would
  // mean a manager importing at night in dark mode gives the whole gan a
  // catalogue of photographs matted onto charcoal.
  dctx.fillStyle = 'white';
  dctx.fillRect(0, 0, THUMB, THUMB);
  dctx.drawImage(src, (THUMB - w) / 2, (THUMB - h) / 2, w, h);
  return dst.toDataURL('image/jpeg', QUALITY);
}

export default function QuoteImportDialog({ open, onClose, supplier, onImported }) {
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const reset = () => { setResult(null); setBusy(''); setProgress(null); };

  const read = useCallback(async (file) => {
    if (!file) return;
    reset();
    setBusy('פותח את הקובץ…');
    try {
      const pdfjs = await loadPdfjs();
      setBusy('קורא את העמודים…');
      const pages = await readPages(pdfjs, file, (n, total) => setProgress({ n, total }));

      const rows = parseQuote(pages);
      if (!rows.length) {
        setBusy('');
        setResult({ error: 'לא נמצאו שורות מוצרים בקובץ הזה. ודא שזו הצעת מחיר של דאלאס.' });
        return;
      }

      setBusy('מכין את התמונות…');
      setProgress(null);
      const cache = new Map();
      const products = await toProducts(rows, async (img) => {
        if (!cache.has(img.ref)) cache.set(img.ref, await encodeImage(pages, img));
        return cache.get(img.ref);
      });

      const stated = statedSubtotal(pages);
      const sum = Math.round(rows.reduce((a, r) => a + toNumber(r.total), 0) * 100) / 100;

      setBusy('');
      setResult({
        fileName: file.name,
        products,
        stated,
        sum,
        // Agrees, or does not. Not "close enough" — this is the whole check.
        matches: stated != null && Math.abs(sum - stated) < 0.01,
        withImage: products.filter((p) => p.image_data).length,
      });
    } catch (err) {
      setBusy('');
      setResult({ error: `לא הצלחתי לקרוא את הקובץ: ${err.message}` });
    }
  }, []);

  const save = async () => {
    if (!result?.products?.length || !supplier) return;
    setSaving(true);
    const id = supplier._id || supplier.id;
    let added = 0;
    let updated = 0;
    try {
      for (let i = 0; i < result.products.length; i += BATCH) {
        const slice = result.products.slice(i, i + BATCH);
        const r = await api.post('/products/import', { supplier_id: id, products: slice });
        added += r.data.count || 0;
        updated += r.data.updated || 0;
        setProgress({ n: Math.min(i + BATCH, result.products.length), total: result.products.length });
      }
      const parts = [];
      if (added) parts.push(`${added} מוצרים נוספו`);
      if (updated) parts.push(`${updated} עודכנו`);
      toast.success(parts.join(' · ') || 'לא היה מה לייבא');
      onImported?.();
      onClose();
      reset();
    } catch (err) {
      toast.error(err.response?.data?.error || 'הייבוא נכשל');
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  const close = () => { if (!saving) { onClose(); reset(); } };

  return (
    <Dialog open={open} onClose={close} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        ייבוא הצעת מחיר
        {supplier && <Typography variant="body2" color="text.secondary">{supplier.name}</Typography>}
      </DialogTitle>

      <DialogContent>
        {!result && !busy && (
          <Box
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); read(e.dataTransfer.files?.[0]); }}
            sx={{
              border: '2px dashed', borderColor: 'divider', borderRadius: 2,
              p: 5, textAlign: 'center', cursor: 'pointer',
              '&:hover': { borderColor: 'primary.main', bgcolor: 'background.sunken' },
            }}
          >
            <UploadFileIcon sx={{ fontSize: 44, color: 'text.disabled', mb: 1 }} />
            <Typography sx={{ fontWeight: 600 }}>גרור לכאן קובץ PDF של הצעת מחיר</Typography>
            <Typography variant="body2" color="text.secondary">או לחץ לבחירת קובץ</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
              הקובץ נקרא כאן במחשב שלך. שום דבר לא נשמר עד שתאשר.
            </Typography>
          </Box>
        )}

        <input
          ref={fileRef} type="file" accept="application/pdf" hidden
          onChange={(e) => { read(e.target.files?.[0]); e.target.value = ''; }}
        />

        {busy && (
          <Box sx={{ py: 5, textAlign: 'center' }}>
            <CircularProgress size={30} />
            <Typography sx={{ mt: 2 }}>{busy}</Typography>
            {progress && (
              <Typography variant="body2" color="text.secondary">
                עמוד {progress.n} מתוך {progress.total}
              </Typography>
            )}
          </Box>
        )}

        {result?.error && <Alert severity="error" sx={{ mt: 1 }}>{result.error}</Alert>}

        {result?.products && (
          <>
            <Alert severity={result.matches ? 'success' : 'warning'} sx={{ mb: 2 }}>
              {result.matches ? (
                <>
                  <b>{result.products.length} מוצרים</b> ({result.withImage} עם תמונה).
                  {' '}סכום השורות שקראתי — <b>{result.sum.toLocaleString('he-IL', { minimumFractionDigits: 2 })} ₪</b> —
                  {' '}זהה לסה״כ שכתוב בקובץ. כלומר לא נשמטה שורה ולא נקרא מחיר שגוי.
                </>
              ) : (
                <>
                  <b>{result.products.length} מוצרים</b> ({result.withImage} עם תמונה).
                  {' '}סכום השורות שקראתי הוא {result.sum.toLocaleString('he-IL', { minimumFractionDigits: 2 })} ₪
                  {result.stated != null
                    ? <> אבל בקובץ כתוב {result.stated.toLocaleString('he-IL', { minimumFractionDigits: 2 })} ₪.</>
                    : <> ולא מצאתי בקובץ סה״כ להשוות אליו.</>}
                  {' '}<b>עבור על הרשימה לפני אישור.</b>
                </>
              )}
            </Alert>

            <TableContainer sx={{ maxHeight: 380 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>תמונה</TableCell>
                    <TableCell>מק״ט</TableCell>
                    <TableCell>שם</TableCell>
                    <TableCell align="center">יח׳ מידה</TableCell>
                    <TableCell align="left">מחיר</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {result.products.map((p) => (
                    <TableRow key={p.sku} hover>
                      <TableCell sx={{ width: 56 }}>
                        {p.image_data ? (
                          <Box component="img" src={p.image_data} alt="" sx={{ width: 40, height: 40, objectFit: 'contain', borderRadius: 1, bgcolor: 'common.white' }} />
                        ) : (
                          <Chip size="small" label="—" variant="outlined" />
                        )}
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>{p.sku}</TableCell>
                      <TableCell>{p.name}</TableCell>
                      <TableCell align="center" sx={{ color: 'text.secondary' }}>{p.unit || '—'}</TableCell>
                      <TableCell align="left" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {p.price_before_vat.toLocaleString('he-IL', { minimumFractionDigits: 2 })} ₪
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
              מוצר שהמק״ט שלו כבר קיים אצל הספק — המחיר, השם והתמונה שלו יתעדכנו. מוצר חדש יתווסף.
              שום מוצר לא יימחק.
            </Typography>

            {saving && progress && (
              <Box sx={{ mt: 2 }}>
                <LinearProgress variant="determinate" value={(progress.n / progress.total) * 100} />
                <Typography variant="caption" color="text.secondary">
                  שומר {progress.n} מתוך {progress.total}
                </Typography>
              </Box>
            )}
          </>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={close} disabled={saving}>ביטול</Button>
        {result?.products && (
          <Button variant="contained" onClick={save} disabled={saving}>
            {saving ? 'שומר…' : `ייבא ${result.products.length} מוצרים`}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
