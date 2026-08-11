import { useState } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import { useSearchParams } from 'react-router-dom';
import ExternalEnrollments from './ExternalEnrollments';
import TmtReconcile from './TmtReconcile';

/**
 * רישום לאמונה — the two halves of one intake, on one page.
 *
 * Enrolling a child in a ministry-supervised gan takes two files that decide
 * nothing on their own: קליקטאק says who registered with us, משרד התמ"ת says
 * whom the state approved. Splitting them across two menu entries made them
 * look like two jobs; they are one, done in one sitting in July, and the
 * answer to "can this child come" is only visible when both are in front of
 * you.
 *
 * The tab lives in the URL (`?view=tmt`) so a link to the comparison is a link
 * to the comparison, and a reload keeps you where you were.
 */

const VIEWS = [
  { id: 'clicktac', label: 'קליטה מקליקטאק' },
  { id: 'tmt', label: 'הצלבת תמ״ת' },
];

export default function EmunahEnrollment() {
  const [params, setParams] = useSearchParams();
  const initial = VIEWS.some(v => v.id === params.get('view')) ? params.get('view') : 'clicktac';
  const [view, setView] = useState(initial);

  const change = (_e, next) => {
    setView(next);
    // replace, not push: flipping between the two tabs should not fill the
    // back button with the same page twice.
    setParams(next === 'clicktac' ? {} : { view: next }, { replace: true });
  };

  return (
    <Box>
      <Tabs
        value={view}
        onChange={change}
        sx={{ borderBottom: 1, borderColor: 'divider', px: 2, pt: 1 }}
      >
        {VIEWS.map(v => <Tab key={v.id} value={v.id} label={v.label} />)}
      </Tabs>

      {/* Mounted one at a time on purpose: each side loads its own branch,
          year and file history, and holding both would double every request
          for a screen only one half of which is ever being read. */}
      {view === 'clicktac' ? <ExternalEnrollments /> : <TmtReconcile />}
    </Box>
  );
}
