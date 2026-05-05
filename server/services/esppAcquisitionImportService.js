function parseNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const cleaned = text.replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function toIsoDate(value) {
  if (!value) return null;
  const input = String(value).trim();
  if (!input) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

  let m = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3]);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }

  m = input.match(/^([A-Za-z]{3})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const monthMap = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = monthMap[String(m[1]).toLowerCase()];
    if (month == null) return null;
    const day = Number(m[2]);
    const year = Number(m[3]);
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }

  return null;
}

function normalizeRow(raw = {}, index = 0, sourceLabel = '') {
  const offeringPeriod = String(raw.offering_period || raw.offering || '').trim();
  const purchaseDate = toIsoDate(raw.purchase_date || raw.purchaseDate);
  const purchaseQty = parseNumber(raw.purchase_quantity || raw.purchase_qty || raw.quantity || raw.qty);
  const purchasePrice = parseNumber(raw.purchase_price || raw.price || raw.price_per_unit);
  const purchaseValue = parseNumber(raw.purchase_value || raw.value || raw.usd_amount);
  const parsedFmvPurchaseDate = parseNumber(raw.fmv_purchase_date || raw.fmv_at_purchase_date || raw.fmv_per_unit);
  const fmvOfferingStart = parseNumber(raw.fmv_offering_start_date || raw.fmv_at_offering_start_date || raw.fmv_start);

  if (!purchaseDate) throw new Error(`row ${index + 1}: invalid purchase date`);
  if (!(purchaseQty > 0)) throw new Error(`row ${index + 1}: purchase quantity must be > 0`);
  if (!(purchasePrice > 0)) throw new Error(`row ${index + 1}: purchase price must be > 0`);

  const usdAmount = purchaseValue != null
    ? Number(purchaseValue.toFixed(2))
    : Number((purchaseQty * purchasePrice).toFixed(2));

  // ESPP portal price is usually discounted purchase price; use it to infer FMV when missing.
  const fmvPurchaseDate = parsedFmvPurchaseDate != null
    ? parsedFmvPurchaseDate
    : Number((purchasePrice / 0.9).toFixed(4));

  const normalizedOffering = offeringPeriod || 'Unknown Offering';
  const compactOffering = normalizedOffering.replace(/\s+/g, '');
  const key = `ESPP_ACQ|${purchaseDate}|${compactOffering}`;

  const noteParts = [
    'ESPP Purchase | ESPP',
    `Offering ${normalizedOffering}`,
    fmvOfferingStart != null ? `FMV Start $${fmvOfferingStart.toFixed(2)}` : null,
    fmvPurchaseDate != null ? `FMV Purchase $${fmvPurchaseDate.toFixed(2)}` : null,
    sourceLabel ? `Source ${sourceLabel}` : null,
    `Key ${key}`,
  ].filter(Boolean);

  return {
    offering_period: normalizedOffering,
    purchase_date: purchaseDate,
    purchase_quantity: Number(purchaseQty.toFixed(3)),
    purchase_price: Number(purchasePrice.toFixed(4)),
    purchase_value: usdAmount,
    fmv_purchase_date: fmvPurchaseDate != null ? Number(fmvPurchaseDate.toFixed(4)) : null,
    fmv_offering_start_date: fmvOfferingStart != null ? Number(fmvOfferingStart.toFixed(4)) : null,
    import_key: key,
    notes: noteParts.join(' | '),
  };
}

function normalizeRows(rows = [], sourceLabel = '') {
  return rows.map((row, idx) => normalizeRow(row, idx, sourceLabel));
}

function makeFallbackSignature(row) {
  const qty = Number(row.purchase_quantity || 0).toFixed(3);
  const price = Number(row.purchase_price || 0).toFixed(4);
  const usd = Number(row.purchase_value || 0).toFixed(2);
  return `${row.purchase_date}|${qty}|${price}|${usd}`;
}

function buildExistingMaps(existingRows = []) {
  const byKey = new Map();
  const bySignature = new Map();

  for (const txn of existingRows) {
    const notes = String(txn.notes || '');
    const keyMatch = notes.match(/Key\s+(ESPP_ACQ\|[^|]+\|[^|\s]+)/i);
    if (keyMatch) byKey.set(String(keyMatch[1]).toUpperCase(), txn.id);

    const sig = `${String(txn.transaction_date || '')}|${Number(txn.units || 0).toFixed(3)}|${Number(txn.price_per_unit || 0).toFixed(4)}|${Number(txn.usd_amount || 0).toFixed(2)}`;
    bySignature.set(sig, txn.id);
  }

  return { byKey, bySignature };
}

function annotatePreviewRows(normalizedRows = [], existingRows = []) {
  const { byKey, bySignature } = buildExistingMaps(existingRows);
  return normalizedRows.map((row) => {
    const key = String(row.import_key || '').toUpperCase();
    const signature = makeFallbackSignature(row);
    const existingId = byKey.get(key) || bySignature.get(signature) || null;
    return {
      ...row,
      already_imported: Boolean(existingId),
      existing_transaction_id: existingId,
    };
  });
}

module.exports = {
  normalizeRows,
  annotatePreviewRows,
};
