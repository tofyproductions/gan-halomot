import { useState } from 'react';
import { toast } from 'react-toastify';
import { Box, Stack, Typography, Paper, Alert } from '@mui/material';
import api, { apiError } from '../../api/client';
import EmptyState from '../ui/EmptyState';
import { BusyButton, FilePickButton } from '../shared/UploadControls';
import { formatILS, formatDay, ymLabel, useLoad, LoadGate, Section, ResponsiveTable } from './incomeUi';

const INCOME_FIELDS = [
  ['system', 'גבייה מהמערכת'], ['parents', 'העברת הורים'], ['refunds', 'החזרים להורים'],
  ['government', 'תשלומי ממשלה'], ['welfare', 'תשלומי רווחה'],
];
const SUMMARY_FIELDS = [['income', 'הכנסות'], ['expenses', 'הוצאות'], ['paid', 'תשלומים ששולמו'], ['balance', 'יתרה שאמונה חייבת']];

/** null (an "X" or empty cell) stays a dash — never shown as 0. */
const money = (v) => (v == null ? '—' : formatILS(v));
const rowTotal = (m) => {
  const vals = INCOME_FIELDS.map(([k]) => m[k]).filter(v => v != null);
  return vals.length ? vals.reduce((s, v) => s + v, 0) : null;
};

function Upload({ onDone }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const upload = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/income/emunah/import', { file_data: file.data, file_name: file.name });
      const s = data.statement || {};
      toast.success(`התחשיב נקלט${s.academic_year_label ? ` (${s.academic_year_label})` : ''} · ${(s.branches || []).length} סניפים · ${(s.payments || []).length} תשלומים`);
      setFile(null);
      onDone();
    } catch (err) { toast.error(apiError(err, 'הקליטה נכשלה')); }
    finally { setBusy(false); }
  };
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.5 }}>📥 קליטת תחשיב מאמונה</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        קובץ האקסל שאמונה שולחת פעם בחודש ("תחשיב … גן החלומות"). כל העלאה נשמרת כגרסה, והאחרונה מוצגת.
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
        <FilePickButton accept=".xlsx,.xls" label="בחירת קובץ" hasFile={!!file} maxSizeMB={10} onPick={setFile} onError={(m) => toast.error(m)} disabled={busy} />
        <BusyButton variant="contained" loading={busy} loadingText="קולט…" disabled={!file} onClick={upload}>קליטה</BusyButton>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>{file ? `קובץ: ${file.name}` : 'כדי לקלוט: בחרו קובץ'}</Typography>
    </Paper>
  );
}

function BranchBlock({ b }) {
  const columns = [
    { key: 'month_label', label: 'חודש', title: true },
    ...INCOME_FIELDS.map(([k, label]) => ({ key: k, label, render: r => money(r[k]) })),
    { key: '__total', label: 'סה״כ לחודש', render: r => <strong>{money(r.__total)}</strong> },
  ];
  const rows = (b.months || []).map((m, i) => ({ ...m, __i: i, __total: rowTotal(m) }));
  const t = b.totals || {};
  const hasTotals = INCOME_FIELDS.some(([k]) => t[k] != null);
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {b.name}{!b.branch_id && <Typography component="span" variant="caption" sx={{ color: 'warning.dark' }}> · לא זוהה כסניף במערכת</Typography>}
      </Typography>
      {!rows.length ? <Typography variant="body2" color="text.secondary">אין חודשים בגוש הזה.</Typography> : (
        <ResponsiveTable columns={columns} rows={rows} rowKey={r => r.__i} cardTitle={r => r.month_label || '—'}
          footer={hasTotals ? { month_label: 'סה״כ', ...t, __total: rowTotal(t) } : null} />
      )}
    </Box>
  );
}

function Balance({ summary, recomputed }) {
  const rows = SUMMARY_FIELDS.map(([k, label]) => {
    const file = summary?.[k];
    const calc = recomputed?.[k];
    const diff = file == null || calc == null ? null : Math.round((calc - file) * 100) / 100;
    return { k, label, file, calc, diff };
  });
  const off = rows.some(r => r.diff != null && Math.abs(r.diff) > 1);
  return (
    <>
      {off && <Alert severity="warning" sx={{ mb: 1 }}>החישוב מחדש לא תואם את הסיכום שבקובץ — כדאי לבדוק עם אמונה.</Alert>}
      <ResponsiveTable
        rowKey={r => r.k}
        cardTitle={r => r.label}
        rowSx={r => (r.k === 'balance' ? { bgcolor: 'action.hover' } : {})}
        columns={[
          { key: 'label', label: '', title: true },
          { key: 'file', label: 'בקובץ', render: r => money(r.file) },
          { key: 'calc', label: 'מחושב מחדש', render: r => money(r.calc) },
          {
            key: 'diff', label: 'הפרש',
            render: r => (r.diff == null ? '—' : Math.abs(r.diff) <= 1 ? '✓ תואם' : <Box component="span" sx={{ color: 'error.main', fontWeight: 700 }}>{formatILS(r.diff)}</Box>),
          },
        ]}
        rows={rows}
      />
    </>
  );
}

/** אמונה — the monthly settlement workbook, matched to the bank and to ClickTac (spec §3). */
export default function EmunahTab({ canWrite }) {
  const [state, reload] = useLoad('/income/emunah');
  const v = state.data?.emunah;

  return (
    <Box>
      {canWrite && <Upload onDone={reload} />}
      <LoadGate state={state} reload={reload}>
        {state.data && !v && (
          <EmptyState title="עוד לא נקלט תחשיב מאמונה" hint={canWrite ? 'קלטו את קובץ האקסל למעלה.' : 'מי שיש לו הרשאת פעולות בהכנסות יכול לקלוט את הקובץ.'} />
        )}
        {v && (
          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              מוצג: {v.statement.file_name || 'תחשיב'}{v.statement.academic_year_label ? ` · ${v.statement.academic_year_label}` : ''}
              {v.statement.created_at ? ` · נקלט ${new Date(v.statement.created_at).toLocaleString('he-IL')}` : ''}
            </Typography>
            {v.emunah_rule_inactive && (
              <Alert severity="warning" sx={{ mb: 1 }}>
                הכלל המובנה "אמונה" כבוי — לא ניתן לזהות בבנק את ההעברות מאמונה, ולכן ההתאמה לבנק למטה לא אמינה.
              </Alert>
            )}
            {v.unmapped_branches?.length > 0 && (
              <Alert severity="warning" sx={{ mb: 1 }}>
                גושים בקובץ שלא זוהו כסניף במערכת: {v.unmapped_branches.join(', ')} — עבורם אין הצלבה לקליקטאק.
              </Alert>
            )}

            <Section title="🏫 הכנסות לפי סניף וחודש" sx={{ mt: 1 }}>
              {!(v.statement.branches || []).length ? <Typography variant="body2" color="text.secondary">לא נמצאו גושי סניפים בקובץ.</Typography>
                : v.statement.branches.map((b, i) => <BranchBlock key={`${b.name}|${i}`} b={b} />)}
            </Section>

            <Section title="🧾 הוצאות שקוזזו" count={(v.statement.expenses || []).length}>
              {!(v.statement.expenses || []).length ? <Typography variant="body2" color="text.secondary">אין הוצאות בקובץ.</Typography> : (
                <ResponsiveTable
                  rowKey={(_r, i) => i}
                  cardTitle={r => r.label || r.month_label || 'הוצאה'}
                  columns={[
                    { key: 'label', label: 'שורה', title: true, render: r => r.label || '—' },
                    { key: 'month_label', label: 'חודש', render: r => r.month_label || '—' },
                    { key: 'rent', label: 'שכר דירה', render: r => money(r.rent) },
                    { key: 'misc', label: 'שונות', render: r => money(r.misc) },
                  ]}
                  rows={v.statement.expenses}
                />
              )}
            </Section>

            <Section title="💸 תשלומים ששולמו — מול הבנק" count={v.payments.length}
              hint="כל תשלום מול תנועה נכנסת מאמונה בבנק: סכום עד 1 ₪ הפרש, תאריך עד 7 ימים.">
              {!v.payments.length ? <Typography variant="body2" color="text.secondary">אין תשלומים בקובץ.</Typography> : (
                <ResponsiveTable
                  rowKey={(_r, i) => i}
                  cardTitle={r => `${formatDay(r.date)} · ${money(r.amount)}`}
                  columns={[
                    { key: 'date', label: 'תאריך העברה', title: true, render: r => formatDay(r.date) },
                    { key: 'amount', label: 'סכום', render: r => money(r.amount) },
                    { key: 'for_month', label: 'עבור חודש', render: r => r.for_month || '—' },
                    {
                      key: 'bank', label: 'בבנק',
                      render: r => (r.bank
                        ? <Box component="span" sx={{ color: 'success.dark' }}>✓ נמצא בבנק ({formatDay(r.bank.date)})</Box>
                        : <Box component="span" sx={{ color: 'error.main', fontWeight: 700 }}>✗ לא נמצא</Box>),
                    },
                  ]}
                  rows={v.payments}
                />
              )}
            </Section>

            <Section title="🏦 תנועות מאמונה בבנק בלי שורה בתחשיב" count={v.unexplained_bank.length}
              hint="העברות נכנסות מאמונה מתחילת השנה ועד היום שאין להן תשלום תואם בקובץ.">
              {!v.unexplained_bank.length ? <Typography variant="body2" color="text.secondary">אין ✓</Typography> : (
                <ResponsiveTable
                  rowKey={r => r.transaction_id}
                  cardTitle={r => `${formatDay(r.date)} · ${formatILS(r.amount)}`}
                  columns={[
                    { key: 'date', label: 'תאריך', title: true, render: r => formatDay(r.date) },
                    { key: 'amount', label: 'סכום', num: true },
                    { key: 'description', label: 'תיאור', render: r => [r.counterparty, r.description].filter(Boolean).join(' · ') || '—' },
                  ]}
                  rows={v.unexplained_bank}
                />
              )}
            </Section>

            <Section title="⚖️ יתרה" hint="הסיכום כפי שבקובץ, מול חישוב מחדש: הכנסות פחות הוצאות פחות תשלומים ששולמו.">
              <Balance summary={v.statement.summary} recomputed={v.recomputed} />
            </Section>

            <Section title="🔁 הצלבה לקליקטאק" count={v.clicktac_check.length}
              hint='"גבייה מהמערכת" בתחשיב מול סך "שולם" בדוח קליקטאק שנקלט לאותו סניף וחודש.'>
              {!v.clicktac_check.length ? <Typography variant="body2" color="text.secondary">אין חודשים להצלבה (לא נקלט דוח קליקטאק לסניפים ולחודשים שבתחשיב).</Typography> : (
                <ResponsiveTable
                  rowKey={r => `${r.branch_id}|${r.month}`}
                  cardTitle={r => `${r.branch_name} · ${ymLabel(r.month)}`}
                  columns={[
                    { key: 'branch_name', label: 'סניף', title: true },
                    { key: 'month', label: 'חודש', render: r => ymLabel(r.month) },
                    { key: 'system', label: 'בתחשיב', render: r => money(r.system) },
                    { key: 'clicktac_paid', label: 'בקליקטאק', render: r => (r.clicktac_paid == null ? 'לא נקלט' : formatILS(r.clicktac_paid)) },
                    {
                      key: 'diff', label: 'הפרש',
                      render: r => (r.diff == null ? '—' : Math.abs(r.diff) <= 1 ? '✓ תואם' : <Box component="span" sx={{ color: 'error.main', fontWeight: 700 }}>{formatILS(r.diff)}</Box>),
                    },
                  ]}
                  rows={v.clicktac_check}
                />
              )}
            </Section>
          </Box>
        )}
      </LoadGate>
    </Box>
  );
}
