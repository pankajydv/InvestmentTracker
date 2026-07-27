import React, { useCallback, useEffect, useState } from 'react';
import { Accordion, Card, Spinner, Table } from 'react-bootstrap';
import { getTaxComputation } from '../services/api';
import { formatINRExact as formatINR } from '../utils/formatters';

export default function TaxComputation({ fy, portfolioId, refreshNonce = 0, onRecomputed }) {
  const [computation, setComputation] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadComputation = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getTaxComputation(fy, portfolioId || undefined);
      setComputation(data);
    } catch (err) {
      setComputation(null);
    } finally {
      setLoading(false);
    }
  }, [fy, portfolioId]);

  useEffect(() => {
    loadComputation();
  }, [loadComputation, refreshNonce]);

  return (
    <Accordion.Item eventKey="6">
      <Accordion.Header>Tax Computation — New Regime {computation ? `(${computation.net_payable >= 0 ? 'Payable' : 'Refund'}: ${formatINR(Math.abs(computation.net_payable))})` : ''}</Accordion.Header>
      <Accordion.Body>
        {loading && !computation && (
          <div className="small text-muted mb-2">
            <Spinner animation="border" size="sm" className="me-2" />Computing tax...
          </div>
        )}
        {computation && <TaxComputationView data={computation} fy={fy} />}
      </Accordion.Body>
    </Accordion.Item>
  );
}

function TaxComputationView({ data, fy }) {
  const { heads, tax, credits } = data;
  const h = heads;
  const d = data.deductions || {};
  const p = data.property_capital_gains || {};
  const npsSource = String(d.nps_employer_80ccd2_source || '').toUpperCase();
  const npsSourceLabel = npsSource === 'FORM16' ? 'Form-16' : 'computed';

  const formatImpact = (amount) => {
    const n = Number(amount) || 0;
    const sign = n < 0 ? '-' : '+';
    return `${sign}${formatINR(Math.abs(n))}`;
  };

  const impactClass = (amount) => {
    const n = Number(amount) || 0;
    if (n > 0) return 'text-danger';
    if (n < 0) return 'text-success';
    return '';
  };

  return (
    <div className="small">
      <Table size="sm" className="table-borderless mb-2">
        <thead className="table-light">
          <tr><th colSpan={2}>Income Summary</th><th className="text-end">Amount (₹)</th></tr>
        </thead>
        <tbody>
          {/* Income at Slab Rates */}
          <tr className="table-light"><td colSpan={2} className="fw-semibold">Income at Slab Rates</td><td></td></tr>
          <tr><td></td><td>Gross Salary</td><td className="text-end">{formatINR(h.salary.gross)}</td></tr>
          <tr><td></td><td>Less: Standard Deduction</td><td className="text-end text-success">{formatImpact(-h.salary.standard_deduction)}</td></tr>
          <tr className="fw-semibold"><td></td><td>Net Salary</td><td className="text-end">{formatINR(h.salary.net)}</td></tr>
          <tr><td></td><td>Other Sources (Dividends + Interest){h.other_sources.transfer_expense > 0 ? ` − Remittance ₹${h.other_sources.transfer_expense}` : ''}</td><td className="text-end">{formatINR(h.other_sources.total)}</td></tr>
          {h.capital_gains.stcg_slab !== 0 && <tr><td></td><td>STCG — Foreign (slab rate)</td><td className="text-end">{formatINR(h.capital_gains.stcg_slab)}</td></tr>}
          {d.nps_employer_80ccd2 > 0 && (
            <tr>
              <td></td>
              <td>
                Less: 80CCD(2) Employer NPS
                {npsSource === 'FORM16'
                  ? <span className="text-muted ms-1 tax-summary-sub">(source: Form-16 · computed: {formatINR(d.nps_employer_80ccd2_computed)})</span>
                  : <span className="text-muted ms-1 tax-summary-sub">(source: {npsSourceLabel})</span>}
              </td>
              <td className="text-end">
                <span className="text-success">{formatImpact(-d.nps_employer_80ccd2)}</span>
              </td>
            </tr>
          )}
          <tr className="fw-semibold table-light"><td></td><td>Taxable at Slab Rates</td><td className="text-end">{formatINR(data.taxable_slab_income)}</td></tr>

          {/* Capital Gains at Special Rates */}
          <tr className="table-light"><td colSpan={2} className="fw-semibold">Capital Gains at Special Rates</td><td></td></tr>
          <tr><td></td><td>STCG 111A — Equity, STT paid (@ 20%)</td><td className="text-end">{formatINR(h.capital_gains.stcg_111a)}</td></tr>
          <tr><td></td><td>LTCG 112A — Equity (@ 12.5%) · Gross {formatINR(h.capital_gains.ltcg_112a_gross)}, Exempt {formatINR(h.capital_gains.ltcg_112a_exemption)}</td><td className="text-end">{formatINR(h.capital_gains.ltcg_112a_taxable)}</td></tr>
          {p.rows_count > 0 && (
            <tr>
              <td></td>
              <td>Old Property Gain/Loss (manual helper rows)</td>
              <td className={`text-end ${impactClass(p.old_gain_loss || 0)}`}>{formatImpact(p.old_gain_loss || 0)}</td>
            </tr>
          )}
          {h.capital_gains.property_section_54_exemption > 0 && (
            <tr>
              <td></td>
              <td>Less: Section 54 Exemption (from New Property investment)</td>
              <td className="text-end text-success">{formatImpact(-h.capital_gains.property_section_54_exemption)}</td>
            </tr>
          )}
          <tr>
            <td></td>
            <td>
              LTCG 112 — Foreign (@ 12.5%)
              {h.capital_gains.ltcg_112_transfer_expense > 0 ? ` · Gross ${formatINR(h.capital_gains.ltcg_112)} − Transfer ₹${h.capital_gains.ltcg_112_transfer_expense}` : ''}
              {h.capital_gains.property_ltcg_added > 0 ? ` + Property LTCG (after Sec54) ${formatINR(h.capital_gains.property_ltcg_added)}` : ''}
              {h.capital_gains.property_ltcl_setoff_used > 0 ? ` − LTCL Setoff ${formatINR(h.capital_gains.property_ltcl_setoff_used)}` : ''}
            </td>
            <td className="text-end">{formatINR(h.capital_gains.ltcg_112_adjusted ?? h.capital_gains.ltcg_112)}</td>
          </tr>
          {h.capital_gains.property_ltcl_carry_forward > 0 && (
            <tr>
              <td></td>
              <td>LTCL Carry Forward (est.)</td>
              <td className="text-end text-success">{formatImpact(-h.capital_gains.property_ltcl_carry_forward)}</td>
            </tr>
          )}
          <tr className="fw-semibold table-light"><td></td><td>Subtotal (special rate)</td><td className="text-end">{formatINR(data.special_rate_cg)}</td></tr>

          {/* Total Taxable Income */}
          <tr className="table-warning fw-bold"><td colSpan={2}>Total Taxable Income</td><td className="text-end">{formatINR(data.total_taxable_income)}</td></tr>
        </tbody>
      </Table>

      <Table size="sm" className="table-borderless mt-3 mb-2">
        <thead className="table-light">
          <tr><th colSpan={2}>Tax Computation — New Regime (Section 115BAC)</th><th className="text-end">₹</th></tr>
        </thead>
        <tbody>
          <tr><td></td><td>Tax on slab income ({formatINR(data.taxable_slab_income)})</td><td className="text-end text-danger">{formatImpact(tax.on_slab_income)}</td></tr>
          <tr><td></td><td>Tax on STCG 111A @ 20%</td><td className="text-end text-danger">{formatImpact(tax.on_stcg_111a)}</td></tr>
          <tr><td></td><td>Tax on LTCG 112A @ 12.5%</td><td className="text-end text-danger">{formatImpact(tax.on_ltcg_112a)}</td></tr>
          <tr><td></td><td>Tax on LTCG 112 (Foreign) @ 12.5%</td><td className="text-end text-danger">{formatImpact(tax.on_ltcg_112)}</td></tr>
          <tr className="fw-semibold"><td></td><td>Total tax before rebate</td><td className="text-end">{formatINR(tax.total_before_surcharge)}</td></tr>
          {tax.rebate_87a > 0 && <tr><td></td><td>Less: Section 87A Rebate</td><td className="text-end text-success">{formatImpact(-tax.rebate_87a)}</td></tr>}
          <tr><td></td><td>Surcharge</td><td className="text-end text-danger">{formatImpact(tax.surcharge)}</td></tr>
          <tr><td></td><td>Health & Education Cess (4%)</td><td className="text-end text-danger">{formatImpact(tax.cess)}</td></tr>
          <tr className="table-warning fw-bold"><td colSpan={2}>Total Tax Liability</td><td className="text-end">{formatINR(tax.total_liability)}</td></tr>
        </tbody>
      </Table>

      <Table size="sm" className="table-borderless mt-3 mb-2">
        <thead className="table-light">
          <tr><th colSpan={2}>Tax Credits</th><th className="text-end">₹</th></tr>
        </thead>
        <tbody>
          <tr><td></td><td>TDS on Salary</td><td className="text-end text-success">{formatImpact(-credits.salary_tds)}</td></tr>
          {credits.other_tds > 0 && <tr><td></td><td>TDS on Other Income</td><td className="text-end text-success">{formatImpact(-credits.other_tds)}</td></tr>}
          {credits.pf_tds > 0 && <tr><td></td><td>TDS on PF Interest</td><td className="text-end text-success">{formatImpact(-credits.pf_tds)}</td></tr>}
          {credits.lrs_tcs > 0 && <tr><td></td><td>TCS on LRS Remittance</td><td className="text-end text-success">{formatImpact(-credits.lrs_tcs)}</td></tr>}
          {credits.ftc > 0 && <tr><td></td><td>Foreign Tax Credit (Form 67)</td><td className="text-end text-success">{formatImpact(-credits.ftc)}</td></tr>}
          <tr className="fw-semibold"><td></td><td>Total Credits</td><td className="text-end text-success">{formatImpact(-credits.total)}</td></tr>
        </tbody>
      </Table>

      <Card className={`mt-3 ${data.net_payable >= 0 ? 'border-danger' : 'border-success'}`}>
        <Card.Body className="py-2 d-flex justify-content-between align-items-center">
          <span className="fw-bold">{data.net_payable >= 0 ? 'Net Tax Payable' : 'Refund Due'}</span>
          <span className={`fs-5 fw-bold ${data.net_payable >= 0 ? 'text-danger' : 'text-success'}`}>
            {formatINR(Math.abs(data.net_payable))}
          </span>
        </Card.Body>
      </Card>
    </div>
  );
}
