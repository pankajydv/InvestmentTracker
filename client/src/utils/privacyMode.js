import { useEffect, useState } from 'react';

const PRIVACY_EVENT = 'privacy-mask-changed';

function applyPrivacyMasked(masked, { emit = true } = {}) {
  if (typeof document !== 'undefined' && document.body) {
    document.body.dataset.privacyMasked = masked ? '1' : '0';
  }

  if (typeof window !== 'undefined') {
    if (emit) {
      window.dispatchEvent(new CustomEvent(PRIVACY_EVENT, { detail: { masked } }));
    }
  }
}

export function getPrivacyMasked() {
  if (typeof document !== 'undefined' && document.body) {
    if (document.body.dataset.privacyMasked === '1') return true;
    if (document.body.dataset.privacyMasked === '0') return false;
  }
  return true;
}

export function setPrivacyMasked(masked) {
  const next = !!masked;
  const current = getPrivacyMasked();
  if (current === next) {
    // Keep stores aligned but avoid unnecessary event storms.
    applyPrivacyMasked(next, { emit: false });
    return;
  }
  applyPrivacyMasked(next, { emit: true });
}

export function togglePrivacyMasked() {
  setPrivacyMasked(!getPrivacyMasked());
}

export function subscribePrivacyMaskChange(onChange) {
  if (typeof window === 'undefined') return () => {};
  const handler = () => onChange(getPrivacyMasked());
  window.addEventListener(PRIVACY_EVENT, handler);
  return () => window.removeEventListener(PRIVACY_EVENT, handler);
}

export function usePrivacyMaskState() {
  const [masked, setMasked] = useState(() => getPrivacyMasked());

  useEffect(() => {
    applyPrivacyMasked(masked, { emit: false });
  }, []);

  useEffect(() => subscribePrivacyMaskChange(setMasked), []);

  const setMaskedAndBroadcast = (nextMasked) => {
    const next = !!nextMasked;
    setMasked(next);
    setPrivacyMasked(next);
  };

  const toggleMasked = () => {
    const next = !getPrivacyMasked();
    setMasked(next);
    setPrivacyMasked(next);
  };

  return {
    masked,
    setMasked: setMaskedAndBroadcast,
    toggleMasked,
  };
}

export function usePrivacyMaskRefresh() {
  const [, setTick] = useState(0);
  useEffect(() => subscribePrivacyMaskChange(() => setTick((t) => t + 1)), []);
}
