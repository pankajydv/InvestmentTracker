import React, { useEffect, useMemo, useState } from 'react';
import { Card, Row, Col, Form, Button, Table, Badge, Spinner, Accordion } from 'react-bootstrap';
import { Download } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';
import { getTaxReport } from '../services/api';
import { formatINR, formatDate, formatNumber, profitColor } from '../utils/formatters';

function fyOptions() {
  const start = 2020;
  const current = new Date();
  const fyStartYear = current.getMonth() >= 3 ? current.getFullYear() : current.getFullYear() - 1;
  const max = fyStartYear + 1;
  const options = [];
  for (let y = start; y <= max; y += 1) {
    const yy = String(y + 1).slice(-2);
    options.push(`${y}-${yy}`);
  }
  return options.reverse();
}

function toCSV(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escapeCell = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  return lines.join('\n');
}

function downloadCSV(filename, rows) {
  const csv = toCSV(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function combineTaxReports(reports) {
  if (!Array.isArray(reports) || !reports.length) return null;

  const combined = {
    perquisite_income: [],
    capital_gains: [],
    dividend_income: [],
    schedule_fa: [],
    summary: {
      total_perquisite_inr: 0,
      total_stcg_inr: 0,
      total_ltcg_inr: 0,
      total_dividend_inr: 0,
      tax_note: reports[0]?.summary?.tax_note || '',
    },
  };

  for (const report of reports) {
    combined.perquisite_income.push(...(report?.perquisite_income || []));
    combined.capital_gains.push(...(report?.capital_gains || []));
    combined.dividend_income.push(...(report?.dividend_income || []));
    combined.schedule_fa.push(...(report?.schedule_fa || []));

    combined.summary.total_perquisite_inr += Number(report?.summary?.total_perquisite_inr) || 0;
    combined.summary.total_stcg_inr += Number(report?.summary?.total_stcg_inr) || 0;
    combined.summary.total_ltcg_inr += Number(report?.summary?.total_ltcg_inr) || 0;
    combined.summary.total_dividend_inr += Number(report?.summary?.total_dividend_inr) || 0;
  }

  return combined;
}

export default function TaxReport() {
  const { selectedId, selectedIds, portfolios } = usePortfolio();
  const options = useMemo(() => fyOptions(), []);
  const [fy, setFy] = useState(options[0]);
  const [portfolioId, setPortfolioId] = useState(selectedId || '');
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (selectedIds.length === 1) {
      setPortfolioId(String(selectedIds[0]));
    } else {
      setPortfolioId('');
    }
  }, [selectedId, selectedIds]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      if (portfolioId) {
        const data = await getTaxReport(fy, portfolioId);
        setReport(data);
      } else if (selectedIds.length > 1) {
        const results = await Promise.all(selectedIds.map((id) => getTaxReport(fy, id)));
        setReport(combineTaxReports(results));
      } else {
        const effectivePortfolioId = selectedId || undefined;
        const data = await getTaxReport(fy, effectivePortfolioId);
        setReport(data);
      }
    } catch (e) {
      setError(e.message || 'Failed to load tax report');
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  const summary = report?.summary || {};

  return (
    <div className="d-flex flex-column gap-3">
      <Card className="shadow-sm">
        <Card.Body>
          <div className="d-flex flex-wrap align-items-end gap-2">
            <div>
              <div className="small text-muted">Financial Year</div>
              <Form.Select size="sm" value={fy} onChange={(e) => setFy(e.target.value)}>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </Form.Select>
            </div>
            <div>
              <div className="small text-muted">Portfolio</div>
              <Form.Select size="sm" value={portfolioId} onChange={(e) => setPortfolioId(e.target.value)}>
                <option value="">Selected / All</option>
                {portfolios.map((p) => (
                  <option key={p.id} value={String(p.id)}>{p.name}</option>
                ))}
              </Form.Select>
            </div>
            <Button size="sm" onClick={load} disabled={loading}>
              {loading ? <Spinner animation="border" size="sm" /> : 'Generate Report'}
            </Button>
          </div>
          {error && <div className="text-danger small mt-2">{error}</div>}
        </Card.Body>
      </Card>

      {report && (
        <>
          <Row className="g-3">
            <Col md={3}><SummaryCard label="Perquisite (Schedule 1)" value={formatINR(summary.total_perquisite_inr || 0)} /></Col>
            <Col md={3}><SummaryCard label="STCG" value={formatINR(summary.total_stcg_inr || 0)} color={profitColor(summary.total_stcg_inr || 0)} /></Col>
            <Col md={3}><SummaryCard label="LTCG" value={formatINR(summary.total_ltcg_inr || 0)} color={profitColor(summary.total_ltcg_inr || 0)} /></Col>
            <Col md={3}><SummaryCard label="Dividend (Schedule OS)" value={formatINR(summary.total_dividend_inr || 0)} /></Col>
          </Row>

          <Accordion defaultActiveKey="0" className="shadow-sm">
            <Accordion.Item eventKey="0">
              <Accordion.Header>Schedule 1: Perquisite Income ({report.perquisite_income.length})</Accordion.Header>
              <Accordion.Body>
                <div className="d-flex justify-content-end mb-2">
                  <Button size="sm" variant="outline-secondary" onClick={() => downloadCSV(`perquisite_${fy}.csv`, report.perquisite_income)}>
                    <Download size={14} className="me-1" /> Export CSV
                  </Button>
                </div>
                <div className="table-responsive">
                  <Table size="sm" hover>
                    <thead><tr><th>Date</th><th>Type</th><th>Investment</th><th>Units</th><th>FMV USD</th><th>Rate</th><th>Perquisite INR</th></tr></thead>
                    <tbody>
                      {report.perquisite_income.map((r, idx) => (
                        <tr key={idx}>
                          <td>{formatDate(r.date)}</td>
                          <td>{r.type}</td>
                          <td>{r.investment}</td>
                          <td>{formatNumber(r.units || 0, 4)}</td>
                          <td>{r.fmv_per_share_usd != null ? `$${formatNumber(r.fmv_per_share_usd, 2)}` : '-'}</td>
                          <td>{r.exchange_rate || '-'}</td>
                          <td>{formatINR(r.perquisite_inr || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="1">
              <Accordion.Header>Schedule CG: Capital Gains ({report.capital_gains.length})</Accordion.Header>
              <Accordion.Body>
                <div className="d-flex justify-content-end mb-2">
                  <Button size="sm" variant="outline-secondary" onClick={() => downloadCSV(`capital_gains_${fy}.csv`, report.capital_gains)}>
                    <Download size={14} className="me-1" /> Export CSV
                  </Button>
                </div>
                <div className="table-responsive">
                  <Table size="sm" hover>
                    <thead><tr><th>Investment</th><th>Lot Type</th><th>Acq Date</th><th>Sale Date</th><th>Units</th><th>Cost INR</th><th>Proceeds INR</th><th>Gain/Loss</th><th>Type</th></tr></thead>
                    <tbody>
                      {report.capital_gains.map((r, idx) => (
                        <tr key={idx}>
                          <td>{r.investment}</td>
                          <td>{r.lot_type}</td>
                          <td>{formatDate(r.acquisition_date)}</td>
                          <td>{formatDate(r.sale_date)}</td>
                          <td>{formatNumber(r.units_sold || 0, 4)}</td>
                          <td>{formatINR(r.cost_inr || 0)}</td>
                          <td>{formatINR(r.sale_proceeds_inr || 0)}</td>
                          <td className={profitColor(r.gain_loss_inr || 0)}>{formatINR(r.gain_loss_inr || 0)}</td>
                          <td><Badge bg={r.gain_type === 'LTCG' ? 'success' : 'warning'}>{r.gain_type}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="2">
              <Accordion.Header>Schedule OS: Dividend Income ({report.dividend_income.length})</Accordion.Header>
              <Accordion.Body>
                <div className="d-flex justify-content-end mb-2">
                  <Button size="sm" variant="outline-secondary" onClick={() => downloadCSV(`dividend_${fy}.csv`, report.dividend_income)}>
                    <Download size={14} className="me-1" /> Export CSV
                  </Button>
                </div>
                <div className="table-responsive">
                  <Table size="sm" hover>
                    <thead><tr><th>Date</th><th>Investment</th><th>USD</th><th>Rate</th><th>INR</th></tr></thead>
                    <tbody>
                      {report.dividend_income.map((r, idx) => (
                        <tr key={idx}>
                          <td>{formatDate(r.date)}</td>
                          <td>{r.investment}</td>
                          <td>{r.usd_amount != null ? `$${formatNumber(r.usd_amount, 2)}` : '-'}</td>
                          <td>{r.exchange_rate || '-'}</td>
                          <td>{formatINR(r.amount_inr || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="3">
              <Accordion.Header>Schedule FA: Foreign Asset Disclosure ({report.schedule_fa.length})</Accordion.Header>
              <Accordion.Body>
                <div className="d-flex justify-content-end mb-2">
                  <Button size="sm" variant="outline-secondary" onClick={() => downloadCSV(`schedule_fa_${fy}.csv`, report.schedule_fa)}>
                    <Download size={14} className="me-1" /> Export CSV
                  </Button>
                </div>
                <div className="table-responsive">
                  <Table size="sm" hover>
                    <thead><tr><th>Investment</th><th>Ticker</th><th>Units Held</th><th>Acq Cost USD</th><th>Acq Cost INR</th><th>Year-End Value INR</th><th>Peak Value INR</th></tr></thead>
                    <tbody>
                      {report.schedule_fa.map((r, idx) => (
                        <tr key={idx}>
                          <td>{r.investment}</td>
                          <td>{r.ticker || '-'}</td>
                          <td>{formatNumber(r.units_held || 0, 4)}</td>
                          <td>${formatNumber(r.acquisition_cost_usd || 0, 2)}</td>
                          <td>{formatINR(r.acquisition_cost_inr || 0)}</td>
                          <td>{r.year_end_value_inr != null ? formatINR(r.year_end_value_inr) : '-'}</td>
                          <td>{r.peak_value_inr != null ? formatINR(r.peak_value_inr) : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Accordion.Body>
            </Accordion.Item>
          </Accordion>

          <div className="small text-muted">{summary.tax_note}</div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color = '' }) {
  return (
    <Card className="shadow-sm h-100">
      <Card.Body className="py-3">
        <div className="text-muted" style={{ fontSize: '0.75rem' }}>{label}</div>
        <div className={`fs-6 fw-bold ${color}`}>{value}</div>
      </Card.Body>
    </Card>
  );
}
