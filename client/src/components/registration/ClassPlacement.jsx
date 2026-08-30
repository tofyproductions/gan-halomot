import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Stack, Typography, Card, Chip, Button, TextField, MenuItem, Dialog,
  DialogTitle, DialogContent, DialogActions, Alert, AlertTitle, CircularProgress,
  Table, TableHead, TableBody, TableRow, TableCell, LinearProgress, Tooltip,
  IconButton, Divider,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeMotionIcon from '@mui/icons-material/AutoAwesomeMotion';
import OpenYearClassrooms from './OpenYearClassrooms';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { Autocomplete } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';

/**
 * שיבוץ לכיתות — the board where the intake becomes a gan.
 *
 * Up to here everything has been a comparison: who the state approved, who
 * registered, who disagrees with whom. This is where a person decides which
 * room each child walks into, sees how many places that leaves, and commits.
 * Confirming turns every child into a real registration — a Registration, a
 * Child with a classroom, and the collections row — which is what puts them on
 * the dashboard by class, the same way a קפלן child registered here directly
 * appears.
 *
 * Two capacity numbers, and they are not the same fact. The licence is the
 * ministry's number for the whole מעון and is typed in by hand; the rooms'
 * capacities are what the gan set up. Real gans have rooms laid out for more
 * places than the licence allows, so both are shown and the smaller one is
 * named as the one that binds.
 */

const CATEGORY_LABEL = {
  'תינוקייה': 'תינוקות',
  'צעירים': 'פעוטות',
  'בוגרים': 'בוגרים',
};

/** A capacity bar that says what it is measuring. */
function CapacityBar({ used, total, label }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const over = total > 0 && used > total;
  return (
    <Box sx={{ minWidth: 140 }}>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <Typography variant="caption" fontWeight={700} color={over ? 'error.main' : 'text.primary'}>
          {used}{total > 0 ? ` / ${total}` : ''}
        </Typography>
      </Stack>
      <LinearProgress variant="determinate" value={pct}
        color={over ? 'error' : pct >= 90 ? 'warning' : 'success'}
        sx={{ height: 7, borderRadius: 4 }} />
    </Box>
  );
}

export default function ClassPlacement({ open, onClose, branchId, branchName, year, onDone }) {
  const [openYear, setOpenYear] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [assign, setAssign] = useState({});      // enrollmentId -> classroomId
  const [fees, setFees] = useState({});
  const [tier, setTier] = useState('');
  const [regFee, setRegFee] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [newRoom, setNewRoom] = useState({ open: false, category: '', name: '', capacity: '' });
  const [licence, setLicence] = useState({ editing: false, value: '' });
  const confirmDlg = useConfirm();
  // Editing a room that already exists (name/capacity), and the mistake case —
  // a room opened in the wrong group — which is a delete.
  const [editRoom, setEditRoom] = useState(null); // {id, name, capacity}
  // Moving a child who is ALREADY enrolled between rooms.
  const [moveKids, setMoveKids] = useState([]);
  const [move, setMove] = useState({ child: null, room: '' });

  const load = useCallback(() => {
    if (!branchId || !year) return;
    setLoading(true);
    setResult(null);
    api.get('/tmt/placement', { params: { branch: branchId, year } })
      .then(res => {
        setData(res.data);
        // Pre-fill each child with the room already decided for them, and where
        // exactly one room of the right kind exists, with that one — there is no
        // choice to make and one fewer thing to forget.
        const pre = {};
        for (const g of res.data.groups || []) {
          const only = g.classrooms.length === 1 ? g.classrooms[0].id : '';
          for (const c of g.children) pre[c.id] = c.classroom_id || only || '';
        }
        setAssign(pre);
        setRegFee(res.data.pricing?.one_time?.registration != null
          ? String(res.data.pricing.one_time.registration) : '');
        setLicence({ editing: false, value: res.data.capacity?.licensed ?? '' });
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינת השיבוץ'))
      .finally(() => setLoading(false));
  }, [branchId, year]);

  useEffect(() => { if (open) load(); }, [open, load]);

  /** A tier row prices all three age groups at once — column per age group. */
  const applyTier = (label) => {
    setTier(label);
    const t = data?.pricing?.tiers?.find(x => x.label === label);
    if (t) setFees({ 'תינוק': t.prices[0], 'פעוט': t.prices[1], 'בוגר': t.prices[2] });
  };

  /** Live counts: the saved state plus whatever is being moved on screen now. */
  const live = useMemo(() => {
    if (!data) return null;
    const perRoom = {};
    for (const r of data.classrooms || []) perRoom[r.id] = { ...r, assigned: 0 };
    let assigned = 0;
    for (const g of data.groups || []) {
      for (const c of g.children) {
        const room = assign[c.id];
        if (room && perRoom[room]) { perRoom[room].assigned += 1; assigned += 1; }
      }
    }
    const cap = data.capacity || {};
    return {
      perRoom,
      assigned,
      unassigned: (cap.waiting || 0) - assigned,
      afterConfirm: (cap.seated || 0) + assigned,
    };
  }, [data, assign]);

  const saveLicence = async () => {
    try {
      await api.put(`/branches/${branchId}`, {
        licensed_capacity: licence.value === '' ? null : Number(licence.value),
      });
      toast.success('התפוסה המאושרת נשמרה');
      setLicence(l => ({ ...l, editing: false }));
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    }
  };

  const saveRoomEdit = async () => {
    try {
      await api.put(`/classrooms/${editRoom.id}`, {
        name: editRoom.name,
        capacity: editRoom.capacity === '' ? null : Number(editRoom.capacity),
      });
      toast.success('הכיתה עודכנה');
      setEditRoom(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בעדכון הכיתה');
    }
  };

  const deleteRoom = async (room) => {
    if (!(await confirmDlg({
      title: 'מחיקת כיתה',
      message: `למחוק את "${room.name}"? אפשר למחוק רק כיתה ריקה — ילדים משובצים חוסמים את המחיקה.`,
      danger: true,
    }))) return;
    try {
      await api.delete(`/classrooms/${room.id}`);
      toast.success('הכיתה נמחקה');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה במחיקה');
    }
  };

  /** The already-enrolled of this branch's rooms — the move-a-child list. */
  const loadMoveKids = useCallback(async () => {
    if (!data?.classrooms?.length) { setMoveKids([]); return; }
    try {
      const res = await api.get('/children', { params: { year } });
      const roomIds = new Set((data.classrooms || []).map(r => String(r.id)));
      setMoveKids((res.data.children || res.data || [])
        .filter(c => roomIds.has(String(c.classroom_id?._id || c.classroom_id || ''))));
    } catch { setMoveKids([]); }
  }, [data, year]);

  useEffect(() => { loadMoveKids(); }, [loadMoveKids]);

  const moveChild = async () => {
    if (!move.child || !move.room) return toast.error('יש לבחור ילד/ה וכיתה');
    try {
      await api.put(`/children/${move.child._id || move.child.id}/classroom`, { classroom_id: move.room });
      toast.success(`${move.child.child_name} הועבר/ה לכיתה החדשה`);
      setMove({ child: null, room: '' });
      load();
      loadMoveKids();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהעברה');
    }
  };

  const createRoom = async () => {
    if (!newRoom.name) return toast.error('יש להזין שם כיתה');
    try {
      await api.post('/external-enrollments/classrooms', {
        branch_id: branchId,
        academic_year: year,
        category: newRoom.category,
        name: newRoom.name,
        capacity: Number(newRoom.capacity) || null,
      });
      toast.success(`נוצרה כיתה "${newRoom.name}"`);
      setNewRoom({ open: false, category: '', name: '', capacity: '' });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה ביצירת הכיתה');
    }
  };

  const confirm = async () => {
    const assignments = Object.entries(assign)
      .filter(([, room]) => !!room)
      .map(([id, classroom_id]) => ({ id, classroom_id }));
    if (!assignments.length) return toast.error('לא שובץ אף ילד/ה');
    setSaving(true);
    try {
      const res = await api.post('/tmt/placement/confirm', {
        branch_id: branchId,
        academic_year: year,
        assignments,
        fees_by_age_group: Object.fromEntries(
          Object.entries(fees).map(([k, v]) => [k, Number(v) || 0]),
        ),
        registration_fee: Number(regFee) || 0,
      });
      setResult(res.data);
      toast.success(`${res.data.placed} ילדים שובצו ונקלטו למערכת`);
      load();
      onDone?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה באישור השיבוץ');
    } finally {
      setSaving(false);
    }
  };

  const cap = data?.capacity || {};
  const bindingSource = cap.licensed != null && cap.rooms_sum
    ? (cap.licensed <= cap.rooms_sum ? 'רישיון משרד החינוך' : 'סכום מקומות בכיתות')
    : (cap.licensed != null ? 'רישיון משרד החינוך' : 'סכום מקומות בכיתות');

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="lg" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Box sx={{ flex: 1 }}>שיבוץ לכיתות — {branchName}</Box>
          {/* The way out of an empty year. Reachable from here because this is
              the screen that tells you the year has no rooms. */}
          <Button size="small" variant="outlined" startIcon={<AutoAwesomeMotionIcon />}
            onClick={() => setOpenYear(true)}>
            פתיחת שנה — כיתות לכל הסניפים
          </Button>
        </Stack>
      </DialogTitle>
      <DialogContent>
        {loading && <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>}

        {!loading && data && (
          <>
            {/* ---------- capacity ---------- */}
            <Card variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap alignItems="center">
                <Box>
                  <Typography variant="caption" color="text.secondary">תפוסה מאושרת (משרד החינוך)</Typography>
                  {licence.editing ? (
                    <Stack direction="row" spacing={1} alignItems="center">
                      <TextField size="small" type="number" sx={{ width: 100 }}
                        value={licence.value}
                        onChange={e => setLicence(l => ({ ...l, value: e.target.value }))} />
                      <Button size="small" variant="contained" onClick={saveLicence}>שמירה</Button>
                      <Button size="small" onClick={() => setLicence({ editing: false, value: cap.licensed ?? '' })}>
                        ביטול
                      </Button>
                    </Stack>
                  ) : (
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Typography variant="h5" fontWeight={800}>
                        {cap.licensed ?? '— לא הוזן'}
                      </Typography>
                      <Tooltip title="המספר שמשרד החינוך נתן לגן. מוזן ידנית — שום דבר לא מחשב אותו">
                        <IconButton size="small" onClick={() => setLicence({ editing: true, value: cap.licensed ?? '' })}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  )}
                </Box>

                <Divider orientation="vertical" flexItem />

                <Box>
                  <Typography variant="caption" color="text.secondary">סכום מקומות בכיתות</Typography>
                  <Typography variant="h5" fontWeight={800}>{cap.rooms_sum || 0}</Typography>
                </Box>

                <Divider orientation="vertical" flexItem />

                <CapacityBar used={live?.afterConfirm || 0} total={cap.binding || 0}
                  label={`תפוסה אחרי אישור (מגבלה: ${bindingSource})`} />

                <Box>
                  <Typography variant="caption" color="text.secondary">כבר משובצים</Typography>
                  <Typography variant="h6" fontWeight={800}>{cap.seated || 0}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">ממתינים לשיבוץ</Typography>
                  <Typography variant="h6" fontWeight={800} color="warning.main">{live?.unassigned ?? 0}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">נותרו מקומות</Typography>
                  <Typography variant="h6" fontWeight={800} color="success.main">
                    {Math.max(0, (cap.binding || 0) - (live?.afterConfirm || 0))}
                  </Typography>
                </Box>
              </Stack>

              {cap.licensed == null && (
                <Alert severity="info" sx={{ mt: 1.5 }}>
                  לא הוזנה תפוסה מאושרת. עד שתוזן, המגבלה מחושבת מסכום המקומות שהוגדרו בכיתות.
                </Alert>
              )}
              {cap.licensed != null && cap.rooms_sum > cap.licensed && (
                <Alert severity="warning" sx={{ mt: 1.5 }}>
                  הכיתות מוגדרות ל־{cap.rooms_sum} מקומות אך הרישיון הוא {cap.licensed}.
                  המגבלה הקובעת היא הרישיון.
                </Alert>
              )}
              {(cap.binding || 0) > 0 && (live?.afterConfirm || 0) > (cap.binding || 0) && (
                <Alert severity="error" sx={{ mt: 1.5 }}>
                  השיבוץ הנוכחי חורג מהתפוסה ב־{(live.afterConfirm - cap.binding)} ילדים.
                </Alert>
              )}
            </Card>

            {/* Rooms of this year that belong to no age group.
                They exist, they are active, and they appear on the branches
                screen — but a room is matched to waiting children through its
                category alone, so these are listed in none of the blocks below
                and can receive nobody. Silently. A block reading "אין כיתות
                לשנה זו" beside a branches screen showing four rooms is the
                worst version of this, so name them here. */}
            {(() => {
              const orphans = (data.classrooms || []).filter(r => !r.category);
              if (!orphans.length) return null;
              return (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  <AlertTitle>{orphans.length} כיתות ללא קבוצת גיל</AlertTitle>
                  {orphans.map(r => r.name).join(', ')} — הכיתות האלה קיימות אבל לא
                  מוצעות לשיבוץ, כי הן משויכות לילדים לפי קבוצת הגיל שלהן והיא ריקה.
                  יש להגדיר להן קבוצה במסך הסניפים.
                </Alert>
              );
            })()}

            {/* ---------- the board, one block per age group ---------- */}
            {(data.groups || []).map(g => (
              <Card key={g.age_group} variant="outlined" sx={{ p: 2, mb: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
                  <Typography variant="subtitle1" fontWeight={800}>
                    {CATEGORY_LABEL[g.category] || g.category}
                  </Typography>
                  <Chip size="small" label={`${g.waiting} ממתינים`}
                    color={g.waiting ? 'warning' : 'default'} />
                  {g.classrooms.map(r => {
                    const nowAssigned = live?.perRoom?.[r.id]?.assigned || 0;
                    return (
                      <Stack key={r.id} direction="row" alignItems="center" spacing={0.25} sx={{ minWidth: 160 }}>
                        <Box sx={{ flex: 1 }}>
                          <CapacityBar used={r.seated + nowAssigned} total={r.capacity || 0} label={r.name} />
                        </Box>
                        <Tooltip title="עריכת שם/מקומות">
                          <IconButton size="small" sx={{ p: 0.25 }}
                            onClick={() => setEditRoom({ id: r.id, name: r.name, capacity: r.capacity ?? '' })}>
                            <EditIcon sx={{ fontSize: 15 }} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="מחיקת כיתה (רק כשהיא ריקה)">
                          <IconButton size="small" color="error" sx={{ p: 0.25 }} onClick={() => deleteRoom(r)}>
                            <DeleteIcon sx={{ fontSize: 15 }} />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    );
                  })}
                  <Box sx={{ flex: 1 }} />
                  <Button size="small" startIcon={<AddIcon />}
                    onClick={() => setNewRoom({ open: true, category: g.category, name: '', capacity: '' })}>
                    כיתה חדשה
                  </Button>
                </Stack>

                {!g.classrooms.length && (
                  <Alert severity="warning" sx={{ mb: 1 }}>
                    אין כיתות {CATEGORY_LABEL[g.category] || g.category} לשנה זו. בלי כיתה אי אפשר לשבץ —
                    ילד שנקלט בלי כיתה לא יופיע במסך הכיתות, בנוכחות ובגבייה.
                  </Alert>
                )}

                {!!g.children.length && (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>ילד/ה</TableCell>
                        <TableCell>גיל ב־1.9</TableCell>
                        <TableCell>הורה</TableCell>
                        <TableCell>חריגות</TableCell>
                        <TableCell>כיתה</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {g.children.map(c => (
                        <TableRow key={c.id} hover>
                          <TableCell sx={{ fontWeight: 600 }}>
                            {c.child_name}
                            <Typography variant="caption" color="text.secondary" display="block" dir="ltr">
                              {c.id_number}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            {c.age_label}
                            {c.is_manual && (
                              <Chip size="small" color="primary" label="שיבוץ ידני"
                                sx={{ height: 18, fontSize: '0.65rem', mr: 0.5 }} />
                            )}
                          </TableCell>
                          <TableCell>
                            {c.parent_name}
                            <Typography variant="caption" color="text.secondary" display="block" dir="ltr">
                              {c.parent_phone}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            {c.issues.map(i => (
                              <Chip key={i} size="small" variant="outlined" color="warning" label={i}
                                sx={{ height: 18, fontSize: '0.65rem', mb: 0.3 }} />
                            ))}
                          </TableCell>
                          <TableCell>
                            <TextField select size="small" variant="standard" sx={{ minWidth: 130 }}
                              value={assign[c.id] || ''}
                              onChange={e => setAssign(a => ({ ...a, [c.id]: e.target.value }))}>
                              <MenuItem value="">— לא משובץ —</MenuItem>
                              {/* Every room in the year, not only this group's:
                                  the room decides the group, so moving a child
                                  to another room is how you overrule the age. */}
                              {(data.classrooms || []).map(r => (
                                <MenuItem key={r.id} value={r.id}>
                                  {r.name}{r.capacity ? ` (${r.seated + (live?.perRoom?.[r.id]?.assigned || 0)}/${r.capacity})` : ''}
                                </MenuItem>
                              ))}
                            </TextField>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Card>
            ))}

            {/* ---------- moving a child who is already enrolled ---------- */}
            {moveKids.length > 0 && (
              <Card variant="outlined" sx={{ p: 2, mb: 2 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                  <SwapHorizIcon fontSize="small" />
                  <Typography variant="subtitle1" fontWeight={800}>שינוי שיבוץ לילד/ה קיים/ת</Typography>
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                  לילדים שכבר נקלטו למערכת. ההעברה מיידית ומעדכנת גם את הרישום.
                </Typography>
                <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
                  <Autocomplete
                    size="small" sx={{ minWidth: 240 }}
                    options={moveKids}
                    value={move.child}
                    onChange={(_, v) => setMove(m => ({ ...m, child: v }))}
                    getOptionLabel={(c) => `${c.child_name} (${c.classroom_name || c.classroom_id?.name || '—'})`}
                    isOptionEqualToValue={(a, b) => (a._id || a.id) === (b._id || b.id)}
                    renderInput={(params) => <TextField {...params} label="ילד/ה" />}
                  />
                  <TextField select size="small" label="לכיתה" value={move.room} sx={{ minWidth: 160 }}
                    onChange={e => setMove(m => ({ ...m, room: e.target.value }))}>
                    {(data.classrooms || []).map(r => (
                      <MenuItem key={r.id} value={r.id}>
                        {r.name}{r.capacity ? ` (${r.seated}/${r.capacity})` : ''}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button variant="contained" size="small" onClick={moveChild} disabled={!move.child || !move.room}>
                    העברה
                  </Button>
                </Stack>
              </Card>
            )}

            {/* ---------- the money ---------- */}
            <Card variant="outlined" sx={{ p: 2, mb: 1 }}>
              <Typography variant="subtitle1" fontWeight={800} gutterBottom>שכר לימוד</Typography>
              <Alert severity="info" sx={{ mb: 1.5 }}>
                שכר הלימוד אינו קיים באף אחד מהקבצים — דרגת הסבסוד היא נתון על הכנסת המשפחה
                שלא מופיע בהם. נבחר כאן מתוך מחירון הסניף.
              </Alert>
              {/* Leaving it empty is allowed and is a decision, so it is stated
                  here beside the fields rather than blocking the button — a
                  child certain to attend should not be kept out of the gan's
                  own screens until an income bracket arrives. */}
              {!Object.values(fees).some(v => Number(v) > 0) && (
                <Alert severity="warning" sx={{ mb: 1.5 }}>
                  <AlertTitle>לא הוזן שכר לימוד — הילדים ייקלטו עם 0 ₪</AlertTitle>
                  הם ייכנסו לכיתות, לנוכחות ולכל שאר המסכים כרגיל, ובגבייה יופיעו כחייבים
                  0 ₪ עד שיוזן סכום. הרישומים מסומנים כ״שכר לימוד טרם נקבע״ כדי שאפשר יהיה
                  לאתר אותם ולעדכן בבת אחת.
                </Alert>
              )}
              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
                {!!data.pricing?.tiers?.length && (
                  <TextField select size="small" label="דרגה" sx={{ minWidth: 160 }}
                    value={tier} onChange={e => applyTier(e.target.value)}>
                    {data.pricing.tiers.map(t => (
                      <MenuItem key={t.label} value={t.label}>{t.label}</MenuItem>
                    ))}
                  </TextField>
                )}
                {['תינוק', 'פעוט', 'בוגר'].map(gname => (
                  <TextField key={gname} size="small" label={gname} type="number" sx={{ width: 110 }}
                    value={fees[gname] ?? ''} onChange={e => setFees(f => ({ ...f, [gname]: e.target.value }))} />
                ))}
                <TextField size="small" label="דמי רישום" type="number" sx={{ width: 120 }}
                  value={regFee} onChange={e => setRegFee(e.target.value)} />
              </Stack>
              {!data.pricing && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  לא הוגדר מחירון לסניף לשנה זו. אפשר להזין סכומים ידנית.
                </Alert>
              )}
            </Card>

            {result && (
              <Alert severity="success" sx={{ mb: 1 }}>
                <AlertTitle>{result.placed} ילדים שובצו ונקלטו למערכת</AlertTitle>
                מכאן הם מופיעים בלוח הבקרה לפי הכיתה, בנוכחות ובגבייה.
                {!!result.skipped?.length && (
                  <Box sx={{ mt: 1 }}>
                    <b>לא שובצו:</b>
                    {result.skipped.map((s, i) => (
                      <Typography key={i} variant="body2">{s.child || s.id}: {s.error}</Typography>
                    ))}
                  </Box>
                )}
              </Alert>
            )}
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {live ? `${live.assigned} משובצים · ${live.unassigned} ללא כיתה` : ''}
        </Typography>
        <Button onClick={onClose}>סגירה</Button>
        <Button variant="contained" color="success" startIcon={<CheckCircleIcon />}
          onClick={confirm} disabled={saving || loading || !live?.assigned}>
          {saving ? 'מאשר…' : `אישור שיבוץ (${live?.assigned || 0})`}
        </Button>
      </DialogActions>

      {/* ---------- a room that does not exist yet ---------- */}
      <Dialog open={newRoom.open} onClose={() => setNewRoom(n => ({ ...n, open: false }))} dir="rtl">
        <DialogTitle>כיתה חדשה — {CATEGORY_LABEL[newRoom.category] || newRoom.category}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1, minWidth: 300 }}>
            <TextField size="small" label="שם הכיתה" value={newRoom.name}
              onChange={e => setNewRoom(n => ({ ...n, name: e.target.value }))} />
            <TextField size="small" label="מספר מקומות" type="number" value={newRoom.capacity}
              onChange={e => setNewRoom(n => ({ ...n, capacity: e.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewRoom(n => ({ ...n, open: false }))}>ביטול</Button>
          <Button variant="contained" onClick={createRoom}>יצירה</Button>
        </DialogActions>
      </Dialog>

      {/* ---------- editing an existing room ---------- */}
      <Dialog open={!!editRoom} onClose={() => setEditRoom(null)} dir="rtl">
        <DialogTitle>עריכת כיתה</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1, minWidth: 300 }}>
            <TextField size="small" label="שם הכיתה" value={editRoom?.name || ''}
              onChange={e => setEditRoom(r => ({ ...r, name: e.target.value }))} />
            <TextField size="small" label="מספר מקומות" type="number" value={editRoom?.capacity ?? ''}
              onChange={e => setEditRoom(r => ({ ...r, capacity: e.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditRoom(null)}>ביטול</Button>
          <Button variant="contained" onClick={saveRoomEdit}>שמירה</Button>
        </DialogActions>
      </Dialog>

      <OpenYearClassrooms
        open={openYear}
        onClose={() => setOpenYear(false)}
        academicYear={year}
        previousYear={year ? `${Number(String(year).split('-')[0]) - 1}-${Number(String(year).split('-')[0])}` : ''}
        onDone={() => { setOpenYear(false); load(); }}
      />

    </Dialog>
  );
}
