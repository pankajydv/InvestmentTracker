import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const PrivacyModeContext = createContext(null);

function readInitialMaskState() {
  return true;
}

export function PrivacyModeProvider({ children }) {
  const [masked, setMasked] = useState(() => readInitialMaskState());

  useEffect(() => {
    if (typeof document !== 'undefined' && document.body) {
      document.body.dataset.privacyMasked = masked ? '1' : '0';
    }
  }, [masked]);

  const value = useMemo(() => ({
    masked,
    setMasked,
    toggleMasked: () => setMasked((prev) => !prev),
  }), [masked]);

  return (
    <PrivacyModeContext.Provider value={value}>
      {children}
    </PrivacyModeContext.Provider>
  );
}

export function usePrivacyMode() {
  const ctx = useContext(PrivacyModeContext);
  if (!ctx) {
    throw new Error('usePrivacyMode must be used inside PrivacyModeProvider');
  }
  return ctx;
}
