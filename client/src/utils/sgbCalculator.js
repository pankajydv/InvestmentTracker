/**
 * SGB (Sovereign Gold Bond) utilities for parsing and calculating details
 */

/**
 * Parse SGB name to extract interest rate and maturity date
 * Format: "SGB 2.50 05/01/2029 Series-IX"
 * @param {string} name - SGB investment name
 * @returns {object} { coupon_rate, maturity_date, series } or null if not parseable
 */
export function parseSGBName(name) {
  if (!name || !name.includes('SGB')) return null;

  // Pattern: SGB [rate] [maturity_date] Series-[XX]
  // Example: "SGB 2.50 05/01/2029 Series-IX"
  const pattern = /SGB\s+([\d.]+)\s+(\d{2}\/\d{2}\/\d{4})\s+Series-([A-Z0-9]+)/i;
  const match = name.match(pattern);

  if (!match) return null;

  return {
    coupon_rate: parseFloat(match[1]),
    maturity_date: match[2], // DD/MM/YYYY format
    series: match[3],
  };
}

/**
 * Convert DD/MM/YYYY to YYYY-MM-DD format
 * @param {string} dateStr - Date in DD/MM/YYYY format
 * @returns {string} Date in YYYY-MM-DD format
 */
export function convertDateFormat(dateStr) {
  if (!dateStr) return null;
  const [day, month, year] = dateStr.split('/');
  return `${year}-${month}-${day}`;
}

/**
 * Calculate coupon payment dates for an SGB
 * SGBs typically pay interest semi-annually (every 6 months from issue date)
 * @param {string} issueDate - Issue date in YYYY-MM-DD format
 * @param {string} maturityDate - Maturity date in YYYY-MM-DD format
 * @returns {array} Array of coupon payment dates in YYYY-MM-DD format
 */
export function calculateCouponDates(issueDate, maturityDate) {
  if (!issueDate || !maturityDate) return [];

  const issue = new Date(issueDate);
  const maturity = new Date(maturityDate);
  const coupons = [];

  // Start with 6 months after issue
  let couponDate = new Date(issue);
  couponDate.setMonth(couponDate.getMonth() + 6);

  while (couponDate <= maturity) {
    coupons.push(couponDate.toISOString().split('T')[0]);
    couponDate.setMonth(couponDate.getMonth() + 6);
  }

  return coupons;
}

/**
 * Get all coupon dates that have already been paid (before today)
 * @param {array} couponDates - Array of coupon dates in YYYY-MM-DD format
 * @returns {array} Array of paid coupon dates
 */
export function getPaidCouponDates(couponDates) {
  if (!Array.isArray(couponDates)) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return couponDates.filter(date => new Date(date) < today);
}

/**
 * Calculate total interest paid so far
 * @param {number} units - Number of SGB units
 * @param {number} couponRate - Annual coupon rate (e.g., 2.50)
 * @param {number} faceValue - Face value per unit (typically 1 for SGBs in grams)
 * @param {array} paidCouponDates - Array of paid coupon dates
 * @returns {number} Total interest paid
 */
export function calculateInterestPaid(units, couponRate, faceValue = 1, paidCouponDates = []) {
  if (!units || !couponRate || !Array.isArray(paidCouponDates)) return 0;
  // Each coupon is 6 months, so it's couponRate/2 per period
  const semiAnnualRate = couponRate / 2;
  const interestPerCoupon = (units * faceValue * semiAnnualRate) / 100;
  return interestPerCoupon * paidCouponDates.length;
}

/**
 * Calculate accrued interest (interest earned but not yet received)
 * @param {number} units - Number of SGB units
 * @param {number} couponRate - Annual coupon rate (e.g., 2.50)
 * @param {number} faceValue - Face value per unit (typically 1 for SGBs in grams)
 * @param {string} lastCouponDate - Last coupon date in YYYY-MM-DD format
 * @param {string} nextCouponDate - Next coupon date in YYYY-MM-DD format
 * @returns {number} Accrued interest as of today
 */
export function calculateAccruedInterest(units, couponRate, faceValue = 1, lastCouponDate, nextCouponDate) {
  if (!units || !couponRate || !lastCouponDate || !nextCouponDate) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const last = new Date(lastCouponDate);
  const next = new Date(nextCouponDate);

  // If we haven't reached the last coupon date yet, return 0
  if (today < last) return 0;

  // If we've passed the next coupon date, return full coupon
  if (today >= next) {
    const semiAnnualRate = couponRate / 2;
    return (units * faceValue * semiAnnualRate) / 100;
  }

  // Calculate proportional accrual
  const totalDays = Math.floor((next - last) / (1000 * 60 * 60 * 24));
  const daysPassed = Math.floor((today - last) / (1000 * 60 * 60 * 24));
  const proportion = daysPassed / totalDays;

  const semiAnnualRate = couponRate / 2;
  const fullCoupon = (units * faceValue * semiAnnualRate) / 100;
  return fullCoupon * proportion;
}

/**
 * Calculate next coupon date after a given coupon date
 * @param {string} couponDate - Coupon date in YYYY-MM-DD format
 * @returns {string} Next coupon date in YYYY-MM-DD format
 */
export function getNextCouponDate(couponDate) {
  if (!couponDate) return null;
  const date = new Date(couponDate);
  date.setMonth(date.getMonth() + 6);
  return date.toISOString().split('T')[0];
}

/**
 * Get the most recent coupon date before today
 * @param {array} paidCouponDates - Array of paid coupon dates in YYYY-MM-DD format
 * @returns {string} Most recent coupon date or null
 */
export function getLastCouponDate(paidCouponDates) {
  if (!Array.isArray(paidCouponDates) || paidCouponDates.length === 0) return null;
  return paidCouponDates[paidCouponDates.length - 1];
}
