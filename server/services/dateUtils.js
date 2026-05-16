function toIsoDate(value) {
  if (!value) return null;
  const raw = String(value).split(/[ T]/)[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

module.exports = {
  toIsoDate,
  todayIso,
};