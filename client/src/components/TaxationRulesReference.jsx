import React, { useState } from 'react';
import { Card, Table, Badge } from 'react-bootstrap';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { formatINR } from '../utils/formatters';

/**
 * TaxationRulesReference
 * Displays the tax rules and parameters used for a specific financial year.
 * Collapsed by default to keep the UI clean, shown as info card at top level.
 *
 * @param {Object} rules - Taxation rules object from API (includes slabs, LTCG rates, etc.)
 * @param {string} fy - Financial year (e.g., '2025-26')
 */
export default function TaxationRulesReference({ rules, fy }) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!rules || !rules.standard_deduction) {
    return null;
  }

  const regime = 'New Regime (Section 115BAC)';
  const isCurrentOrLatest = ['2025-26', '2024-25'].includes(fy);

  return (
    <Card className="mt-4 border-info bg-light">
      <Card.Header 
        className="bg-info text-white cursor-pointer d-flex align-items-center gap-2" 
        onClick={() => setIsExpanded(!isExpanded)} 
        style={{ cursor: 'pointer', padding: '0.75rem 1.25rem' }}
      >
        <Info size={18} className="flex-shrink-0" />
        <div className="flex-grow-1 d-flex justify-content-between align-items-center">
          <span className="fw-semibold">Taxation Rules — FY {fy} ({regime})</span>
          <span>
            {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </span>
        </div>
      </Card.Header>

      {isExpanded && (
        <Card.Body>
          <div className="small">
            {/* 1. Standard Deduction */}
            <div className="mb-4">
              <h6 className="fw-semibold text-dark">1. Standard Deduction</h6>
              <p className="mb-2">
                Deduction from gross salary income:
                <span className="ms-2 fw-bold">{formatINR(rules.standard_deduction)}</span>
              </p>
            </div>

            {/* 2. Income Slabs */}
            <div className="mb-4">
              <h6 className="fw-semibold text-dark">2. Income Tax Slabs</h6>
              <Table size="sm" className="table-bordered mb-2">
                <thead className="table-light">
                  <tr>
                    <th>Income Range</th>
                    <th className="text-end">Tax Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.slabs && rules.slabs.map((slab, idx) => (
                    <tr key={idx}>
                      <td>{slab.label}</td>
                      <td className="text-end">
                        <span className="badge bg-secondary">
                          {(slab.rate * 100).toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <small className="text-muted">
                Tax is calculated progressively on each income slab.
              </small>
            </div>

            {/* 3. Capital Gains Rates */}
            <div className="mb-4">
              <h6 className="fw-semibold text-dark">3. Capital Gains Tax Rates</h6>
              <Table size="sm" className="table-borderless mb-2">
                <tbody>
                  {rules.capital_gains?.stcg && (
                    <tr>
                      <td className="fw-semibold">Short-Term Capital Gain (STCG)</td>
                      <td className="text-end">
                        <span className="badge bg-warning text-dark">
                          {(rules.capital_gains.stcg.rate * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="ps-3">
                        <small className="text-muted">{rules.capital_gains.stcg.section}</small>
                      </td>
                    </tr>
                  )}
                  {rules.capital_gains?.ltcg_equity && (
                    <tr>
                      <td className="fw-semibold">Long-Term Capital Gain (LTCG) — Equity</td>
                      <td className="text-end">
                        <span className="badge bg-success">
                          {(rules.capital_gains.ltcg_equity.rate * 100).toFixed(2)}%
                        </span>
                      </td>
                      <td className="ps-3">
                        <small className="text-muted">{rules.capital_gains.ltcg_equity.section}</small>
                      </td>
                    </tr>
                  )}
                  {rules.capital_gains?.ltcg_foreign && (
                    <tr>
                      <td className="fw-semibold">Long-Term Capital Gain (LTCG) — Foreign</td>
                      <td className="text-end">
                        <span className="badge bg-success">
                          {(rules.capital_gains.ltcg_foreign.rate * 100).toFixed(2)}%
                        </span>
                      </td>
                      <td className="ps-3">
                        <small className="text-muted">{rules.capital_gains.ltcg_foreign.section}</small>
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </div>

            {/* 4. LTCG Exemption */}
            {rules.capital_gains?.ltcg_equity?.exemption > 0 && (
              <div className="mb-4">
                <h6 className="fw-semibold text-dark">4. LTCG Exemption (Equity)</h6>
                <p className="mb-2">
                  First {formatINR(rules.capital_gains.ltcg_equity.exemption)} of Long-Term Capital Gain
                  <br />
                  on listed equity is exempt from tax.
                </p>
              </div>
            )}

            {/* 5. Rebate 87A */}
            {rules.rebate_87a && (
              <div className="mb-4">
                <h6 className="fw-semibold text-dark">5. Rebate under Section 87A</h6>
                <p className="mb-2">
                  For income up to {formatINR(rules.rebate_87a.limit)}:
                  <br />
                  Rebate of {formatINR(rules.rebate_87a.amount)} (or tax whichever is lower).
                </p>
              </div>
            )}

            {/* 6. Surcharge */}
            {rules.surcharge && rules.surcharge.length > 0 && (
              <div className="mb-4">
                <h6 className="fw-semibold text-dark">6. Surcharge</h6>
                <Table size="sm" className="table-bordered">
                  <thead className="table-light">
                    <tr>
                      <th>Income Range</th>
                      <th className="text-end">Surcharge Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.surcharge.map((surch, idx) => (
                      <tr key={idx}>
                        <td>{surch.label}</td>
                        <td className="text-end">
                          <span className="badge bg-info">
                            {(surch.rate * 100).toFixed(0)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}

            {/* 7. Cess */}
            {rules.cess && (
              <div className="mb-4">
                <h6 className="fw-semibold text-dark">7. Health & Education Cess</h6>
                <p className="mb-2">
                  {(rules.cess.rate * 100).toFixed(0)}% of (Tax + Surcharge)
                  <br />
                  <small className="text-muted">{rules.cess.description}</small>
                </p>
              </div>
            )}

            {/* Footer note */}
            <hr className="my-3" />
            <small className="text-muted">
              <strong>Note:</strong> These rules apply to the New Tax Regime under Section 115BAC.
              {!isCurrentOrLatest && (
                <span className="d-block mt-2 text-warning">
                  ⚠ This is a historical financial year. Tax rules may have changed.
                </span>
              )}
            </small>
          </div>
        </Card.Body>
      )}
    </Card>
  );
}
