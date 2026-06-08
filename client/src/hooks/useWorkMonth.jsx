import { createContext, useContext, useState, useCallback } from 'react';

const WorkMonthContext = createContext(null);

function currentYearMonth() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * A single "work month" (YYYY-MM) shared across every payroll screen — the
 * salary table, payslip audit, etc. During payday work the user stays on one
 * month (e.g. May); persisting it here keeps every screen in sync so switching
 * tabs no longer resets the month back to the current calendar month.
 */
export function WorkMonthProvider({ children }) {
  const [month, setMonthState] = useState(() => localStorage.getItem('workMonth') || currentYearMonth());

  const setMonth = useCallback((m) => {
    const v = m || currentYearMonth();
    setMonthState(v);
    localStorage.setItem('workMonth', v);
  }, []);

  return (
    <WorkMonthContext.Provider value={{ month, setMonth }}>
      {children}
    </WorkMonthContext.Provider>
  );
}

export function useWorkMonth() {
  const ctx = useContext(WorkMonthContext);
  if (!ctx) return { month: currentYearMonth(), setMonth: () => {} };
  return ctx;
}
