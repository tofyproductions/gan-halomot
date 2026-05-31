import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box, Paper, Typography, Stack, Table, TableHead, TableRow, TableCell, TableBody,
  TextField, ToggleButton, ToggleButtonGroup, IconButton, Button, Divider,
  Alert, InputAdornment, MenuItem, Select, CircularProgress, Tooltip,
  Dialog, DialogContent, DialogActions,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import AddIcon from '@mui/icons-material/Add';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import VisibilityIcon from '@mui/icons-material/Visibility';
import html2pdf from 'html2pdf.js';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';

// Academic years (Sept–Aug). A new תמ"ת tuition table + services basket arrives
// at the end of August each year, so pricing is stored per year.
const ACADEMIC_YEARS = [
  { value: 'תשפ"ד', start: 2023 },
  { value: 'תשפ"ה', start: 2024 },
  { value: 'תשפ"ו', start: 2025 },
  { value: 'תשפ"ז', start: 2026 },
  { value: 'תשפ"ח', start: 2027 },
  { value: 'תשפ"ט', start: 2028 },
];

function yearLabel(y) {
  return `${y.value} (${y.start}/${String(y.start + 1).slice(2)})`;
}

// The academic year we're currently in (flips in September).
function currentAcademicYear() {
  const now = new Date();
  const startYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  const found = ACADEMIC_YEARS.find(y => y.start === startYear);
  return found ? found.value : ACADEMIC_YEARS[ACADEMIC_YEARS.length - 1].value;
}

// Age columns for the state subsidy matrix (by age in months).
const DEFAULT_AGE_GROUPS = ['עד 15 חודש', '15–24 חודש', 'מעל 24 חודש'];

// Official Ministry of Labor tuition table — מעונות יום תשפ"ו, תקינה מורחבת.
// Each value = the PARENT's share (השתתפות הורים) per age group.
// Full tariff (parent + state): 3,936 / 2,917 / 2,587. Source: tuition-25-me.pdf.
const TMT_5786 = [
  { label: 'דרגה 3 (0–2,330)',      prices: [1157, 938, 941] },
  { label: 'דרגה 4 (2,331–2,880)',  prices: [1401, 1109, 1113] },
  { label: 'דרגה 5 (2,881–3,330)',  prices: [1663, 1318, 1323] },
  { label: 'דרגה 6 (3,331–3,880)',  prices: [1748, 1377, 1382] },
  { label: 'דרגה 7 (3,881–4,440)',  prices: [2011, 1549, 1554] },
  { label: 'דרגה 8 (4,441–4,880)',  prices: [2180, 1703, 1709] },
  { label: 'דרגה 9 (4,881–5,440)',  prices: [2328, 1811, 1817] },
  { label: 'דרגה 10 (5,441–5,880)', prices: [2432, 1908, 1914] },
  { label: 'דרגה 11 (5,881–6,660)', prices: [3936, 2917, 2587] },
  { label: 'דרגה 12 (מעל 6,660)',   prices: [3936, 2917, 2587] },
  { label: 'דרגה 14',               prices: [1054, 835, 837] },
  { label: 'דרגה 15',               prices: [952, 731, 734] },
];

// Official state tables we have on file, keyed by academic year. A year without
// an entry starts from the most recent table as an editable template.
const OFFICIAL_TMT = { 'תשפ"ו': TMT_5786 };

function tiersForYear(year) {
  const t = OFFICIAL_TMT[year] || TMT_5786;
  return t.map(x => ({ label: x.label, prices: [...x.prices] }));
}

const DEFAULT_ADDONS = [
  'חצי שעת הארכה בבוקר',
  'שעת הארכה אחר הצהריים',
  'תפריט תזונתי בשרי',
  'יחס חניכה מורחב',
  'חוגים שכלולים בסל',
  'גאנט עבודה חודשי',
  'לוח עדכונים דיגיטלי להורים בתינוקייה',
];

// Empty pricing shape used when a branch has no doc yet for the given year.
function emptyPricing(year) {
  return {
    pricing_type: 'subsidized',
    fixed_monthly_fee: 0,
    age_groups: [...DEFAULT_AGE_GROUPS],
    tiers: tiersForYear(year),
    addons: DEFAULT_ADDONS.map(label => ({ label, prices: DEFAULT_AGE_GROUPS.map(() => 0), is_active: true })),
    one_time: { insurance: 0, registration: 0 },
    installments: 11,
    notes: '',
  };
}

// Normalize a doc from the server into the editable shape (fill defaults if empty).
function normalize(doc, year) {
  if (!doc) return emptyPricing(year);
  const ageGroups = doc.age_groups?.length ? [...doc.age_groups] : [...DEFAULT_AGE_GROUPS];
  const tiers = (doc.tiers?.length ? doc.tiers : tiersForYear(year))
    .map(t => ({
      label: t.label || '',
      // keep prices index-aligned to ageGroups length
      prices: ageGroups.map((_, i) => Number(t.prices?.[i] ?? 0)),
    }));
  const addonsSrc = doc.addons?.length ? doc.addons : DEFAULT_ADDONS.map(label => ({ label }));
  const addons = addonsSrc.map(a => {
    let prices;
    if (Array.isArray(a.prices)) prices = ageGroups.map((_, i) => Number(a.prices[i] ?? 0));
    else if (a.price != null) prices = ageGroups.map(() => Number(a.price) || 0); // back-compat: single price → all ages
    else prices = ageGroups.map(() => 0);
    return { label: a.label || '', prices, is_active: a.is_active !== false };
  });
  return {
    pricing_type: doc.pricing_type || 'subsidized',
    fixed_monthly_fee: Number(doc.fixed_monthly_fee ?? 0),
    age_groups: ageGroups,
    tiers,
    addons,
    one_time: {
      insurance: Number(doc.one_time?.insurance ?? 0),
      registration: Number(doc.one_time?.registration ?? 0),
    },
    installments: Number(doc.installments ?? 11) || 11,
    notes: doc.notes || '',
  };
}

const shekel = { startAdornment: <InputAdornment position="start">₪</InputAdornment> };

export default function PricingManager() {
  const { branches } = useBranch();
  const [branchId, setBranchId] = useState('');
  const [year, setYear] = useState(currentAcademicYear());
  const [copyYear, setCopyYear] = useState('');
  const [pricing, setPricing] = useState(emptyPricing(currentAcademicYear()));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Pick a real branch (never the 'all' pseudo-branch) once branches load.
  useEffect(() => {
    if (!branchId && branches.length) setBranchId(branches[0]._id || branches[0].id);
  }, [branches, branchId]);

  const load = useCallback((id, yr) => {
    if (!id) return;
    setLoading(true);
    api.get(`/branch-pricing/${id}`, { params: { year: yr } })
      .then(res => { setPricing(normalize(res.data.pricing, yr)); setDirty(false); })
      .catch(err => { console.error(err); toast.error('שגיאה בטעינת המחירים'); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (branchId) load(branchId, year); }, [branchId, year, load]);

  const patch = (changes) => { setPricing(p => ({ ...p, ...changes })); setDirty(true); };

  const save = () => {
    setSaving(true);
    api.put(`/branch-pricing/${branchId}`, { ...pricing, academic_year: year })
      .then(() => { toast.success(`המחירים נשמרו (${year})`); setDirty(false); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בשמירה'))
      .finally(() => setSaving(false));
  };

  // Pull another year's saved pricing into the editor (does not save until "שמירה").
  const copyFromYear = () => {
    if (!copyYear || copyYear === year) return;
    api.get(`/branch-pricing/${branchId}`, { params: { year: copyYear } })
      .then(res => {
        if (!res.data.pricing) return toast.info(`אין מחירון שמור לשנת ${copyYear}`);
        setPricing(normalize(res.data.pricing, year));
        setDirty(true);
        toast.success(`הועתק מ-${copyYear} — בדוק ושמור`);
      })
      .catch(() => toast.error('שגיאה בשכפול'));
  };

  // Upload the official תמ"ת PDF; the server returns a verified tier×age matrix
  // (only cells confirmed by parent+government=tariff). Load it for review.
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const uploadTmt = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    api.post('/branch-pricing/parse-tmt-pdf', form)
      .then(res => {
        const { tiers, age_groups, columns } = res.data;
        patch({
          age_groups: [...age_groups],
          tiers: tiers.map(t => ({ label: t.label, prices: t.prices.map(v => (v == null ? 0 : v)) })),
        });
        const ok = (columns || []).filter(c => c.complete).map(c => c.age_group);
        const partial = (columns || []).filter(c => !c.complete).map(c => c.age_group);
        if (partial.length) {
          toast.warning(`נטען מ-PDF. זוהו במלואן: ${ok.join(', ') || 'אין'}. השלם ידנית: ${partial.join(', ')}`);
        } else {
          toast.success('טבלת התמ"ת נטענה ואומתה במלואה — בדוק ושמור');
        }
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בקריאת ה-PDF'))
      .finally(() => setUploading(false));
  };

  // --- subsidized matrix editing (index-aligned) ---
  const setCell = (tierIdx, agIdx, value) => {
    const tiers = pricing.tiers.map((t, i) =>
      i === tierIdx ? { ...t, prices: t.prices.map((p, j) => (j === agIdx ? value : p)) } : t);
    patch({ tiers });
  };
  const setTierLabel = (tierIdx, label) =>
    patch({ tiers: pricing.tiers.map((t, i) => (i === tierIdx ? { ...t, label } : t)) });
  const addTier = () =>
    patch({ tiers: [...pricing.tiers, { label: '', prices: pricing.age_groups.map(() => 0) }] });
  const removeTier = (tierIdx) =>
    patch({ tiers: pricing.tiers.filter((_, i) => i !== tierIdx) });

  const setAgeGroup = (agIdx, label) =>
    patch({ age_groups: pricing.age_groups.map((g, i) => (i === agIdx ? label : g)) });
  const addAgeGroup = () =>
    patch({
      age_groups: [...pricing.age_groups, ''],
      tiers: pricing.tiers.map(t => ({ ...t, prices: [...t.prices, 0] })),
      addons: pricing.addons.map(a => ({ ...a, prices: [...a.prices, 0] })),
    });
  const removeAgeGroup = (agIdx) =>
    patch({
      age_groups: pricing.age_groups.filter((_, i) => i !== agIdx),
      tiers: pricing.tiers.map(t => ({ ...t, prices: t.prices.filter((_, j) => j !== agIdx) })),
      addons: pricing.addons.map(a => ({ ...a, prices: a.prices.filter((_, j) => j !== agIdx) })),
    });

  // --- add-ons (price per age group, index-aligned to age_groups) ---
  const setAddonLabel = (idx, label) =>
    patch({ addons: pricing.addons.map((a, i) => (i === idx ? { ...a, label } : a)) });
  const setAddonPrice = (idx, agIdx, value) =>
    patch({ addons: pricing.addons.map((a, i) =>
      i === idx ? { ...a, prices: a.prices.map((p, j) => (j === agIdx ? value : p)) } : a) });
  const addAddon = () =>
    patch({ addons: [...pricing.addons, { label: '', prices: pricing.age_groups.map(() => 0), is_active: true }] });
  const removeAddon = (idx) => patch({ addons: pricing.addons.filter((_, i) => i !== idx) });

  const isPrivate = pricing.pricing_type === 'private';

  // --- summary computations (what a parent actually pays) ---
  const fmt = (n) => `₪${Math.round(Number(n) || 0).toLocaleString('he-IL')}`;
  // Services basket total per age group (sum of active add-ons for that age).
  const basketByAge = pricing.age_groups.map((_, ai) =>
    pricing.addons
      .filter(a => a.is_active !== false)
      .reduce((sum, a) => sum + (Number(a.prices?.[ai]) || 0), 0));
  const installments = Number(pricing.installments) || 11;
  const insurance = Number(pricing.one_time?.insurance) || 0;
  const registration = Number(pricing.one_time?.registration) || 0;
  const branchName = branches.find(b => (b._id || b.id) === branchId)?.name || '';
  // Full state tariff per age = the highest tier's parent share (= no subsidy).
  // A parent with no subsidy eligibility pays this base + the services basket.
  const fullTariffByAge = pricing.age_groups.map((_, ai) =>
    pricing.tiers.reduce((max, t) => Math.max(max, Number(t.prices[ai]) || 0), 0));

  // The running monthly payment for a (tier,age): full monthly spread over the
  // installments. monthly × 12 / installments (e.g. 11) → HIGHER than monthly,
  // because August is prepaid and spread across the year.
  const installmentOf = (monthly) => (installments > 0 ? (monthly * 12) / installments : monthly);
  const monthlyOf = (tier, ai) => (Number(tier.prices[ai]) || 0) + basketByAge[ai];

  // --- parent-facing printable price sheet (downloaded as PDF) ---
  const ils = (n) => '₪' + Math.round(Number(n) || 0).toLocaleString('he-IL');
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const buildSheetHtml = () => {
    const ag = pricing.age_groups;
    const head = `
      <div style="text-align:center;margin-bottom:14px">
        <div style="font-size:22px;font-weight:800;color:#b45309">גן החלומות</div>
        <div style="font-size:18px;font-weight:700;margin-top:2px">מחירון תשלומים להורים — ${esc(branchName)}</div>
        <div style="font-size:14px;color:#555">שנת הלימודים ${esc(year)}</div>
      </div>`;
    if (isPrivate) {
      return `<div style="font-family:Arial,Heebo,sans-serif;direction:rtl">${head}
        <div style="font-size:18px;text-align:center;padding:18px;border:2px solid #f0c674;border-radius:10px">
          מחיר חודשי קבוע: <b>${ils(pricing.fixed_monthly_fee)}</b>
        </div></div>`;
    }
    const th = (txt, bg = '#fde9c8') => `<th style="border:1px solid #ccc;padding:8px;background:${bg}">${esc(txt)}</th>`;
    const headerCells = ag.map(g => th(g)).join('');

    // 1) Services basket — itemized by product, then a basket subtotal.
    const activeAddons = pricing.addons.filter(a => a.is_active !== false);
    const addonRows = activeAddons.map(a => {
      const cells = ag.map((_, ai) =>
        `<td style="border:1px solid #ccc;padding:7px;text-align:center">${ils(a.prices?.[ai] || 0)}</td>`).join('');
      return `<tr><td style="border:1px solid #ccc;padding:7px">${esc(a.label || '—')}</td>${cells}</tr>`;
    }).join('');
    const basketSubtotal = `<tr style="font-weight:800;background:#fff4e0">
      <td style="border:1px solid #ccc;padding:8px">סך סל השירותים (חודשי)</td>
      ${ag.map((_, ai) => `<td style="border:1px solid #ccc;padding:8px;text-align:center">${ils(basketByAge[ai])}</td>`).join('')}
    </tr>`;
    const basketTable = activeAddons.length ? `
      <div style="font-size:16px;font-weight:800;margin:14px 0 6px">סל השירותים — פירוט</div>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <thead><tr>${th('פריט')}${headerCells}</tr></thead>
        <tbody>${addonRows}${basketSubtotal}</tbody>
      </table>` : '';

    // 2) Grand total per tier × age: bold = full monthly tariff, below = split.
    const totalRows = pricing.tiers.map(t => {
      const cells = ag.map((_, ai) => {
        const monthly = monthlyOf(t, ai);
        const per = installmentOf(monthly);
        return `<td style="border:1px solid #ccc;padding:7px;text-align:center">
          <div style="font-weight:800;font-size:15px">${ils(monthly)}</div>
          <div style="font-size:11px;color:#666">פריסה ל-${installments}: ${ils(per)}</div></td>`;
      }).join('');
      return `<tr><td style="border:1px solid #ccc;padding:7px;background:#fafafa">${esc(t.label)}</td>${cells}</tr>`;
    }).join('');
    // No-subsidy parent — pays the full tariff (highlighted).
    const noSubsidyRow = `<tr style="background:#fff4e0">
      <td style="border:1px solid #ccc;padding:7px;font-weight:800">ללא זכאות לסבסוד (תעריף מלא)</td>
      ${ag.map((_, ai) => {
        const monthly = fullTariffByAge[ai] + basketByAge[ai];
        return `<td style="border:1px solid #ccc;padding:7px;text-align:center">
          <div style="font-weight:800;font-size:15px">${ils(monthly)}</div>
          <div style="font-size:11px;color:#666">פריסה ל-${installments}: ${ils(installmentOf(monthly))}</div></td>`;
      }).join('')}
    </tr>`;

    return `<div style="font-family:Arial,Heebo,sans-serif;direction:rtl;color:#222">${head}
      ${basketTable}
      <div style="font-size:16px;font-weight:800;margin:16px 0 6px">סיכום כללי — תשלום לפי דרגת סבסוד</div>
      <p style="font-size:12px;color:#555;margin:0 0 6px">
        בכל תא: התעריף החודשי המלא (תמ"ת + סל שירותים) ומתחתיו התשלום בפועל בפריסה ל-${installments} תשלומים
        (החודשי × 12 ÷ ${installments}; חודש אוגוסט משולם מראש ונפרס על פני השנה).
      </p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead><tr>${th('דרגת סבסוד (הכנסה לנפש)')}${headerCells}</tr></thead>
        <tbody>${totalRows}${noSubsidyRow}</tbody>
      </table>
      <div style="margin-top:14px;font-size:13px;line-height:1.9;border:1px solid #eee;border-radius:8px;padding:10px;background:#fcfcfc">
        <div>💳 <b>דמי רישום: ${ils(registration)}</b> — נגבים מראש בכרטיס אשראי לפני הכניסה לגן (חד-פעמי).</div>
        <div>🛡️ <b>ביטוח: ${ils(insurance)}</b> — מתווסף לתשלום הראשון בלבד (תשלום ראשון = החודשי + ${ils(insurance)}).</div>
      </div>
      <div style="margin-top:10px;font-size:11px;color:#999;text-align:center">הופק ממערכת ניהול גן החלומות · ${esc(year)}</div>
    </div>`;
  };

  const downloadSheet = async () => {
    setDownloading(true);
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.right = '-10000px';
    container.style.top = '0';
    container.style.width = '800px';
    container.dir = 'rtl';
    container.innerHTML = buildSheetHtml();
    document.body.appendChild(container);
    try {
      await new Promise(r => setTimeout(r, 200));
      await html2pdf().set({
        margin: [10, 10, 10, 10],
        filename: `מחירון ${branchName} ${year}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
      }).from(container).save();
    } catch (e) {
      console.error(e); toast.error('שגיאה בהורדת המחירון');
    } finally {
      document.body.removeChild(container);
      setDownloading(false);
    }
  };

  return (
    <Box dir="rtl" sx={{ maxWidth: 1100, mx: 'auto', pb: 6 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>מחירי המעונות</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <Select size="small" value={year} onChange={e => setYear(e.target.value)} sx={{ minWidth: 150 }}>
            {ACADEMIC_YEARS.map(y => (
              <MenuItem key={y.value} value={y.value}>{yearLabel(y)}</MenuItem>
            ))}
          </Select>
          <Select size="small" value={branchId} onChange={e => setBranchId(e.target.value)} sx={{ minWidth: 220 }}>
            {branches.map(b => (
              <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
            ))}
          </Select>
          <Button
            variant="outlined"
            startIcon={<VisibilityIcon />}
            onClick={() => setPreviewOpen(true)}
            disabled={loading || !branchId}
          >
            תצוגה להורים
          </Button>
          <Button
            variant="contained"
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            onClick={save}
            disabled={saving || loading || !branchId}
          >
            שמירה
          </Button>
        </Stack>
      </Stack>

      {dirty && <Alert severity="info" sx={{ mb: 2 }}>יש שינויים שלא נשמרו.</Alert>}

      {/* Copy a previous year's pricing as a starting point for this year. */}
      <Paper variant="outlined" sx={{ borderRadius: 3, p: 1.5, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            מחירון לשנת {year}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">שכפל מחירון משנה:</Typography>
          <Select
            size="small" value={copyYear} displayEmpty
            onChange={e => setCopyYear(e.target.value)} sx={{ minWidth: 130 }}
          >
            <MenuItem value=""><em>בחר שנה</em></MenuItem>
            {ACADEMIC_YEARS.filter(y => y.value !== year).map(y => (
              <MenuItem key={y.value} value={y.value}>{y.value}</MenuItem>
            ))}
          </Select>
          <Button size="small" variant="outlined" onClick={copyFromYear} disabled={!copyYear}>
            שכפל
          </Button>
        </Stack>
      </Paper>

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
      ) : (
        <>
          {/* Branch type */}
          <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>סוג המעון</Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={pricing.pricing_type}
              onChange={(_, v) => v && patch({ pricing_type: v })}
            >
              <ToggleButton value="subsidized">מעון סמל (מסובסד ע"י התמ"ת)</ToggleButton>
              <ToggleButton value="private">מעון פרטי (מחיר אחיד)</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {isPrivate
                ? 'מחיר אחיד וקבוע הכולל את כל השירות, ללא משתנים.'
                : 'מחיר הבסיס נקבע ע"י המדינה לפי דרגת סבסוד וקבוצת גיל. מעליו מתווספות תוספות וחיובים חד-פעמיים.'}
            </Typography>
          </Paper>

          {/* Private: single fixed fee */}
          {isPrivate && (
            <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>מחיר חודשי קבוע</Typography>
              <TextField
                type="number"
                size="small"
                label="מחיר להורה לחודש"
                value={pricing.fixed_monthly_fee}
                onChange={e => patch({ fixed_monthly_fee: Number(e.target.value) })}
                InputProps={shekel}
                sx={{ width: 240 }}
              />
            </Paper>
          )}

          {/* Subsidized: state price matrix */}
          {!isPrivate && (
            <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 800 }}>מחיר בסיס (גרף המדינה)</Typography>
                  <Typography variant="caption" color="text.secondary">
                    שורה = דרגת סבסוד, עמודה = קבוצת גיל. הזן את המחיר שההורה משלם בכל תא.
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    style={{ display: 'none' }}
                    onChange={uploadTmt}
                  />
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={uploading ? <CircularProgress size={14} /> : <UploadFileIcon />}
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                  >
                    טען מ-PDF
                  </Button>
                  <Button size="small" startIcon={<AddIcon />} onClick={addAgeGroup}>הוסף קבוצת גיל</Button>
                </Stack>
              </Stack>

              {!OFFICIAL_TMT[year] && (
                <Alert severity="warning" sx={{ mb: 1.5 }}>
                  אין טבלת תמ"ת רשמית טעונה לשנת {year}. המספרים מבוססים על תשפ"ו כתבנית — עדכן אותם לפי מחירון התמ"ת החדש.
                </Alert>
              )}

              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700, minWidth: 140 }}>דרגת סבסוד</TableCell>
                      {pricing.age_groups.map((ag, agIdx) => (
                        <TableCell key={agIdx} align="center" sx={{ minWidth: 150 }}>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <TextField
                              size="small" variant="standard" value={ag}
                              placeholder="קבוצת גיל"
                              onChange={e => setAgeGroup(agIdx, e.target.value)}
                              fullWidth
                            />
                            <Tooltip title="מחק קבוצת גיל">
                              <IconButton size="small" color="error" onClick={() => removeAgeGroup(agIdx)}>
                                <DeleteIcon fontSize="inherit" />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        </TableCell>
                      ))}
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {pricing.tiers.map((tier, tierIdx) => (
                      <TableRow key={tierIdx}>
                        <TableCell>
                          <TextField
                            size="small" variant="standard" value={tier.label}
                            placeholder="שם דרגה"
                            onChange={e => setTierLabel(tierIdx, e.target.value)}
                            fullWidth
                          />
                        </TableCell>
                        {pricing.age_groups.map((_, agIdx) => (
                          <TableCell key={agIdx} align="center">
                            <TextField
                              size="small" type="number" variant="standard"
                              value={tier.prices[agIdx] ?? 0}
                              onChange={e => setCell(tierIdx, agIdx, Number(e.target.value))}
                              sx={{ width: 110 }}
                            />
                          </TableCell>
                        ))}
                        <TableCell align="left">
                          <IconButton size="small" color="error" onClick={() => removeTier(tierIdx)}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                    {pricing.tiers.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={pricing.age_groups.length + 2} align="center" sx={{ color: 'text.disabled' }}>
                          אין דרגות מוגדרות
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </Box>
              <Button size="small" startIcon={<AddIcon />} onClick={addTier} sx={{ mt: 1 }}>הוסף דרגה</Button>
            </Paper>
          )}

          {/* Subsidized: add-ons (price per age group) */}
          {!isPrivate && (
            <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 800, mb: 0.5 }}>תוספות (חודשי, לפי גיל)</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                לכל תוספת אפשר להזין מחיר שונה לכל קבוצת גיל. השאר 0 אם התוספת לא רלוונטית לגיל מסוים.
              </Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700, minWidth: 180 }}>תוספת</TableCell>
                      {pricing.age_groups.map((ag, i) => (
                        <TableCell key={i} align="center" sx={{ fontWeight: 700, minWidth: 110 }}>{ag || `גיל ${i + 1}`}</TableCell>
                      ))}
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {pricing.addons.map((a, idx) => (
                      <TableRow key={idx}>
                        <TableCell>
                          <TextField
                            size="small" variant="standard" value={a.label}
                            placeholder="שם תוספת"
                            onChange={e => setAddonLabel(idx, e.target.value)}
                            fullWidth
                          />
                        </TableCell>
                        {pricing.age_groups.map((_, ai) => (
                          <TableCell key={ai} align="center">
                            <TextField
                              size="small" type="number" variant="standard"
                              value={a.prices[ai] ?? 0}
                              onChange={e => setAddonPrice(idx, ai, Number(e.target.value))}
                              sx={{ width: 90 }}
                            />
                          </TableCell>
                        ))}
                        <TableCell align="left">
                          <IconButton size="small" color="error" onClick={() => removeAddon(idx)}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                    {pricing.addons.length === 0 && (
                      <TableRow><TableCell colSpan={pricing.age_groups.length + 2} align="center" sx={{ color: 'text.disabled' }}>אין תוספות</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </Box>
              <Button size="small" startIcon={<AddIcon />} onClick={addAddon} sx={{ mt: 1 }}>הוסף תוספת</Button>
            </Paper>
          )}

          {/* One-time fees + payment plan */}
          {!isPrivate && (
            <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>חד-פעמי ופריסת תשלומים</Typography>
              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="flex-start">
                <TextField
                  type="number" size="small" label="ביטוח"
                  helperText="מתווסף לתשלום הראשון"
                  value={pricing.one_time.insurance}
                  onChange={e => patch({ one_time: { ...pricing.one_time, insurance: Number(e.target.value) } })}
                  InputProps={shekel} sx={{ width: 200 }}
                />
                <TextField
                  type="number" size="small" label="דמי רישום"
                  helperText="נגבה מראש בכרטיס אשראי"
                  value={pricing.one_time.registration}
                  onChange={e => patch({ one_time: { ...pricing.one_time, registration: Number(e.target.value) } })}
                  InputProps={shekel} sx={{ width: 200 }}
                />
                <TextField
                  type="number" size="small" label="מספר תשלומים"
                  helperText="חודשי×12÷מס׳ תשלומים"
                  value={pricing.installments}
                  onChange={e => patch({ installments: Number(e.target.value) })}
                  sx={{ width: 160 }}
                />
              </Stack>
            </Paper>
          )}

          {/* Notes */}
          <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>הערות</Typography>
            <TextField
              size="small" multiline minRows={2} fullWidth
              value={pricing.notes}
              onChange={e => patch({ notes: e.target.value })}
              placeholder="הערות פנימיות על המחירון"
            />
          </Paper>

          {/* Summary — what a parent actually pays */}
          <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2, bgcolor: 'action.hover' }}>
            <Typography variant="h6" sx={{ fontWeight: 800, mb: 0.5 }}>סיכום — תשלום חודשי להורה</Typography>

            {isPrivate ? (
              <Typography variant="body1" sx={{ fontWeight: 700 }}>
                מחיר חודשי קבוע: {fmt(pricing.fixed_monthly_fee)}
              </Typography>
            ) : (
              <>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                  המספר המודגש = התעריף החודשי המלא (תמ"ת לפי דרגה וגיל + סל שירותים). מתחת — התשלום בפועל בפריסה ל-{installments} תשלומים = החודשי × 12 ÷ {installments} (גבוה מהחודשי כי אוגוסט נפרס על השנה).
                </Typography>
                <Box sx={{ overflowX: 'auto' }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700 }}>דרגת סבסוד</TableCell>
                        {pricing.age_groups.map((ag, i) => (
                          <TableCell key={i} align="center" sx={{ fontWeight: 700, minWidth: 130 }}>{ag || `גיל ${i + 1}`}</TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {pricing.tiers.map((tier, ti) => (
                        <TableRow key={ti} hover>
                          <TableCell>{tier.label || `דרגה ${ti + 1}`}</TableCell>
                          {pricing.age_groups.map((_, ai) => {
                            const monthly = monthlyOf(tier, ai);
                            const perPayment = installmentOf(monthly);
                            return (
                              <TableCell key={ai} align="center">
                                <Typography variant="body2" sx={{ fontWeight: 700 }}>{fmt(monthly)}</Typography>
                                <Typography variant="caption" color="text.secondary">
                                  פריסה ל-{installments}: {fmt(perPayment)}
                                </Typography>
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))}
                      {/* No-subsidy parent — pays the full tariff */}
                      <TableRow sx={{ bgcolor: 'warning.light' }}>
                        <TableCell sx={{ fontWeight: 800 }}>ללא זכאות לסבסוד (תעריף מלא)</TableCell>
                        {pricing.age_groups.map((_, ai) => {
                          const monthly = fullTariffByAge[ai] + basketByAge[ai];
                          return (
                            <TableCell key={ai} align="center">
                              <Typography variant="body2" sx={{ fontWeight: 800 }}>{fmt(monthly)}</Typography>
                              <Typography variant="caption" color="text.secondary">
                                פריסה ל-{installments}: {fmt(installmentOf(monthly))}
                              </Typography>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    </TableBody>
                  </Table>
                </Box>

                <Divider sx={{ my: 1.5 }} />
                <Stack spacing={0.5}>
                  <Typography variant="body2">
                    💳 <b>דמי רישום: {fmt(registration)}</b> — נגבים מראש בכרטיס אשראי, לפני הכניסה לגן (חד-פעמי, לא נכלל בתשלום החודשי).
                  </Typography>
                  <Typography variant="body2">
                    🛡️ <b>ביטוח: {fmt(insurance)}</b> — מתווסף לתשלום הראשון בלבד. כלומר התשלום הראשון = התשלום החודשי + {fmt(insurance)}.
                  </Typography>
                </Stack>
              </>
            )}
          </Paper>

          <Divider sx={{ my: 2 }} />
          <Stack direction="row" justifyContent="flex-end">
            <Button
              variant="contained"
              startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
              onClick={save}
              disabled={saving || loading || !branchId}
            >
              שמירה
            </Button>
          </Stack>
        </>
      )}

      {/* Parent-facing price sheet — preview + download as PDF */}
      <Dialog open={previewOpen} onClose={() => setPreviewOpen(false)} maxWidth="md" fullWidth dir="rtl">
        <DialogContent>
          <Box sx={{ bgcolor: '#fff', p: 1 }} dangerouslySetInnerHTML={{ __html: buildSheetHtml() }} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setPreviewOpen(false)}>סגור</Button>
          <Button
            variant="contained"
            startIcon={downloading ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
            onClick={downloadSheet}
            disabled={downloading}
          >
            הורד PDF
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
