# Metrics Basis Contract

This project uses two accounting lenses for portfolio reporting.

## Basis Mapping

- Top summary cards: Cost Basis
- Individual investment rows: Attribution Basis
- Asset footer totals: Cost Basis

## Why Row Sums And Footer Totals May Differ

Individual rows include per-investment attribution effects from switches/transfers.
Footer totals use cost-basis cashflow treatment, which excludes internal reallocation flows.

## Cost Basis Lens

Used for summary cards and asset footer totals.

- Invested inflows: BUY, DEPOSIT, IPO, RIGHTS, EMPLOYER_CONTRIBUTION, VOLUNTARY_CONTRIBUTION, ESPP_CONTRIBUTION
- Realized inflows: SELL, REDEMPTION, WITHDRAWAL, DIVIDEND, INTEREST

Formula:

- Total P&L = Current Value + Cash Out (Realized Proceeds) - Cost Basis

## Attribution Lens

Used for individual investment rows.

Rows reflect investment-level attribution from daily_values, including switch/transfer attribution
effects where applicable.

## Notes

- This basis split is intentional and expected.
- FAQ in-app should be considered the user-facing explanation.