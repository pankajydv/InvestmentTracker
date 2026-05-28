const STORAGE_DECIMALS = 6;
const STORAGE_EPSILON = 0.0000005;

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundToDecimals(value, decimals = STORAGE_DECIMALS) {
  const n = toFiniteNumber(value);
  const factor = 10 ** Number(decimals);
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

function quantizeForStorage(value) {
  const n = roundToDecimals(value, STORAGE_DECIMALS);
  return Math.abs(n) < STORAGE_EPSILON ? 0 : n;
}

function quantizeNullableForStorage(value) {
  if (value == null || value === '') return null;
  return quantizeForStorage(value);
}

module.exports = {
  STORAGE_DECIMALS,
  STORAGE_EPSILON,
  roundToDecimals,
  quantizeForStorage,
  quantizeNullableForStorage,
};
