const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  ensureDashboardSnapshotTable,
  getDataVersion,
  getCachedSnapshot,
  putSnapshot,
} = require('../server/services/dashboardSnapshotService');
const { publishDashboardVersion } = require('../server/services/scheduler');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
  `);
  ensureDashboardSnapshotTable(db);
  return db;
}

function createLocalStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
}

test('scheduler publishes the new version before warming snapshots', async () => {
  const db = createDb();
  let versionObservedByWarmer = null;

  const result = await publishDashboardVersion(db, 'test cycle', async () => {
    versionObservedByWarmer = getDataVersion(db);
    putSnapshot(db, 'default', versionObservedByWarmer, { value: 'fresh' });
    return { warmed: 1, failed: 0 };
  });

  assert.equal(result.dataVersion, '1');
  assert.equal(versionObservedByWarmer, '1');
  assert.deepEqual(getCachedSnapshot(db, 'default', '1'), { value: 'fresh' });
  db.close();
});

test('publishing a later scheduler version invalidates prior snapshots', async () => {
  const db = createDb();
  await publishDashboardVersion(db, 'first cycle', async () => {
    putSnapshot(db, 'default', getDataVersion(db), { value: 'old' });
    return { warmed: 1, failed: 0 };
  });

  await publishDashboardVersion(db, 'second cycle');

  assert.equal(getDataVersion(db), '2');
  assert.equal(getCachedSnapshot(db, 'default', '2'), null);
  assert.deepEqual(getCachedSnapshot(db, 'default', '1'), { value: 'old' });
  db.close();
});

test('snapshot warm failure does not prevent version publication', async () => {
  const db = createDb();
  const result = await publishDashboardVersion(db, 'failed warm', async () => {
    throw new Error('warm failed');
  });

  assert.equal(getDataVersion(db), '1');
  assert.equal(result.failed, 1);
  db.close();
});

test('client cache decisions distinguish valid, stale, and offline versions', async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '../client/src/utils/dashboardSummaryCache.js')).href;
  const { resolveDashboardCacheState } = await import(moduleUrl);

  assert.equal(resolveDashboardCacheState('7', 7), 'valid');
  assert.equal(resolveDashboardCacheState('7', '8'), 'stale');
  assert.equal(resolveDashboardCacheState('7', null), 'offline');
});

test('client cache entries can be explicitly evicted after a mismatch', async () => {
  global.window = { localStorage: createLocalStorage() };
  const moduleUrl = `${pathToFileURL(path.join(__dirname, '../client/src/utils/dashboardSummaryCache.js')).href}?storage-test`;
  const {
    getCachedDashboardSummary,
    removeCachedDashboardSummary,
    setCachedDashboardSummary,
  } = await import(moduleUrl);

  setCachedDashboardSummary('scope', { total: 42 }, '3');
  assert.deepEqual(getCachedDashboardSummary('scope'), { data: { total: 42 }, dataVersion: '3' });

  removeCachedDashboardSummary('scope');
  assert.equal(getCachedDashboardSummary('scope'), null);
  delete global.window;
});
