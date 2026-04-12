/**
 * NPS Statement Parser
 *
 * Parses NPS transaction statements from Protean CSV files
 * (two column layouts: with/without charges column).
 *
 * Transaction types use standard EMPLOYER_CONTRIBUTION/VOLUNTARY_CONTRIBUTION/
 * TRANSFER_IN/TRANSFER_OUT/AMC.
 * Employer vs Voluntary distinction is captured in the `broker` field
 * (from the "Uploaded By" column in the Contribution/Redemption section).
 *
 * Returns: { pran, subscriberName, schemeChoice, schemes[], transactions[] }
 * Each scheme = { name, shortCode } (e.g. "SBI PENSION FUND SCHEME E - TIER I")
 * Each transaction = { date, particulars, type, schemeName, amount, nav, units, charges, broker }
 */

// ─── Helpers ─────────────────────────────────────────────────────────

/** Parse Indian-format number: "1,70,000.00" → 170000, "(141,128.99)" → -141128.99 */
function parseNum(s) {
  if (!s) return 0;
  s = s.trim();
  if (!s || s === '-') return 0;
  const neg = s.startsWith('(') && s.endsWith(')');
  const cleaned = s.replace(/[(),Rs₹\s]/g, '');
  const val = parseFloat(cleaned) || 0;
  return neg ? -val : val;
}

/** Convert "05-Jan-2018" or "05-Jan-18" or "11-May-2021" → "2018-01-05" */
const MONTHS = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
                 Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };

function toISO(dateStr) {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  const m = dateStr.match(/^(\d{1,2})-(\w{3})-(\d{2,4})$/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const mon = MONTHS[m[2]];
  if (!mon) return null;
  let year = m[3];
  if (year.length === 2) year = (parseInt(year) > 50 ? '19' : '20') + year;
  return `${year}-${mon}-${day}`;
}

/**
 * Detect CRA (Central Recordkeeping Agency) from statement text.
 * PDF footers contain "Karvy" or "KFintech"; CSV headers identify Protean format.
 */
function detectCRA(text) {
  const lower = text.toLowerCase();
  if (lower.includes('kfintech')) return 'KFintech';
  if (lower.includes('karvy')) return 'Karvy';
  if (lower.includes('protean')) return 'Protean';
  if (lower.includes('nps transaction statement')) return 'Protean'; // Protean CSV format header
  return '';
}

/**
 * Classify NPS transaction from its "Particulars" text.
 * Returns: 'EMPLOYER_CONTRIBUTION' | 'VOLUNTARY_CONTRIBUTION' | 'AMC' |
 * 'TRANSFER_IN' | 'TRANSFER_OUT' | 'SKIP' | 'SIGN_DEPENDENT_REBALANCE' | 'SIGN_DEPENDENT_PFM'
 *
 * Contributions (employer and voluntary) keep separate contribution types.
 * Billing/charges → AMC
 * Rebalancing and migration/switch entries are sign-dependent transfers.
 */
function classifyTransaction(particulars) {
  const p = particulars.toLowerCase().trim();

  if (p.includes('opening balance') || p.includes('closing balance')) return 'SKIP';
  // Migration entries are consolidation summaries (e.g. registrar change from Karvy);
  // the underlying individual transactions are what should be imported instead.
  if (p.includes('migration') || p.includes('units credited on account of migration')) return 'SKIP';
  if (p.includes('billing for')) return 'AMC';
  if (p.includes('rebalancing')) return 'SIGN_DEPENDENT_REBALANCE';
  if (p.includes('pfm change request') || p.includes('inter pfm switch')
      || p.includes('t2 to t1') || p.includes('tier ii to tier i')
      || p.includes('scheme preference change')) return 'SIGN_DEPENDENT_PFM';
  if (p.includes('persistency switch out')) return 'AMC';
  if (p.includes('one way switch')) return 'SIGN_DEPENDENT_PFM';
  // Contributions: distinguish employer vs voluntary
  if (p.includes('voluntary contribution')) return 'VOLUNTARY_CONTRIBUTION';
  if (p.includes('contribution') || p.includes('by contribution')) return 'EMPLOYER_CONTRIBUTION';

  // Default: treat as sign-dependent
  return 'SIGN_DEPENDENT_REBALANCE';
}

/**
 * Resolve final type for sign-dependent transaction types.
 */
function resolveType(baseType, amount) {
  if (baseType === 'SIGN_DEPENDENT_REBALANCE') {
    return amount >= 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT';
  }
  if (baseType === 'SIGN_DEPENDENT_PFM') {
    return amount >= 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT';
  }
  return baseType;
}

/**
 * Extract scheme names from column header cells (CSV).
 * Looks for patterns like "SBI PENSION FUND SCHEME E - TIER I Amount (Rs)"
 * and extracts the scheme name before " Amount", " NAV", " Units".
 */
function extractSchemeNamesFromHeader(headerCells) {
  const schemes = [];
  const seen = new Set();
  for (const cell of headerCells) {
    const trimmed = cell.trim();
    // Match: "<SCHEME NAME> Amount (Rs)" or "<SCHEME NAME> NAV (Rs)" or "<SCHEME NAME> Units"
    // Requires the keyword at the end to avoid matching charges column
    const m = trimmed.match(/^(.+?)\s+(?:Amount|NAV|Units)\s*(?:\(Rs\))?\s*$/i);
    if (m) {
      let name = normalizeScheme(m[1].trim().replace(/\s*\(Rs\)\s*$/, '').trim());
      if (!seen.has(name)) {
        seen.add(name);
        const codeMatch = name.match(/SCHEME\s+([A-Z])\s*-/i);
        schemes.push({ name, shortCode: codeMatch ? codeMatch[1] : '' });
      }
    }
  }
  return schemes;
}

/** Normalize NPS scheme name: strip trailing " POP" (Point of Presence indicator) */
function normalizeScheme(name) {
  return name.replace(/\s+POP\s*$/i, '').trim();
}


// ─── CSV Parser ──────────────────────────────────────────────────────

function parseNPSCSV(csvContent) {
  const lines = csvContent.split('\n').map(l => l.replace(/\r$/, ''));

  const broker = detectCRA(csvContent);

  let pran = '';
  let subscriberName = '';
  let schemeChoice = '';
  const schemes = [];
  const contributions = []; // from Contribution/Redemption section
  const transactions = []; // from Transaction Details section

  let section = 'header'; // header | contribution | transaction

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("PRAN,")) {
      pran = line.split(',')[1].replace(/'/g, '').trim();
    }
    if (line.startsWith("Subscriber Name,")) {
      subscriberName = line.split(',')[1].replace(/^Shri\s+|^Smt\s+|^Ms\s+|^Mr\s+/i, '').trim();
    }
    if (line.includes('Scheme Choice')) {
      const m = line.match(/Scheme Choice\s*-?\s*(.+)/);
      if (m) schemeChoice = m[1].trim();
    }

    // Extract scheme names from "Investment Details" Particulars,References,... header (old format)
    if (line.startsWith('Particulars,References,')) {
      const cells = parseCSVLine(line);
      const headerSchemes = extractSchemeNamesFromHeader(cells);
      for (const s of headerSchemes) {
        s.name = normalizeScheme(s.name);
        if (!schemes.find(x => x.name === s.name)) schemes.push(s);
      }
    }

    // Extract scheme names from new transposed "Investment Details" format
    // Lines like: "NPS TRUST- A/C HDFC ... SCHEME E - TIER I POP,1181539.89,23559.3660,50.1516,"
    if (/SCHEME\s+[A-Z]\s*-\s*TIER/i.test(line) && section === 'header') {
      const cells = parseCSVLine(line);
      const schemeName = normalizeScheme(cells[0].trim());
      if (schemeName && /SCHEME\s+[A-Z]\s*-\s*TIER/i.test(schemeName) && !schemes.find(x => x.name === schemeName)) {
        const codeMatch = schemeName.match(/SCHEME\s+([A-Z])\s*-/i);
        schemes.push({ name: schemeName, shortCode: codeMatch ? codeMatch[1] : '' });
      }
    }

    // Contribution/Redemption section
    if (line.includes('Contribution/Redemption Details')) {
      section = 'contribution';
      continue;
    }
    if (line.includes('Transaction Details')) {
      section = 'transaction';
      continue;
    }

    if (section === 'contribution') {
      if (line.startsWith('Date,Particulars') || !line.trim()) continue;
      const cells = parseCSVLine(line);
      if (cells.length >= 6) {
        const date = toISO(cells[0].trim());
        if (!date) continue;
        const particulars = cells[1].trim();
        // "Uploaded By" is column index 2, e.g. "HDFC Securities Limited (5000542)"
        const uploadedBy = cells[2] ? cells[2].trim().replace(/\s*\(\d+\)\s*$/, '') : '';
        const employee = parseNum(cells[3]);
        const employer = parseNum(cells[4]);
        const total = parseNum(cells[5]);
        contributions.push({ date, particulars, uploadedBy, employee, employer, total });
      }
    }

    if (section === 'transaction') {
      // ── Format A: Wide table (old) ──
      // One header: "Date,Particulars,[charges],SchemeE-Amt,SchemeE-NAV,SchemeE-Units,SchemeC-Amt,..."
      if (line.startsWith('Date,Particulars')) {
        const headerCells = parseCSVLine(line);
        const hasChargesCol = headerCells.some(c =>
          c.toLowerCase().includes('intermediary charges') ||
          c.toLowerCase().includes('withdrawal/ deduction')
        );

        // Extract scheme names from header columns
        const headerSchemes = extractSchemeNamesFromHeader(headerCells);
        for (const s of headerSchemes) {
          if (!schemes.find(x => x.name === s.name)) schemes.push(s);
        }

        // Build date → uploadedBy lookup from contributions
        const brokerMap = new Map();
        for (const c of contributions) {
          if (c.uploadedBy) brokerMap.set(c.date, c.uploadedBy);
        }

        // Parse all subsequent transaction lines
        for (let j = i + 1; j < lines.length; j++) {
          const txnLine = lines[j].trim();
          if (!txnLine) continue;

          const cells = parseCSVLine(txnLine);
          if (cells.length < 4) continue;

          const date = toISO(cells[0].trim());
          if (!date) continue;

          const particulars = cells[1].trim();
          if (!particulars) continue;

          const baseType = classifyTransaction(particulars);
          if (baseType === 'SKIP') continue;

          // Column layout:
          // With charges: [date, particulars, charges, E-amt, E-nav, E-units, C-amt, ...]
          // Without:      [date, particulars, E-amt, E-nav, E-units, C-amt, ...]
          const offset = hasChargesCol ? 3 : 2;
          const charges = hasChargesCol ? parseNum(cells[2]) : 0;

          for (let s = 0; s < schemes.length; s++) {
            const amtIdx = offset + s * 3;
            const navIdx = offset + s * 3 + 1;
            const unitsIdx = offset + s * 3 + 2;

            const amount = parseNum(cells[amtIdx]);
            const nav = parseNum(cells[navIdx]);
            const units = parseNum(cells[unitsIdx]);

            if (amount === 0 && units === 0) continue;

            const txnType = resolveType(baseType, amount);

            transactions.push({
              date,
              particulars,
              type: txnType,
              schemeName: schemes[s].name,
              amount: Math.abs(amount),
              nav: Math.abs(nav),
              units: Math.abs(units),
              charges: s === 0 ? Math.abs(charges) : 0,
              broker,
            });
          }
        }
        break;
      }

      // ── Format B: Vertical per-scheme sections (new Protean format) ──
      // Each scheme has: scheme name line, then "Date,Description,Amount (in Rs),NAV,Units"
      // Detect a scheme name line (non-empty, no comma or starts with known scheme patterns)
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith('Date,') && !toISO(trimmedLine.split(',')[0]?.trim())) {
        // Check if this looks like a scheme name (contains SCHEME and TIER, or "PENSION FUND")
        if (/SCHEME\s+[A-Z]\s*-\s*TIER/i.test(trimmedLine) || /PENSION\s+FUND/i.test(trimmedLine)) {
          const schemeName = normalizeScheme(trimmedLine.replace(/,+$/, '').trim());
          const codeMatch = schemeName.match(/SCHEME\s+([A-Z])\s*-/i);
          if (!schemes.find(x => x.name === schemeName)) {
            schemes.push({ name: schemeName, shortCode: codeMatch ? codeMatch[1] : '' });
          }

          // Next non-empty line should be the header
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && lines[j].trim().startsWith('Date,')) {
            j++; // skip header line

            // Build date → uploadedBy lookup from contributions
            const brokerMap = new Map();
            for (const c of contributions) {
              if (c.uploadedBy) brokerMap.set(c.date, c.uploadedBy);
            }

            // Parse transaction rows until next blank line or scheme name
            for (; j < lines.length; j++) {
              const txnLine = lines[j].trim();
              if (!txnLine) break;
              // Stop if next scheme section starts
              if (/SCHEME\s+[A-Z]\s*-\s*TIER/i.test(txnLine) || /PENSION\s+FUND/i.test(txnLine)) break;

              const cells = parseCSVLine(txnLine);
              if (cells.length < 4) continue;

              const date = toISO(cells[0].trim());
              if (!date) continue;

              const particulars = cells[1].trim();
              if (!particulars) continue;

              const baseType = classifyTransaction(particulars);
              if (baseType === 'SKIP') continue;

              // Columns: Date, Description, Amount, NAV, Units
              const amount = parseNum(cells[2]);
              const nav = parseNum(cells[3]);
              const units = parseNum(cells[4]);

              if (amount === 0 && units === 0) continue;

              const txnType = resolveType(baseType, amount);

              transactions.push({
                date,
                particulars,
                type: txnType,
                schemeName,
                amount: Math.abs(amount),
                nav: Math.abs(nav),
                units: Math.abs(units),
                charges: 0,
                broker,
              });
            }
          }
        }
      }
    }
  }

  return { pran, subscriberName, schemeChoice, schemes, contributions, transactions };
}

/**
 * Simple CSV line parser handling commas inside quoted fields
 */
function parseCSVLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}


// ─── PDF Parser (Karvy/KFintech NPS statements) ─────────────────────

/**
 * Parse NPS transaction PDF.
 * Returns same structure as parseNPSCSV:
 *   { pran, subscriberName, schemeChoice, schemes[], contributions[], transactions[] }
 */
async function parseNPSPDF(buffer, password) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    password: password || '',
  }).promise;

  // Extract positioned text items per page, grouped into rows
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
    const content = await page.getTextContent();
    const items = content.items
      .filter(it => it.str.trim())
      .map(it => ({
        text: it.str,
        x: Math.round(it.transform[4]),
        y: Math.round(viewport.height - it.transform[5]),
      }))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    const rows = [];
    let cur = null;
    for (const item of items) {
      if (!cur || Math.abs(item.y - cur.y) > 4) {
        cur = { y: item.y, items: [] };
        rows.push(cur);
      }
      cur.items.push(item);
    }
    pages.push({ pageNum: p, rows });
  }

  let pran = '', subscriberName = '';
  const schemes = [];
  const contributions = [];
  const transactions = [];

  // Extract metadata from page 1 rows (sorted top-to-bottom)
  let foundSubscriberSection = false;
  for (const page of pages) {
    for (const row of page.rows) {
      const text = row.items.map(i => i.text).join(' ');
      if (!pran) {
        const m = text.match(/PRAN\s+(\d{12})/);
        if (m) pran = m[1];
      }
      if (!subscriberName) {
        if (/Subscriber Details/i.test(text)) {
          foundSubscriberSection = true;
        } else if (foundSubscriberSection) {
          // First non-header row after "Subscriber Details" is the name
          const nameText = row.items.filter(i => i.x < 200).map(i => i.text).join(' ').trim();
          if (nameText && !/^PRAN/i.test(nameText)) {
            subscriberName = nameText.replace(/^Shri\s+|^Smt\s+|^Ms\s+|^Mr\s+/i, '').trim();
          }
        }
      }
    }
    if (pran && subscriberName) break;
  }

  // Detect CRA from page text (footer contains "Karvy" or "KFintech")
  const allText = pages.map(p => p.rows.map(r => r.items.map(i => i.text).join(' ')).join('\n')).join('\n');
  const broker = detectCRA(allText);

  // Process each page
  for (const page of pages) {
    parsePDFPage(page.rows, schemes, contributions, transactions, broker);
  }

  return { pran, subscriberName, schemeChoice: '', schemes, contributions, transactions };
}

/** Detect if a row's first item (x < 50) is a date string */
function rowDate(row) {
  const first = row.items[0];
  if (!first || first.x > 50) return null;
  return toISO(first.text.trim());
}

/** Parse a single PDF page for contribution + transaction sections */
function parsePDFPage(rows, schemes, contributions, transactions, broker) {
  let mode = 'scan'; // scan | contribution | transaction
  let contribHeaderFound = false;
  let currentSchemes = []; // Schemes for the current transaction table
  let columnDef = null;    // Column x-boundary definition
  let pendingTxn = null;   // Current transaction being assembled (date row)

  function flushPending() {
    if (!pendingTxn) return;
    emitTransactions(pendingTxn, currentSchemes, transactions, contributions, broker);
    pendingTxn = null;
  }

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const text = row.items.map(i => i.text).join(' ');

    // Detect section markers
    if (/Contribution\s*\/?\s*Redemption\s*Details/i.test(text)) {
      flushPending();
      mode = 'contribution';
      contribHeaderFound = false;
      continue;
    }
    if (/Transaction Details/i.test(text) && !text.includes("'Transaction Details'")) {
      flushPending();
      mode = 'transaction';
      currentSchemes = [];
      columnDef = null;
      continue;
    }
    // Notes section ends transaction parsing
    if (text.startsWith('Note:') || /^Page \d+ of/i.test(text)) {
      flushPending();
      mode = 'scan';
      continue;
    }

    // ── Contribution section ──
    if (mode === 'contribution') {
      // Skip contribution header row
      if (!contribHeaderFound && row.items.some(i => i.text === 'Date' && i.x < 60)) {
        contribHeaderFound = true;
        continue;
      }
      if (text.startsWith('Total') || text.includes('Transaction Details')) {
        if (text.includes('Transaction Details')) {
          // Transaction Details starts on same page after contributions
          flushPending();
          mode = 'transaction';
          currentSchemes = [];
          columnDef = null;
        } else {
          mode = 'scan';
        }
        continue;
      }
      const date = rowDate(row);
      if (date && contribHeaderFound) {
        // Parse contribution row
        const parts = row.items.filter(i => i.x >= 80);
        const particulars = parts.filter(i => i.x < 200).map(i => i.text).join(' ').trim();
        const uploadedBy = parts.filter(i => i.x >= 180 && i.x < 280).map(i => i.text).join(' ').trim();
        const numItems = parts.filter(i => i.x >= 280).sort((a, b) => a.x - b.x);
        // Columns: employer, employee, total (but opening balance rows may only have total)
        let employer = 0, employee = 0, total = 0;
        if (numItems.length >= 3) {
          employer = parseNum(numItems[0].text);
          employee = parseNum(numItems[1].text);
          total = parseNum(numItems[2].text);
        } else if (numItems.length === 1) {
          total = parseNum(numItems[0].text);
        }
        if (particulars.toLowerCase().includes('opening balance')) continue;
        contributions.push({ date, particulars, uploadedBy, employee, employer, total });
      }
      continue;
    }

    // ── Transaction section ──
    if (mode === 'transaction') {
      // Phase 1: Parse scheme names (before column header)
      if (!columnDef) {
        // Check if this row is the Amount/Units column header
        if (row.items.some(i => i.text.trim() === 'Amount (₹)' || i.text.trim() === 'Amount')) {
          // Extract column positions from Amount and Units headers
          const amtItems = row.items.filter(i => /^Amount/i.test(i.text.trim())).sort((a, b) => a.x - b.x);
          const unitItems = row.items.filter(i => /^Units$/i.test(i.text.trim())).sort((a, b) => a.x - b.x);
          if (amtItems.length >= 3 && unitItems.length >= 3) {
            columnDef = buildColumnDef(amtItems, unitItems);
          }
          continue;
        }
        // Otherwise, check if it's a scheme name row
        if (row.items.some(i => /Pension Fund|Scheme [A-Z]|Tier [IV]/i.test(i.text) && i.x > 170)) {
          // Collect scheme name fragments at x > 170 (exclude charges column header)
          const nameItems = row.items.filter(i => i.x > 170 && !/Withdrawal|deduction|units|intermediary|charges/i.test(i.text));
          if (nameItems.length > 0) {
            // Try to assign to 3 scheme columns
            assignSchemeNameItems(nameItems, currentSchemes);
          }
        }
        continue;
      }

      // Phase 2: Parse transaction rows (columnDef established)
      const lowerText = text.toLowerCase();

      // Opening Balance → skip (just units, no transaction)
      if (lowerText.includes('opening balance')) continue;

      // Closing Units → end of this table
      if (lowerText.includes('closing units') || lowerText.includes('closing balance')) {
        flushPending();
        // Register discovered schemes
        for (const s of currentSchemes) {
          if (s.name && !schemes.find(x => x.name === s.name)) {
            schemes.push(s);
          }
        }
        // Stay in transaction mode with cleared columnDef so we can pick up
        // a consecutive table on the same page (e.g. SBI → ICICI in 2020-21)
        mode = 'transaction';
        currentSchemes = [];
        columnDef = null;
        continue;
      }

      const date = rowDate(row);
      if (date) {
        // New date row → flush previous, start new
        flushPending();
        pendingTxn = { date, particularsParts: [], dataItems: [], navItems: [] };
        // Collect particulars (items with x in [70, 170))
        const partItems = row.items.filter(i => i.x >= 70 && i.x < 170);
        pendingTxn.particularsParts.push(partItems.map(i => i.text).join(' '));
        // Collect data items (x >= 170)
        const dataItems = row.items.filter(i => i.x >= 170);
        pendingTxn.dataItems.push(...dataItems);
      } else if (pendingTxn) {
        // Non-date row after a date row
        const numericItems = row.items.filter(i => i.x >= 200 && /^[\d.,()\-]+$/.test(i.text.trim()));
        const textItems = row.items.filter(i => i.x >= 70 && i.x < 170);

        if (numericItems.length > 0 && textItems.length === 0) {
          // NAV row (only numbers at scheme amount positions)
          pendingTxn.navItems.push(...numericItems);
        } else if (numericItems.length > 0 && textItems.length > 0) {
          // Mixed row (NAV values + continuation text, e.g. "Switch" at x=111 + NAVs)
          pendingTxn.navItems.push(...numericItems);
          pendingTxn.particularsParts.push(textItems.map(i => i.text).join(' '));
        } else if (textItems.length > 0) {
          // Continuation of particulars text
          pendingTxn.particularsParts.push(textItems.map(i => i.text).join(' '));
        }
      }
    }
  }
  flushPending();
  // Register any remaining discovered schemes
  for (const s of currentSchemes) {
    if (s.name && !schemes.find(x => x.name === s.name)) {
      schemes.push(s);
    }
  }
}

/** Build column definition from the Amount/Units header positions */
function buildColumnDef(amtItems, unitItems) {
  // amtItems and unitItems each have 3 items (one per scheme), sorted by x
  const cols = [];
  for (let i = 0; i < 3; i++) {
    cols.push({
      amtX: amtItems[i].x,
      unitsX: unitItems[i].x,
    });
  }
  // Build boundaries:
  // Between amount and units of same scheme: midpoint
  // Between schemes: midpoint of units[i] and amount[i+1]
  const boundaries = [];
  for (let i = 0; i < 3; i++) {
    const amtEnd = (cols[i].amtX + cols[i].unitsX) / 2;
    const unitsEnd = i < 2 ? (cols[i].unitsX + cols[i + 1].amtX) / 2 : 999;
    boundaries.push({ amtMin: i === 0 ? 200 : boundaries[i - 1].unitsEnd, amtEnd, unitsEnd });
  }
  return { cols, boundaries };
}

/** Assign a positioned item to a scheme column (returns { schemeIdx, isAmount } or null) */
function assignColumn(x, columnDef) {
  for (let i = 0; i < columnDef.boundaries.length; i++) {
    const b = columnDef.boundaries[i];
    if (x >= b.amtMin && x < b.amtEnd) return { schemeIdx: i, isAmount: true };
    if (x >= b.amtEnd && x < b.unitsEnd) return { schemeIdx: i, isAmount: false };
  }
  return null;
}

/** Collect scheme name items into 3 column buckets and build scheme names */
function assignSchemeNameItems(items, currentSchemes) {
  // Divide items into 3 columns based on x gaps
  // Items are sorted by x; find significant gaps to separate columns
  if (items.length === 0) return;

  // Simple approach: use x thresholds ~310 and ~450 to split into 3 columns
  const cols = [[], [], []];
  for (const item of items) {
    if (item.x < 310) cols[0].push(item.text);
    else if (item.x < 450) cols[1].push(item.text);
    else cols[2].push(item.text);
  }

  for (let i = 0; i < 3; i++) {
    if (cols[i].length === 0) continue;
    if (!currentSchemes[i]) {
      currentSchemes[i] = { name: '', shortCode: '' };
    }
    const existing = currentSchemes[i].name;
    const addition = cols[i].join(' ').trim();
    currentSchemes[i].name = existing ? (existing + ' ' + addition) : addition;
    // Extract short code
    const codeMatch = currentSchemes[i].name.match(/Scheme\s+([A-Z])\s*-/i);
    if (codeMatch) currentSchemes[i].shortCode = codeMatch[1];
  }
}

/** Emit transactions from a completed pendingTxn */
function emitTransactions(pending, currentSchemes, transactions, contributions, broker) {
  const { date, particularsParts, dataItems, navItems } = pending;
  const particulars = particularsParts.join(' ').trim();

  const baseType = classifyTransaction(particulars);
  if (baseType === 'SKIP') return;

  // Parse charges (items with x < 200)
  const chargeItems = dataItems.filter(i => i.x < 220);
  const chargesTotal = chargeItems.length > 0 ? Math.abs(parseNum(chargeItems[0].text)) : 0;

  // Parse per-scheme data items
  // Data items at x >= 220 → assign to scheme columns
  const schemeData = [{}, {}, {}]; // { amount, units }
  const schemeDataItems = dataItems.filter(i => i.x >= 220);

  for (const item of schemeDataItems) {
    const val = parseNum(item.text);
    if (val === 0 && item.text.trim() === '-') continue;
    // Use nearest scheme column based on x position
    const colIdx = nearestSchemeCol(item.x, currentSchemes.length);
    if (colIdx < 0) continue;
    if (!schemeData[colIdx].amount && schemeData[colIdx].amount !== 0) {
      schemeData[colIdx].amount = val;
    } else if (!schemeData[colIdx].units && schemeData[colIdx].units !== 0) {
      schemeData[colIdx].units = val;
    }
  }

  // Parse NAV items
  const schemeNavs = [0, 0, 0];
  for (const item of navItems) {
    const val = parseNum(item.text);
    if (val <= 0) continue;
    const colIdx = nearestSchemeCol(item.x, currentSchemes.length);
    if (colIdx >= 0) schemeNavs[colIdx] = Math.abs(val);
  }

  // Emit one transaction per scheme
  for (let s = 0; s < currentSchemes.length; s++) {
    const data = schemeData[s] || {};
    const amount = data.amount || 0;
    const units = data.units || 0;
    const nav = schemeNavs[s] || 0;

    if (amount === 0 && units === 0) continue;

    const txnType = resolveType(baseType, amount);

    transactions.push({
      date,
      particulars,
      type: txnType,
      schemeName: currentSchemes[s]?.name || `Unknown Scheme ${s}`,
      amount: Math.abs(amount),
      nav: Math.abs(nav),
      units: Math.abs(units),
      charges: s === 0 ? chargesTotal : 0,
      broker,
    });
  }
}

/** Find nearest scheme column index for a given x position */
function nearestSchemeCol(x, numSchemes) {
  // Approximate column centers for 3-scheme layout (from typical Karvy PDF):
  // Scheme 0: amt ~248, units ~306 → center ~277
  // Scheme 1: amt ~370, units ~422 → center ~396
  // Scheme 2: amt ~485, units ~540 → center ~512
  // Use boundaries at ~340 and ~455
  if (numSchemes < 3) return x < 400 ? 0 : 1;
  if (x < 340) return 0;
  if (x < 455) return 1;
  return 2;
}


// ─── Main entry point ────────────────────────────────────────────────

async function parseNPSStatements(files, password) {
  let pran = '';
  let subscriberName = '';
  let schemeChoice = '';
  const allSchemes = [];
  const allTransactions = [];

  for (const file of files) {
    const ext = file.originalname.toLowerCase();
    const isCSV = ext.endsWith('.csv');
    const isPDF = ext.endsWith('.pdf');
    if (!isCSV && !isPDF) continue;

    let parsed;
    if (isCSV) {
      const content = file.buffer.toString('utf-8');
      parsed = parseNPSCSV(content);
    } else {
      parsed = await parseNPSPDF(file.buffer, password);
    }

    if (!pran && parsed.pran) pran = parsed.pran;
    if (!subscriberName && parsed.subscriberName) subscriberName = parsed.subscriberName;
    if (!schemeChoice && parsed.schemeChoice) schemeChoice = parsed.schemeChoice;

    for (const s of parsed.schemes) {
      if (!allSchemes.find(x => x.name === s.name)) allSchemes.push(s);
    }
    allTransactions.push(...parsed.transactions);
  }

  // Deduplicate transactions by (date, schemeName, type, amount, units)
  const seen = new Set();
  const uniqueTransactions = [];
  for (const txn of allTransactions) {
    const key = `${txn.date}|${txn.schemeName}|${txn.type}|${Math.round(txn.amount * 100)}|${Math.round(txn.units * 1000)}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueTransactions.push(txn);
    }
  }

  uniqueTransactions.sort((a, b) => a.date.localeCompare(b.date));

  return {
    pran,
    subscriberName,
    schemeChoice,
    schemes: allSchemes,
    transactions: uniqueTransactions,
  };
}

module.exports = { parseNPSStatements, parseNPSCSV, parseNPSPDF };
