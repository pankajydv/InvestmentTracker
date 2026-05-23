const ONE_DAY_CHANGE_POLICY = Object.freeze({
  MARKET_SESSION: 'MARKET_SESSION',
  NAV_SNAPSHOT: 'NAV_SNAPSHOT',
  ACCRUAL_SNAPSHOT: 'ACCRUAL_SNAPSHOT',
  SNAPSHOT: 'SNAPSHOT',
});

const UNEXPECTED_LOCF_POLICY = Object.freeze({
  STRICT: { thresholdSessions: 0, recentWindowDays: 180 },
  INDIAN_STOCK: { thresholdSessions: 1, recentWindowDays: 180 },
  FOREIGN_STOCK: { thresholdSessions: 2, recentWindowDays: 180 },
  SGB: { thresholdSessions: 5, recentWindowDays: 365 },
  MUTUAL_FUND: { thresholdSessions: 2, recentWindowDays: 180 },
  NPS: { thresholdSessions: 1, recentWindowDays: 180 },
  SNAPSHOT: { thresholdSessions: 0, recentWindowDays: 180 },
});

function getOneDayChangePolicy(assetType) {
  switch (assetType) {
    case 'INDIAN_STOCK':
    case 'FOREIGN_STOCK':
    case 'SGB':
    case 'NPS':
      return ONE_DAY_CHANGE_POLICY.MARKET_SESSION;
    case 'MUTUAL_FUND':
      return ONE_DAY_CHANGE_POLICY.NAV_SNAPSHOT;
    case 'PF':
    case 'PPF':
    case 'SSY':
      return ONE_DAY_CHANGE_POLICY.ACCRUAL_SNAPSHOT;
    default:
      return ONE_DAY_CHANGE_POLICY.SNAPSHOT;
  }
}

function getUnexpectedLocfPolicy(assetType) {
  switch (assetType) {
    case 'INDIAN_STOCK':
      return UNEXPECTED_LOCF_POLICY.INDIAN_STOCK;
    case 'FOREIGN_STOCK':
      return UNEXPECTED_LOCF_POLICY.FOREIGN_STOCK;
    case 'SGB':
      return UNEXPECTED_LOCF_POLICY.SGB;
    case 'MUTUAL_FUND':
      return UNEXPECTED_LOCF_POLICY.MUTUAL_FUND;
    case 'NPS':
      return UNEXPECTED_LOCF_POLICY.NPS;
    case 'PF':
    case 'PPF':
    case 'SSY':
      return UNEXPECTED_LOCF_POLICY.SNAPSHOT;
    default:
      return UNEXPECTED_LOCF_POLICY.STRICT;
  }
}

module.exports = {
  ONE_DAY_CHANGE_POLICY,
  getOneDayChangePolicy,
  getUnexpectedLocfPolicy,
};
