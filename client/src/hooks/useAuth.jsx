import { useState, useEffect, createContext, useContext } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      api.get('/auth/me')
        .then(res => setUser(res.data.user))
        .catch(() => { localStorage.removeItem('token'); setUser(null); })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (full_name, id_number, rememberMe = false) => {
    const res = await api.post('/auth/login', { full_name, id_number, rememberMe });
    localStorage.setItem('token', res.data.token);
    setUser(res.data.user);
    if (res.data.user.branch_id) {
      localStorage.setItem('selectedBranch', res.data.user.branch_id);
    }
    return res.data;
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
    window.location.href = '/login';
  };

  const isAuthenticated = !!user;
  const isAdmin = user?.role === 'system_admin';
  const isAccountant = user?.role === 'accountant';
  const isManager = user?.role === 'branch_manager' || isAdmin;
  // Can use the cross-branch "כל הסניפים" view: admins always; accountants
  // (they need cross-branch payroll consolidation); managers who oversee
  // more than one branch (multi-branch heads like Lidor).
  const canSeeAllBranches = isAdmin || isAccountant || (user?.managed_branch_ids?.length || 0) > 1;

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, isAuthenticated, isAdmin, isAccountant, isManager, canSeeAllBranches }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
