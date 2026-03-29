/**
 * CAS Parser Test Suite
 *
 * Tests NSDL CAS detection (isNSDLCAS), module loading for all three
 * CAS parsers (CAMS, CDSL, NSDL), and the /api/cas/upload route's
 * detection-chain behaviour.
 *
 * Usage:  node --test tests/cas-parsers.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ──────────────────────────────────────────────────────────────────────
// Upload helper (multipart)
// ──────────────────────────────────────────────────────────────────────

async function upload(baseUrl, urlPath, fields, files) {
  const boundary = '----TestBoundary' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ));
  }
  for (const { field, name, buffer, contentType } of (files || [])) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`
    ));
    parts.push(buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// ──────────────────────────────────────────────────────────────────────
// 1. isNSDLCAS detection tests (pure function, no PDF needed)
// ──────────────────────────────────────────────────────────────────────

describe('isNSDLCAS detection', () => {
  const { isNSDLCAS } = require('../server/services/nsdlCasParser');

  it('detects primary "NSDL Consolidated Account Statement" marker', () => {
    const text = `
      Some header
      NSDL Consolidated Account Statement
      Statement for the period from 01/01/2025 to 31/03/2025
      Mr. John Doe
    `;
    assert.equal(isNSDLCAS(text), true);
  });

  it('detects secondary "NSDL demat account" marker without CDSL', () => {
    const text = `
      Account Statement
      NSDL demat account
      DP Id: IN301330
      Client Id: 12345678
    `;
    assert.equal(isNSDLCAS(text), true);
  });

  it('rejects "NSDL demat account" when CDSL appears in first 500 chars', () => {
    const text = `CDSL Consolidated Account Statement
      Some other text
      NSDL demat account
      DP Id: IN301330
    `;
    assert.equal(isNSDLCAS(text), false);
  });

  it('detects tertiary markers: period + DP Id + Client Id', () => {
    const text = `
      Account Information
      Statement for the period from 01-Apr-2025 to 30-Jun-2025
      Depository Participant Details
      DP Id: IN302201
      Client Id: 19876543
    `;
    assert.equal(isNSDLCAS(text), true);
  });

  it('returns false for CAMS-only text', () => {
    const text = `
      Consolidated Account Statement
      CAMS
      Folio No: 12345/67
      SBI Mutual Fund
      01-Oct-2023 Purchase 500.00 123.4567 100.00
    `;
    assert.equal(isNSDLCAS(text), false);
  });

  it('returns false for CDSL-only text', () => {
    const text = `
      CDSL Consolidated Account Statement
      As on 31-Mar-2025
      Demat Holdings
      INE002A01018 RELIANCE INDUSTRIES LTD 10 100 2,500.00 2,50,000.00
    `;
    assert.equal(isNSDLCAS(text), false);
  });

  it('returns false for empty/garbage text', () => {
    assert.equal(isNSDLCAS(''), false);
    assert.equal(isNSDLCAS('random text hello world'), false);
    assert.equal(isNSDLCAS('Investment Report 2025'), false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. Module-loading sanity checks
// ──────────────────────────────────────────────────────────────────────

describe('CAS parser modules load correctly', () => {
  it('casParser.js exports parseCAS', () => {
    const mod = require('../server/services/casParser');
    assert.equal(typeof mod.parseCAS, 'function');
  });

  it('camsCasParser.js exports parseCAMSCAS', () => {
    const mod = require('../server/services/camsCasParser');
    assert.equal(typeof mod.parseCAMSCAS, 'function');
  });

  it('nsdlCasParser.js exports parseNSDLCAS and isNSDLCAS', () => {
    const mod = require('../server/services/nsdlCasParser');
    assert.equal(typeof mod.parseNSDLCAS, 'function');
    assert.equal(typeof mod.isNSDLCAS, 'function');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. Route-level integration: /api/cas/upload detection chain
// ──────────────────────────────────────────────────────────────────────

describe('CAS upload route detection chain', () => {
  let BASE_URL;
  let server;
  let testDataDir;
  let db;

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-test-'));
    process.env.DATA_DIR = testDataDir;

    // Mock priceService
    const priceService = require('../server/services/priceService');
    priceService.lookupTickerByISIN = async (isin) => isin ? isin + '.NS' : null;
    priceService.fetchCorporateActions = async () => ({ dividends: [], splits: [] });

    const Database = require('better-sqlite3');
    const dbPath = path.join(testDataDir, 'investments.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const { initializeDb } = require('../server/db/schema');
    initializeDb(db);

    // Create a test portfolio
    db.prepare('INSERT INTO portfolios (name, pan_number) VALUES (?, ?)').run('Test User', 'ABCDE1234F');

    const express = require('express');
    const app = express();
    app.use(require('cors')());
    app.use(express.json());
    app.use('/api/cas', require('../server/routes/cas')(db));

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        BASE_URL = `http://localhost:${server.address().port}/api`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) db.close();
    if (testDataDir) fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  it('rejects upload without portfolio_id', async () => {
    const fakePdf = Buffer.from('%PDF-1.4 fake content');
    const res = await upload(BASE_URL, '/cas/preview', {}, [
      { field: 'file', name: 'cas.pdf', buffer: fakePdf, contentType: 'application/pdf' },
    ]);
    // Should fail — missing portfolio_id
    assert.equal(res.status, 400);
  });

  it('rejects non-PDF / unparseable file with sensible error', async () => {
    const garbage = Buffer.from('this is not a PDF');
    const res = await upload(BASE_URL, '/cas/upload',
      { portfolio_id: '1' },
      [{ field: 'file', name: 'cas.pdf', buffer: garbage, contentType: 'application/pdf' }],
    );
    // Should return an error status (not 200) — either 400/404/500 depending on
    // how far the chain gets before the invalid content is detected
    assert.ok(res.status >= 400, `Expected error status, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  it('returns 400 when no file is provided', async () => {
    const res = await upload(BASE_URL, '/cas/preview', { portfolio_id: '1' }, []);
    assert.equal(res.status, 400);
  });
});
