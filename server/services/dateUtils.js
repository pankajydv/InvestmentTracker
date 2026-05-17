function toIsoDate(value) {
  if (!value) return null;
  const raw = String(value).split(/[ T]/)[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

// Returns true if current IST time is after 10:25 PM (22:25)
function isAfterStaticAssetCutoff() {
  const now = new Date();
  // IST = UTC+5:30
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = (utcMinutes + 330) % 1440;
  // 22:25 = 1345 minutes
  return istMinutes >= 1345;
}

module.exports = {
  toIsoDate,
  todayIso,
  isAfterStaticAssetCutoff,
};