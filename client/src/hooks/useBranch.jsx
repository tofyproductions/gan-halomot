import { createContext, useContext, useState, useEffect } from 'react';
import api from '../api/client';

const BranchContext = createContext(null);

export function BranchProvider({ children }) {
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState(() => {
    return localStorage.getItem('selectedBranch') || '';
  });
  const [loading, setLoading] = useState(true);

  const fetchBranches = () => {
    api.get('/branches')
      .then((res) => {
        const list = res.data.branches || [];
        setBranches(list);
        // If no branch selected and branches exist, select first
        if (!selectedBranch && list.length > 0) {
          const first = list[0]._id || list[0].id;
          setSelectedBranch(first);
          localStorage.setItem('selectedBranch', first);
        }
        // If selected branch no longer exists, reset.
        // 'all' is a valid pseudo-value (cross-branch view) — leave it.
        if (selectedBranch && list.length > 0 && selectedBranch !== 'all') {
          const exists = list.some(b => (b._id || b.id) === selectedBranch);
          if (!exists) {
            const first = list[0]._id || list[0].id;
            setSelectedBranch(first);
            localStorage.setItem('selectedBranch', first);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchBranches(); }, []); // eslint-disable-line

  const changeBranch = (id) => {
    setSelectedBranch(id);
    localStorage.setItem('selectedBranch', id);
  };

  // 'all' is a special pseudo-branch — components that support cross-branch
  // views (SalaryTable, AttendanceMonitor) detect it and fan out per branch.
  const isAllBranches = selectedBranch === 'all';
  const selectedBranchName = isAllBranches
    ? 'כל הסניפים'
    : (branches.find(b => (b._id || b.id) === selectedBranch)?.name || '');

  return (
    <BranchContext.Provider value={{
      branches,
      selectedBranch,
      selectedBranchName,
      isAllBranches,
      changeBranch,
      fetchBranches,
      loading,
    }}>
      {children}
    </BranchContext.Provider>
  );
}

export function useBranch() {
  const ctx = useContext(BranchContext);
  if (!ctx) throw new Error('useBranch must be used within BranchProvider');
  return ctx;
}
