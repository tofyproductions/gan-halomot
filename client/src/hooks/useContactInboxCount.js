import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from './useAuth';

/**
 * How many "פניות למשרד" wait for this office person — only the topics the
 * admin grid gives them (the server decides). 0 for everyone else.
 */
const OFFICE_ROLES = ['system_admin', 'accountant', 'admin_viewer'];
export const CHANGED_EVENT = 'contact-inbox-changed';

export function useContactInboxCount() {
  const { user } = useAuth();
  const office = OFFICE_ROLES.includes(user?.role);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!office) { setCount(0); return undefined; }
    let alive = true;
    const load = () => api.get('/contact-requests/counts')
      .then(res => { if (alive) setCount(res.data.open || 0); })
      .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    // A reply or close in this tab should not wait a minute to show.
    window.addEventListener(CHANGED_EVENT, load);
    return () => { alive = false; clearInterval(t); window.removeEventListener(CHANGED_EVENT, load); };
  }, [office]);
  return count;
}
