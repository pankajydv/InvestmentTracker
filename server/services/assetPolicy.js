const ONE_DAY_CHANGE_POLICY = Object.freeze({
  MARKET_SESSION: 'MARKET_SESSION',
  NAV_SNAPSHOT: 'NAV_SNAPSHOT',
  ACCRUAL_SNAPSHOT: 'ACCRUAL_SNAPSHOT',
  SNAPSHOT: 'SNAPSHOT',
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

module.exports = {
  ONE_DAY_CHANGE_POLICY,
  getOneDayChangePolicy,
};
