import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getConfig, updateConfig } from '../services/api';

const AppSettingsContext = createContext(null);

const LEGACY_HIDE_SOLD_KEY = 'hideSoldInvestments';

function parseBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;
  return fallback;
}

function normalizeSettings(input) {
  const hideSoldInvestments = !!input.hideSoldInvestments;
  const includeFullySoldInReturns = hideSoldInvestments
    ? !!input.includeFullySoldInReturns
    : true;

  return {
    hideSoldInvestments,
    includeFullySoldInReturns,
  };
}

export function AppSettingsProvider({ children }) {
  const [settings, setSettings] = useState({
    hideSoldInvestments: true,
    includeFullySoldInReturns: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const cfg = await getConfig();
        if (!mounted) return;

        const legacyHideSold = parseBool(localStorage.getItem(LEGACY_HIDE_SOLD_KEY), true);
        const next = normalizeSettings({
          hideSoldInvestments: parseBool(cfg.hideSoldInvestments, legacyHideSold),
          includeFullySoldInReturns: parseBool(cfg.includeFullySoldInReturns, false),
        });
        setSettings(next);
        localStorage.setItem(LEGACY_HIDE_SOLD_KEY, String(next.hideSoldInvestments));
      } catch (e) {
        if (!mounted) return;
        setError(e.message || 'Failed to load app settings');
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  const saveSettings = async (partial) => {
    const next = normalizeSettings({ ...settings, ...partial });
    setSaving(true);
    setError(null);

    try {
      await updateConfig({
        hideSoldInvestments: String(next.hideSoldInvestments),
        includeFullySoldInReturns: String(next.includeFullySoldInReturns),
      });
      setSettings(next);
      localStorage.setItem(LEGACY_HIDE_SOLD_KEY, String(next.hideSoldInvestments));
      return next;
    } catch (e) {
      setError(e.message || 'Failed to save app settings');
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const value = useMemo(() => ({
    settings,
    loading,
    saving,
    error,
    saveSettings,
  }), [settings, loading, saving, error]);

  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings() {
  const ctx = useContext(AppSettingsContext);
  if (!ctx) {
    throw new Error('useAppSettings must be used inside AppSettingsProvider');
  }
  return ctx;
}
