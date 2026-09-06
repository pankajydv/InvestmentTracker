// Shared persistent, version-aware cache for dashboard summary payloads.
// Used by both the main Dashboard and the per-asset-type dashboard so they use
// identical keying/format and can even share entries for the same scope+filters.
//
// Freshness is guarded by the server `dataVersion` (compared by callers). The TTL
// here is only a soft safety cap. Storage is bounded with oldest-eviction and fails
// open on quota errors (network remains the source of truth).

const DASHBOARD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
// v7: include asset-type namespaced keys to avoid cross-type cache collisions.
const DASHBOARD_CACHE_PREFIX = 'itrack:dash:v7:';
const DASHBOARD_CACHE_MAX_ENTRIES = 24;

export function resolveDashboardCacheState(cachedVersion, serverVersion) {
  if (serverVersion == null) return 'offline';
  return String(serverVersion) === String(cachedVersion) ? 'valid' : 'stale';
}

export function getDashboardCacheKey({
  targetPortfolioId,
  hideSold,
  selectedInterval,
  customFromDate,
  customToDate,
  extra,
}) {
  return JSON.stringify({
    targetPortfolioId: targetPortfolioId ?? null,
    hideSold: !!hideSold,
    selectedInterval: selectedInterval || '1D',
    customFromDate: customFromDate || null,
    customToDate: customToDate || null,
    extra: extra ?? null,
  });
}

function safeLocalStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch (_e) {
    return null;
  }
}

export function getCachedDashboardSummary(cacheKey) {
  const store = safeLocalStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(DASHBOARD_CACHE_PREFIX + cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data) return null;
    if (parsed.ts && (Date.now() - parsed.ts) > DASHBOARD_CACHE_TTL_MS) {
      store.removeItem(DASHBOARD_CACHE_PREFIX + cacheKey);
      return null;
    }
    return { data: parsed.data, dataVersion: parsed.dataVersion ?? null };
  } catch (_e) {
    return null;
  }
}

export function removeCachedDashboardSummary(cacheKey) {
  const store = safeLocalStorage();
  if (!store) return;
  try {
    store.removeItem(DASHBOARD_CACHE_PREFIX + cacheKey);
  } catch (_e) {
    // fail open
  }
}

function evictOldDashboardCache(store) {
  try {
    const entries = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(DASHBOARD_CACHE_PREFIX)) {
        let ts = 0;
        try { ts = JSON.parse(store.getItem(key))?.ts || 0; } catch (_e) { ts = 0; }
        entries.push({ key, ts });
      }
    }
    if (entries.length <= DASHBOARD_CACHE_MAX_ENTRIES) return;
    entries.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < entries.length - DASHBOARD_CACHE_MAX_ENTRIES; i += 1) {
      store.removeItem(entries[i].key);
    }
  } catch (_e) {
    // best effort
  }
}

function clearDashboardCacheNamespace(store) {
  try {
    const keys = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(DASHBOARD_CACHE_PREFIX)) keys.push(key);
    }
    keys.forEach((k) => store.removeItem(k));
  } catch (_e) {
    // best effort
  }
}

export function setCachedDashboardSummary(cacheKey, data, dataVersion) {
  if (!data) return;
  const store = safeLocalStorage();
  if (!store) return;
  const payload = JSON.stringify({ ts: Date.now(), dataVersion: dataVersion ?? null, data });
  try {
    store.setItem(DASHBOARD_CACHE_PREFIX + cacheKey, payload);
    evictOldDashboardCache(store);
  } catch (_e) {
    // Likely QuotaExceededError: drop our namespace and retry once; fail open.
    clearDashboardCacheNamespace(store);
    try {
      store.setItem(DASHBOARD_CACHE_PREFIX + cacheKey, payload);
    } catch (_e2) {
      // give up silently — network remains the source of truth
    }
  }
}
