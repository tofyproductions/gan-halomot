import { useState } from 'react';
import { Box, Typography, Card, CardContent } from '@mui/material';
import { toast } from 'react-toastify';
import {
  DndContext, PointerSensor, TouchSensor, useSensor, useSensors, useDraggable, useDroppable,
} from '@dnd-kit/core';
import api from '../../api/client';
import { getClassroomColor } from '../../utils/classroomColors';

/** A column that accepts a dropped child, lit while one hovers over it. */
function ClassColumn({ name, roomId, cc, droppable, dragging, children }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `room-${roomId || name}`,
    disabled: !droppable,
    data: { classroom_id: roomId, name },
  });
  const fromHere = dragging && String(dragging.classroom_id) === String(roomId);
  return (
    <Card
      ref={setNodeRef}
      sx={{
        borderTop: `5px solid ${cc.primary}`,
        outline: isOver && !fromHere ? `2px dashed ${cc.primary}` : 'none',
        outlineOffset: -2,
        transition: (t) => `outline-color ${t.motion.fast}`,
      }}
    >
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** One child; grabbable by a manager, a plain button for everyone else. */
function KidRow({ kid, cc, draggable, onOpen }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `kid-${kid.id}`,
    disabled: !draggable,
    data: kid,
  });
  return (
    <Box
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      sx={{
        p: 1, mb: 0.5, bgcolor: cc.bg, borderRadius: 2, fontSize: '0.9rem',
        cursor: draggable ? 'grab' : 'pointer',
        opacity: isDragging ? 0.4 : 1,
        borderRight: `3px solid ${cc.border}`,
        '&:hover': { bgcolor: cc.border, transform: 'translateX(-2px)' },
        transition: (t) => `all ${t.motion.fast}`,
        touchAction: draggable ? 'none' : 'auto',
      }}
    >
      {kid.child_name || '—'}
    </Box>
  );
}

/**
 * The dashboard's class columns. Loaded lazily by Dashboard.jsx because
 * dnd-kit rides along, and the dashboard is the first thing every login sees.
 */
export default function ClassroomGrid({ classrooms, capacity, classroomIds, mayDrag, onOpenChild, onMoved }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  const [dragging, setDragging] = useState(null);

  const onDragEnd = async ({ active, over }) => {
    setDragging(null);
    if (!over || !active?.data?.current) return;
    const kid = active.data.current;
    const target = over.data?.current;
    if (!target?.classroom_id || String(target.classroom_id) === String(kid.classroom_id)) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`להעביר את ${kid.child_name} לכיתה "${target.name}"?\n\nהמעבר מתעדכן בכל המערכת. התשלום לא משתנה.`)) return;
    try {
      await api.put(`/children/${kid.id}/classroom`, { classroom_id: target.classroom_id });
      toast.success(`${kid.child_name} הועבר/ה ל${target.name}`);
      onMoved?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'המעבר נכשל');
    }
  };

  return (
    <DndContext sensors={sensors} onDragStart={(e) => setDragging(e.active?.data?.current || null)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 2, mb: 4 }}>
        {Object.entries(classrooms).map(([name, kids]) => {
          const roomCapacity = capacity.find(c => c.name === name)?.capacity || 0;
          const count = Array.isArray(kids) ? kids.length : 0;
          const cc = getClassroomColor(name);
          const roomId = classroomIds[name] || null;
          return (
            <ClassColumn key={name} name={name} roomId={roomId} cc={cc} droppable={mayDrag && !!roomId} dragging={dragging}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1, pb: 1, borderBottom: `1px solid ${cc.border}` }}>
                  <Typography sx={{ fontWeight: 700, color: cc.primary }}>{name}</Typography>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <Typography sx={{ fontWeight: 800, color: cc.primary }}>{count}</Typography>
                    {roomCapacity > 0 && (
                      <Typography variant="caption" color="text.secondary">/ {roomCapacity}</Typography>
                    )}
                  </Box>
                </Box>
                {Array.isArray(kids) && kids.map((k, i) => (
                  <KidRow
                    key={k.id || i}
                    kid={k}
                    cc={cc}
                    draggable={mayDrag && !!k.id}
                    onOpen={() => (k.id || k._id) && onOpenChild(k.id || k._id)}
                  />
                ))}
            </ClassColumn>
          );
        })}
        {Object.keys(classrooms).length === 0 && (
          <Box sx={{ textAlign: 'center', py: 6, gridColumn: '1 / -1' }}>
            <Typography color="text.secondary">אין ילדים רשומים עדיין. התחל ברישום חדש.</Typography>
          </Box>
        )}
      </Box>
      </DndContext>
  );
}
