import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from './useAuth';

/** How many viewer proposals wait for the office. 0 for everyone else. */
export function usePendingProposals() {
  const { isAdmin, isAccountant } = useAuth();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!(isAdmin || isAccountant)) { setCount(0); return undefined; }
    let alive = true;
    const load = () => api.get('/proposed-changes/count')
      .then(res => { if (alive) setCount(res.data.pending_count || 0); })
      .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [isAdmin, isAccountant]);
  return count;
}
