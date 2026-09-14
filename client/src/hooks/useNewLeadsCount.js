import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from './useAuth';
import { useBranch } from './useBranch';

/** How many new (unhandled) parent leads wait for this user. 0 for everyone else. */
export function useNewLeadsCount() {
  const { isAdmin, isAccountant, isManager } = useAuth();
  // The count is scoped to the selected gan by api/client.js, so switching
  // gans has to re-ask — otherwise the rail keeps the previous gan's badge.
  const { selectedBranch } = useBranch();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!(isAdmin || isAccountant || isManager)) { setCount(0); return undefined; }
    let alive = true;
    const load = () => api.get('/leads/counts')
      .then(res => { if (alive) setCount(res.data.new || 0); })
      .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [isAdmin, isAccountant, isManager, selectedBranch]);
  return count;
}
