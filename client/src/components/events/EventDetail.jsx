import { useEffect, useState, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography,
  Box, Chip, Table, TableHead, TableBody, TableRow, TableCell, IconButton,
  TextField, Tooltip, LinearProgress, Divider, Alert, Accordion, AccordionSummary,
  AccordionDetails, Select, MenuItem, FormControl, InputLabel,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import LockIcon from '@mui/icons-material/Lock';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddBusinessIcon from '@mui/icons-material/AddBusiness';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ListAltIcon from '@mui/icons-material/ListAlt';
import { toast } from 'react-toastify';
import html2pdf from 'html2pdf.js';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';
import EventEditor from './EventEditor';

const fmtDate = (d) => (d ? (() => { try { return new Date(d + 'T00:00:00').toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }); } catch { return d; } })() : '');

function StatusChip({ status }) {
  if (status === 'published') return <Chip size="small" color="success" label="מפורסם" />;
  if (status === 'closed') return <Chip size="small" label="סגור" />;
  return <Chip size="small" color="warning" label="טיוטה" />;
}

export default function EventDetail({ open, groupId, branches = [], onClose, onChanged }) {
  const confirm = useConfirm();
  const [ev, setEv] = useState(null);
  const [loading, setLoading] = useState(false);
  const [addBranchId, setAddBranchId] = useState('');
  const [editor, setEditor] = useState({ open: false, mode: 'meta', instance: null });

  const load = useCallback(() => {
    if (!groupId) return;
    setLoading(true);
    api.get(`/gan-events/group/${groupId}`)
      .then((res) => setEv(res.data.event))
      .catch((e) => toast.error(e.response?.data?.error || 'שגיאה'))
      .finally(() => setLoading(false));
  }, [groupId]);

  useEffect(() => { if (open) { setAddBranchId(''); load(); } }, [open, load]);

  const applyEvent = (campaign) => { setEv(campaign); onChanged?.(); };

  const copyLink = async (link) => {
    try { await navigator.clipboard.writeText(link); toast.success('הקישור הועתק'); }
    catch { toast.info(link); }
  };

  // status/meta changes propagate across the campaign — PUT any instance.
  const setStatus = async (status) => {
    try {
      const res = await api.put(`/gan-events/${ev.branches[0].id}`, { status });
      applyEvent(res.data.event);
      toast.success(status === 'published' ? 'האירוע פורסם' : status === 'closed' ? 'האירוע נסגר' : 'עודכן');
    } catch (e) { toast.error(e.response?.data?.error || 'שגיאה'); }
  };

  const addBranch = async () => {
    if (!addBranchId) return;
    try {
      const res = await api.post(`/gan-events/group/${ev.group_id}/add-branch`, { branch_id: addBranchId });
      applyEvent(res.data.event);
      setAddBranchId('');
      toast.success('הסניף נוסף לאירוע');
    } catch (e) { toast.error(e.response?.data?.error || 'שגיאה'); }
  };

  const removeBranch = async (branch) => {
    if (!(await confirm({ title: 'הסרת סניף', message: `להסיר את ${branch.branch_name} מהאירוע? השריונים של הסניף יימחקו.` }))) return;
    try {
      await api.delete(`/gan-events/${branch.id}`);
      if (ev.branches.length <= 1) { onChanged?.(); onClose(); return; }
      load(); onChanged?.();
      toast.success('הסניף הוסר');
    } catch (e) { toast.error(e.response?.data?.error || 'שגיאה'); }
  };

  const exportPdf = (branch) => {
    const el = document.createElement('div');
    el.setAttribute('dir', 'rtl');
    el.style.cssText = 'font-family: Arial, sans-serif; padding: 24px; color: #1a1a1a; width: 700px;';
    const rows = branch.groups.map((g) => {
      const takers = g.claims.map((c) => `${c.parent_name}${c.parent_phone ? ` (${c.parent_phone})` : ''}`).join(', ');
      return `<tr>
        <td style="border:1px solid #ddd;padding:8px;font-weight:bold;">${g.name}${g.total > 1 ? ` ×${g.total}` : ''}</td>
        <td style="border:1px solid #ddd;padding:8px;">${takers || '<span style="color:#c00;">— חסר —</span>'}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `
      <h1 style="margin:0 0 4px;font-size:24px;">${ev.name}</h1>
      <div style="color:#555;margin-bottom:4px;font-size:15px;">${branch.branch_name}</div>
      <div style="color:#555;margin-bottom:16px;font-size:15px;">
        ${fmtDate(ev.event_date)}${ev.event_time ? ` · ${ev.event_time}` : ''}
        ${ev.description ? `<div style="margin-top:6px;">${ev.description}</div>` : ''}
      </div>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead><tr>
          <th style="border:1px solid #ddd;padding:8px;background:#f5f5f5;text-align:right;">פריט</th>
          <th style="border:1px solid #ddd;padding:8px;background:#f5f5f5;text-align:right;">מי מביא</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:12px;color:#888;font-size:12px;">שוריינו ${branch.taken_items}/${branch.total_items} פריטים</div>`;
    try {
      html2pdf().set({
        margin: 10,
        filename: `${ev.name.replace(/[^֐-׿\w -]/g, '')}-${branch.branch_name.replace(/[^֐-׿\w -]/g, '')}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      }).from(el).save();
    } catch { toast.error('שגיאה בייצוא PDF'); }
  };

  const inCampaign = new Set((ev?.branches || []).map((b) => b.branch_id));
  const addable = branches.filter((b) => !inCampaign.has(String(b._id || b.id)));
  const pct = ev && ev.total_items ? Math.round((ev.taken_items / ev.total_items) * 100) : 0;

  return (
    <>
      <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {ev?.name || 'אירוע'} {ev && <StatusChip status={ev.status} />}
          <Box sx={{ flex: 1 }} />
          <Tooltip title="רענן"><IconButton size="small" onClick={load}><RefreshIcon /></IconButton></Tooltip>
        </DialogTitle>
        {loading && <LinearProgress />}
        <DialogContent>
          {!ev ? null : (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                <Typography variant="body2" color="text.secondary">
                  {fmtDate(ev.event_date)}{ev.event_time ? ` · ${ev.event_time}` : ''}
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Button size="small" startIcon={<EditIcon />}
                  onClick={() => setEditor({ open: true, mode: 'meta', instance: ev.branches[0] })}>עריכת פרטים</Button>
              </Stack>
              {ev.description && <Typography variant="body2">{ev.description}</Typography>}

              {/* Overall progress */}
              <Box>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="caption">סה״כ שוריינו {ev.taken_items} מתוך {ev.total_items} · {ev.branch_count} סניפים</Typography>
                  <Typography variant="caption">{pct}%</Typography>
                </Stack>
                <LinearProgress variant="determinate" value={pct} sx={{ height: 8, borderRadius: 4 }} />
              </Box>

              {ev.status === 'draft' && <Alert severity="warning">האירוע בטיוטה — פרסם אותו כדי שההורים יוכלו לשריין.</Alert>}

              <Divider>סניפים</Divider>

              {/* Per-branch sections */}
              {ev.branches.map((b) => {
                const bpct = b.total_items ? Math.round((b.taken_items / b.total_items) * 100) : 0;
                return (
                  <Accordion key={b.id} disableGutters sx={{ borderRadius: 2, '&:before': { display: 'none' }, border: '1px solid', borderColor: 'divider' }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ width: '100%', pr: 1 }}>
                        <Typography fontWeight={700} sx={{ flex: 1 }}>{b.branch_name}</Typography>
                        <Chip size="small" label={`${b.taken_items}/${b.total_items}`}
                          color={b.total_items && b.taken_items >= b.total_items ? 'success' : b.taken_items > 0 ? 'warning' : 'default'} />
                        <Box sx={{ width: 90 }}><LinearProgress variant="determinate" value={bpct} sx={{ height: 6, borderRadius: 3 }} /></Box>
                      </Stack>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Stack spacing={1.5}>
                        {/* Link */}
                        <Stack direction="row" spacing={1} alignItems="center">
                          <TextField size="small" value={b.link} fullWidth InputProps={{ readOnly: true }} label="קישור להורים" />
                          <Tooltip title="העתק"><span><IconButton onClick={() => copyLink(b.link)} disabled={ev.status === 'draft'}><ContentCopyIcon /></IconButton></span></Tooltip>
                        </Stack>

                        {/* Claims */}
                        {b.groups.length === 0 ? (
                          <Alert severity="info" sx={{ py: 0 }}>אין פריטים בסניף זה עדיין.</Alert>
                        ) : (
                          <Table size="small">
                            <TableHead><TableRow>
                              <TableCell>פריט</TableCell>
                              <TableCell align="center" sx={{ width: 80 }}>שוריין</TableCell>
                              <TableCell>מי מביא</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                              {b.groups.map((g, i) => (
                                <TableRow key={i} hover>
                                  <TableCell sx={{ fontWeight: 600 }}>{g.name}</TableCell>
                                  <TableCell align="center">
                                    <Chip size="small" label={`${g.taken}/${g.total}`}
                                      color={g.taken >= g.total ? 'success' : g.taken > 0 ? 'warning' : 'default'}
                                      variant={g.taken > 0 ? 'filled' : 'outlined'} />
                                  </TableCell>
                                  <TableCell>
                                    {g.claims.length === 0 ? <Typography variant="body2" color="text.disabled">—</Typography> : (
                                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                                        {g.claims.map((c, j) => <Chip key={j} size="small" variant="outlined" label={c.parent_phone ? `${c.parent_name} · ${c.parent_phone}` : c.parent_name} />)}
                                      </Stack>
                                    )}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )}

                        {/* Branch actions */}
                        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                          <Button size="small" startIcon={<ListAltIcon />} onClick={() => setEditor({ open: true, mode: 'items', instance: b })}>ערוך רשימה</Button>
                          <Button size="small" startIcon={<PictureAsPdfIcon />} variant="outlined" onClick={() => exportPdf(b)}>ייצוא PDF</Button>
                          <Box sx={{ flex: 1 }} />
                          <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} onClick={() => removeBranch(b)}>הסר סניף</Button>
                        </Stack>
                      </Stack>
                    </AccordionDetails>
                  </Accordion>
                );
              })}

              {/* Add a branch */}
              {addable.length > 0 && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <FormControl size="small" sx={{ minWidth: 200 }}>
                    <InputLabel>הוסף סניף לאירוע</InputLabel>
                    <Select label="הוסף סניף לאירוע" value={addBranchId} onChange={(e) => setAddBranchId(e.target.value)}>
                      {addable.map((b) => <MenuItem key={b._id || b.id} value={String(b._id || b.id)}>{b.name}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <Button startIcon={<AddBusinessIcon />} onClick={addBranch} disabled={!addBranchId}>הוסף</Button>
                </Stack>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
          {ev?.status === 'draft' && <Button variant="outlined" color="success" onClick={() => setStatus('published')}>פרסם</Button>}
          {ev?.status === 'published' && <Button startIcon={<LockIcon />} color="inherit" onClick={() => setStatus('closed')}>סגור לשריונים</Button>}
          {ev?.status === 'closed' && <Button color="success" onClick={() => setStatus('published')}>פתח מחדש</Button>}
          <Box sx={{ flex: 1 }} />
          <Button onClick={onClose}>סגור</Button>
        </DialogActions>
      </Dialog>

      <EventEditor
        open={editor.open}
        mode={editor.mode}
        instance={editor.instance}
        campaign={ev}
        onClose={() => setEditor((s) => ({ ...s, open: false }))}
        onSaved={(campaign) => applyEvent(campaign)}
      />
    </>
  );
}
