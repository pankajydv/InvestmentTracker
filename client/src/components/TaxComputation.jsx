import React, { useCallback, useState } from 'react';
import { Accordion, Button, Card, Form, Spinner, Table } from 'react-bootstrap';
import { getTaxComputation, addOtherIncome, updateOtherIncome, getOtherIncome } from '../services/api';
import { formatINRExact as formatINR } from '../utils/formatters';

export default function TaxComputation({ fy, portfolioId }) {
  const [computation, setComputation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [npsEditing, setNpsEditing] = useState(false);
  const [npsValue, setNpsValue] = useState('');
  const [npsRowId, setNpsRowId] = useState(null);

  const loadComputation = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getTaxComputation(fy, portfolioId || undefined);
      setComputation(data);
      // Check if there's an existing NPS override row
      const oi = await getOtherIncome(fy, portfolioId || undefined);
      const npsRow = oi.find((r) => r.category === 'NPS_80CCD2');
      if (npsRow) setNpsRowId(npsRow.id);
    } catch (err) {
      setComputation(null);
    } finally {
      setLoading(false);
    }
  }, [fy, portfolioId]);

  const handleNpsSave = useCallback(async () => {
    const val = Number(npsValue);
    if (!val && val !== 0) return;
    try {
      if (npsRowId) {
        await updateOtherIncome(npsRowId, { source_name: 'Employer NPS (Form 16)', amount: val, tds: 0 });
      } else {
        const row = await addOtherIncome({ fy, portfolio_id: portfolioId || null, category: 'NPS_80CCD2', source_name: 'Employer NPS (Form 16)', amount: val, tds: 0 });
        setNpsRowId(row.id);
      }
      setNpsEditing(false);
      // Reload computation with the override
      const data = await getTaxComputation(fy, portfolioId || undefined);
      setComputation(data);
    } catch (err) {
      // ignore
    }
  }, [fy, portfolioId, npsValue, npsRowId]);

  return (
    <Accordion.Item eventKey="5">
      <Accordion.Header>Tax Computation — New Regime {computation ? `(${computation.net_payable >= 0 ? 'Payable' : 'Refund'}: ${formatINR(Math.abs(computation.net_payable))})` : ''}</Accordion.Header>
      <Accordion.Body>
        <div className="d-flex justify-content-end mb-3">
          <Button size="sm" onClick={loadComputation} disabled={loading}>
            {loading ? <Spinner animation="border" size="sm" /> : 'Compute Tax'}
          </Button>
        </div>
        {computation && <TaxComputationView data={computation} npsEditing={npsEditing} npsValue={npsValue}
          onNpsEdit={() => { setNpsValue(String(computation.deductions?.nps_employer_80ccd2 || '')); setNpsEditing(true); }}
          onNpsChange={setNpsValue} onNpsSave={handleNpsSave} onNpsCancel={() => setNpsEditing(false)} />}
      </Accordion.Body>
    </Accordion.Item>
  );
}

function TaxComputationView({ data, npsEditing, npsValue, onNpsEdit, onNpsChange, onNpsSave, onNpsCancel }) {
  const { heads, tax, credits } = data;
  const h = heads;
  const d = data.deductions || {};
  const isOverridden = d.nps_employer_80ccd2 !== d.nps_employer_80ccd2_computed;

  return (
    <div className="small">
      <Table size="sm" bordered>
        <thead className="table-light">
          <tr><th colSpan={2}>Income Summary</th><th className="text-end">Amount (₹)</th></tr>
        </thead>
        <tbody>
          {/* Income at Slab Rates */}
          <tr className="table-light"><td colSpan={2} className="fw-semibold">Income at Slab Rates</td><td></td></tr>
          <tr><td></td><td>Gross Salary</td><td className="text-end">{formatINR(h.salary.gross)}</td></tr>
          <tr><td></td><td>Less: Standard Deduction</td><td className="text-end">({formatINR(h.salary.standard_deduction)})</td></tr>
          <tr className="fw-semibold"><td></td><td>Net Salary</td><td className="text-end">{formatINR(h.salary.net)}</td></tr>
          <tr><td></td><td>Other Sources (Dividends + Interest)</td><td className="text-end">{formatINR(h.other_sources.total)}</td></tr>
          {h.capital_gains.stcg_slab !== 0 && <tr><td></td><td>STCG — Foreign (slab rate)</td><td className="text-end">{formatINR(h.capital_gains.stcg_slab)}</td></tr>}
          <tr className="fw-semibold table-light"><td></td><td>Subtotal (taxed at progressive slab)</td><td className="text-end">{formatINR(data.slab_income)}</td></tr>

          {/* Capital Gains at Special Rates */}
          <tr className="table-light"><td colSpan={2} className="fw-semibold">Capital Gains at Special Rates</td><td></td></tr>
          <tr><td></td><td>STCG 111A — Equity, STT paid (@ 20%)</td><td className="text-end">{formatINR(h.capital_gains.stcg_111a)}</td></tr>
          <tr><td></td><td>LTCG 112A — Equity (@ 12.5%) · Gross {formatINR(h.capital_gains.ltcg_112a_gross)}, Exempt {formatINR(h.capital_gains.ltcg_112a_exemption)}</td><td className="text-end">{formatINR(h.capital_gains.ltcg_112a_taxable)}</td></tr>
          <tr><td></td><td>LTCG 112 — Foreign (@ 12.5%)</td><td className="text-end">{formatINR(h.capital_gains.ltcg_112)}</td></tr>
          <tr className="fw-semibold table-light"><td></td><td>Subtotal (special rate)</td><td className="text-end">{formatINR(data.special_rate_cg)}</td></tr>

          {/* GTI */}
          <tr className="table-warning fw-bold"><td colSpan={2}>Gross Total Income</td><td className="text-end">{formatINR(data.gross_total_income)}</td></tr>

          {/* Deductions */}
          {data.deductions?.total > 0 && (
            <>
              <tr className="table-light"><td colSpan={2} className="fw-semibold">Deductions (New Regime)</td><td></td></tr>
              {d.nps_employer_80ccd2 > 0 && (
                <tr>
                  <td></td>
                  <td>
                    80CCD(2) — Employer NPS Contribution
                    {isOverridden && <span className="text-muted ms-1" style={{ fontSize: '0.7rem' }}>(computed: {formatINR(d.nps_employer_80ccd2_computed)})</span>}
                    {!npsEditing && (
                      <Button size="sm" variant="link" className="p-0 ms-2" style={{ fontSize: '0.7rem' }} onClick={onNpsEdit}>edit</Button>
                    )}
                  </td>
                  <td className="text-end">
                    {npsEditing ? (
                      <span className="d-flex align-items-center justify-content-end gap-1">
                        <Form.Control size="sm" type="number" value={npsValue} onChange={(e) => onNpsChange(e.target.value)} style={{ width: 120 }} />
                        <Button size="sm" variant="primary" className="py-0 px-1" onClick={onNpsSave}>Save</Button>
                        <Button size="sm" variant="link" className="py-0 px-1 text-muted" onClick={onNpsCancel}>✕</Button>
                      </span>
                    ) : (
                      `(${formatINR(d.nps_employer_80ccd2)})`
                    )}
                  </td>
                </tr>
              )}
              <tr className="fw-bold"><td colSpan={2}>Total Taxable Income</td><td className="text-end">{formatINR(data.total_taxable_income)}</td></tr>
            </>
          )}
        </tbody>
      </Table>

      <Table size="sm" bordered className="mt-3">
        <thead className="table-light">
          <tr><th colSpan={2}>Tax Computation — New Regime (Section 115BAC)</th><th className="text-end">₹</th></tr>
        </thead>
        <tbody>
          <tr><td></td><td>Tax on slab income (progressive rates)</td><td className="text-end">{formatINR(tax.on_slab_income)}</td></tr>
          <tr><td></td><td>Tax on STCG 111A @ 20%</td><td className="text-end">{formatINR(tax.on_stcg_111a)}</td></tr>
          <tr><td></td><td>Tax on LTCG 112A @ 12.5%</td><td className="text-end">{formatINR(tax.on_ltcg_112a)}</td></tr>
          <tr><td></td><td>Tax on LTCG 112 (Foreign) @ 12.5%</td><td className="text-end">{formatINR(tax.on_ltcg_112)}</td></tr>
          <tr className="fw-semibold"><td></td><td>Total tax before rebate</td><td className="text-end">{formatINR(tax.total_before_surcharge)}</td></tr>
          {tax.rebate_87a > 0 && <tr><td></td><td>Less: Section 87A Rebate</td><td className="text-end">({formatINR(tax.rebate_87a)})</td></tr>}
          <tr><td></td><td>Surcharge</td><td className="text-end">{formatINR(tax.surcharge)}</td></tr>
          <tr><td></td><td>Health & Education Cess (4%)</td><td className="text-end">{formatINR(tax.cess)}</td></tr>
          <tr className="table-warning fw-bold"><td colSpan={2}>Total Tax Liability</td><td className="text-end">{formatINR(tax.total_liability)}</td></tr>
        </tbody>
      </Table>

      <Table size="sm" bordered className="mt-3">
        <thead className="table-light">
          <tr><th colSpan={2}>Tax Credits</th><th className="text-end">₹</th></tr>
        </thead>
        <tbody>
          <tr><td></td><td>TDS on Salary</td><td className="text-end">{formatINR(credits.salary_tds)}</td></tr>
          {credits.other_tds > 0 && <tr><td></td><td>TDS on Other Income</td><td className="text-end">{formatINR(credits.other_tds)}</td></tr>}
          {credits.pf_tds > 0 && <tr><td></td><td>TDS on PF Interest</td><td className="text-end">{formatINR(credits.pf_tds)}</td></tr>}
          {credits.lrs_tcs > 0 && <tr><td></td><td>TCS on LRS Remittance</td><td className="text-end">{formatINR(credits.lrs_tcs)}</td></tr>}
          {credits.ftc > 0 && <tr><td></td><td>Foreign Tax Credit (Form 67)</td><td className="text-end">{formatINR(credits.ftc)}</td></tr>}
          <tr className="fw-semibold"><td></td><td>Total Credits</td><td className="text-end">{formatINR(credits.total)}</td></tr>
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
