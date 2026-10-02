const { PDFParse } = require('pdf-parse');

const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

function parseMoney(value) {
  const parsed = Number(String(value || '').replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}

function parseFidelityDate(value) {
  const match = String(value || '').trim().match(/^([A-Z]{3})\/(\d{1,2})\/(\d{4})$/i);
  if (!match) return null;
  const month = MONTHS[match[1].toUpperCase()];
  return month ? `${match[3]}-${month}-${match[2].padStart(2, '0')}` : null;
}

function parseFidelityEsppPurchaseConfirmationText(text, fileName = '') {
  const normalized = String(text || '').replace(/\r/g, '');
  if (!/FIDELITY STOCK PLAN SERVICES/i.test(normalized) || !/\bESPP PLAN\b/i.test(normalized)) return null;

  const purchaseMatch = normalized.match(/YOU\s+PURCHASED\s+([\d,.]+)\s+AT\s+\$?([\d,.]+)\s+PURCHASE\s+PRICE/i);
  const purchaseDateMatch = normalized.match(/ESPP PLAN\s+on\s+([A-Z]{3}\/\d{1,2}\/\d{4})/i);
  const offeringMatch = normalized.match(/Offering period:\s*([A-Z]{3}\/\d{1,2}\/\d{4})\s*-\s*([A-Z]{3}\/\d{1,2}\/\d{4})/i);
  const securityMatch = normalized.match(/SECURITY DESCRIPTION SYMBOL:\s*([^\s]+)\s*\n([^\n$]+)/i);
  const amountsMatch = securityMatch
    ? normalized.slice(securityMatch.index).match(/SECURITY DESCRIPTION SYMBOL:[^\n]*\n[^\n]*?\n\s*\$([\d,.]+)\s*\n\s*\$([\d,.]+)\s*\n\s*\$([\d,.]+)\s*\n\s*\$([\d,.]+)/i)
    : null;
  const identifiersMatch = normalized.match(/\n([A-Z]\d{8})\s+(\d+)\s+(\d{2}-\d{2}-\d{2})\s+(\d{2}-\d{2}-\d{2})\s+([A-Z0-9]+)\s+(\d{9})\s*\n/);

  if (!purchaseMatch || !purchaseDateMatch || !offeringMatch || !securityMatch || !amountsMatch) return null;

  const quantity = Number(purchaseMatch[1].replace(/,/g, ''));
  const purchasePrice = Number(purchaseMatch[2].replace(/,/g, ''));
  const marketValueUsd = parseMoney(amountsMatch[1]);
  const accumulatedContributionsUsd = parseMoney(amountsMatch[2]);
  const gainUsd = parseMoney(amountsMatch[3]);
  const shareProceedsUsd = parseMoney(amountsMatch[4]);
  if (
    !(quantity > 0)
    || !(purchasePrice > 0)
    || marketValueUsd === null
    || accumulatedContributionsUsd === null
    || gainUsd === null
    || shareProceedsUsd === null
  ) {
    return null;
  }

  const purchaseDate = parseFidelityDate(purchaseDateMatch[1]);
  const offeringStartDate = parseFidelityDate(offeringMatch[1]);
  const offeringEndDate = parseFidelityDate(offeringMatch[2]);
  if (!purchaseDate || !offeringStartDate || !offeringEndDate) return null;

  const referenceMatch = normalized.match(/REF\s*#\s*([^\s]+)/i);

  return {
    broker: 'Fidelity',
    fileName,
    participantId: identifiersMatch ? identifiersMatch[1] : null,
    accountType: identifiersMatch ? identifiersMatch[2] : null,
    transactionNumber: identifiersMatch ? identifiersMatch[5] : null,
    referenceNumber: referenceMatch ? referenceMatch[1] : null,
    cusip: identifiersMatch ? identifiersMatch[6] : null,
    purchase: {
      purchaseDate,
      settlementDate: identifiersMatch ? parseNumericFidelityDate(identifiersMatch[4]) : null,
      offeringStartDate,
      offeringEndDate,
      offeringPeriod: `${offeringMatch[1].toUpperCase()} - ${offeringMatch[2].toUpperCase()}`,
      security: securityMatch[2].trim(),
      ticker: securityMatch[1].trim().toUpperCase(),
      cusip: identifiersMatch ? identifiersMatch[6] : null,
      quantity,
      purchasePrice,
      purchaseValueUsd: accumulatedContributionsUsd,
      marketValueUsd,
      fmvPerUnit: marketValueUsd / quantity,
      gainUsd,
      shareProceedsUsd,
      transactionNumber: identifiersMatch ? identifiersMatch[5] : null,
      referenceNumber: referenceMatch ? referenceMatch[1] : null,
    },
  };
}

function parseNumericFidelityDate(value) {
  const match = String(value || '').trim().match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = 2000 + Number(match[3]);
  const date = new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2])));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== Number(match[1]) - 1
    || date.getUTCDate() !== Number(match[2])
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function parseFidelityTradeConfirmationText(text, fileName = '') {
  const normalized = String(text || '').replace(/\r/g, '');
  if (!/FIDELITY STOCK PLAN SERVICES/i.test(normalized)) return null;

  const tradeMatch = normalized.match(/YOU\s+(SOLD|BOUGHT)\s+([\d,.]+)\s+AT\s+\$?([\d,.]+)/i);
  const securityMatch = normalized.match(/SECURITY DESCRIPTION SYMBOL:\s*([^\s]+)\s*\n([^\n$]+?)\s+\$([\d,.]+)/i);
  const amountsMatch = securityMatch
    ? normalized.slice(securityMatch.index).match(/SECURITY DESCRIPTION SYMBOL:[^\n]*\n[^\n]*?\$([\d,.]+)\s*\n\$([\d,.]+)\s*\n-?\$([\d,.]+)/i)
    : null;
  const saleDateMatch = normalized.match(/Sale Date:\s*([A-Z]{3}\/\d{1,2}\/\d{4})/i);
  const availableDateMatch = normalized.match(/Proceeds Available:\s*([A-Z]{3}\/\d{1,2}\/\d{4})/i);
  const identifiersMatch = normalized.match(/\n([A-Z]\d{8})\s+(\d+)\s+(\d{2}-\d{2}-\d{2})\s+(\d{2}-\d{2}-\d{2})\s+([A-Z0-9]+)\s+(\d{9})\s*\n/);

  if (!tradeMatch || !securityMatch || !amountsMatch || !saleDateMatch) return null;

  const quantity = Number(tradeMatch[2].replace(/,/g, ''));
  const pricePerUnit = Number(tradeMatch[3].replace(/,/g, ''));
  const grossProceedsUsd = parseMoney(amountsMatch[1]);
  const feesUsd = parseMoney(amountsMatch[2]);
  const netProceedsUsd = parseMoney(amountsMatch[3]);
  if (!(quantity > 0) || !(pricePerUnit > 0) || grossProceedsUsd === null || feesUsd === null || netProceedsUsd === null) {
    return null;
  }

  const transactionType = tradeMatch[1].toUpperCase() === 'SOLD' ? 'SELL' : 'BUY';
  const tradeDate = parseFidelityDate(saleDateMatch[1]);
  const referenceMatch = normalized.match(/REF\s*#\s*([^\s]+)/i);
  const customerMatch = normalized.match(/\n(\d{8})\s*\nWI#/i);

  return {
    broker: 'Fidelity',
    fileName,
    customerNumber: customerMatch ? customerMatch[1] : null,
    participantId: identifiersMatch ? identifiersMatch[1] : null,
    accountType: identifiersMatch ? identifiersMatch[2] : null,
    tradeDate,
    settlementDate: parseFidelityDate(availableDateMatch?.[1]),
    transactionNumber: identifiersMatch ? identifiersMatch[5] : null,
    referenceNumber: referenceMatch ? referenceMatch[1] : null,
    cusip: identifiersMatch ? identifiersMatch[6] : null,
    planType: normalized.match(/Plan Type:\s*([^\n]+)/i)?.[1].trim() || null,
    trades: [{
      tradeDate,
      settlementDate: parseFidelityDate(availableDateMatch?.[1]),
      security: securityMatch[2].trim(),
      ticker: securityMatch[1].trim().toUpperCase(),
      cusip: identifiersMatch ? identifiersMatch[6] : null,
      type: transactionType,
      quantity,
      rate: pricePerUnit,
      total: grossProceedsUsd,
      grossProceedsUsd,
      feesUsd,
      netProceedsUsd,
      transactionNumber: identifiersMatch ? identifiersMatch[5] : null,
      referenceNumber: referenceMatch ? referenceMatch[1] : null,
    }],
    charges: {
      currency: 'USD',
      total: feesUsd,
      totalFees: feesUsd,
    },
  };
}

async function parseFidelityTradeConfirmation(buffer, fileName) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return parseFidelityTradeConfirmationText(result.text, fileName);
  } finally {
    await parser.destroy();
  }
}

async function parseFidelityEsppPurchaseConfirmation(buffer, fileName) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return parseFidelityEsppPurchaseConfirmationText(result.text, fileName);
  } finally {
    await parser.destroy();
  }
}

module.exports = {
  parseFidelityTradeConfirmation,
  parseFidelityTradeConfirmationText,
  parseFidelityEsppPurchaseConfirmation,
  parseFidelityEsppPurchaseConfirmationText,
};