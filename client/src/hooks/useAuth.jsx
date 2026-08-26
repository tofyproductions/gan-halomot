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

  // Keep the profile fresh so permission changes an admin makes (role-wide or
  // per-user) take effect without the user re-logging in: refetch on window
  // focus and once a minute while the tab is open.
  useEffect(() => {
    if (!localStorage.getItem('token')) return;
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      api.get('/auth/me')
        .then(res => { if (!cancelled) setUser(res.data.user); })
        .catch(() => { /* transient — keep the current session */ });
    };
    const id = setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener('focus', refresh); };
  }, []);

  const applyAuth = (data) => {
    localStorage.setItem('token', data.token);
    setUser(data.user);
    if (data.user.branch_id) localStorage.setItem('selectedBranch', data.user.branch_id);
  };

  // Step 1. May return { needs_password: true } (no token) → caller must then
  // call loginWithPassword. Otherwise it logs in and may carry password_prompt.
  const login = async (full_name, id_number, rememberMe = false) => {
    const res = await api.post('/auth/login', { full_name, id_number, rememberMe });
    if (res.data.needs_password) return res.data;
    applyAuth(res.data);
    return res.data;
  };

  /**
   * Forgotten password, in two calls: text a code to the phone we already hold,
   * then swap the code for a new password.
   *
   * The second call signs them in — the server hands back a token exactly as a
   * login does. Sending somebody back to a login screen to type the password
   * they chose four seconds ago is a step that only loses people.
   */
  const requestResetCode = async (full_name, id_number) => {
    const res = await api.post('/auth/forgot-password', { full_name, id_number });
    return res.data;                    // { ok, phone_hint, expires_in_minutes }
  };

  const resetWithCode = async (full_name, id_number, code, password, rememberMe = false) => {
    const res = await api.post('/auth/reset-with-code', { full_name, id_number, code, password, rememberMe });
    applyAuth(res.data);
    return res.data;
  };

  // Step 2 (when the user has a password set).
  const loginWithPassword = async (full_name, id_number, password, rememberMe = false) => {
    const res = await api.post('/auth/login-password', { full_name, id_number, password, rememberMe });
    applyAuth(res.data);
    return res.data;
  };

  // User chooses/changes their own login password, then refresh the profile.
  //
  // The response carries a NEW token. It matters when the password being
  // replaced was a temporary one: the old token says the password must change,
  // and every request other than this one is refused while it is held — so
  // without swapping it the person chooses a password and stays locked out by
  // the choice.
  const setPassword = async (password) => {
    const { data } = await api.post('/auth/set-password', { password });
    if (data && data.token) applyAuth(data);
    const me = await api.get('/auth/me');
    setUser(me.data.user);
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
    <AuthContext.Provider value={{ user, loading, login, loginWithPassword, requestResetCode, resetWithCode, setPassword, logout, isAuthenticated, isAdmin, isAccountant, isManager, canSeeAllBranches }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
