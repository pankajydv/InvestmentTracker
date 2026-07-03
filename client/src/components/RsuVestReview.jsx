import React, { useEffect, useState, useCallback } from 'react';
import { Card, Button, Form, Alert, Badge } from 'react-bootstrap';
import { AlertTriangle } from 'lucide-react';
import {
  generateRsuVestSuggestions,
  getRsuVestSuggestions,
  resolveRsuVestSuggestions,
  deriveRsuVestValues,
} from '../services/api';
import { formatNumber, formatDate } from '../utils/formatters';
import { usePortfolio } from '../context/PortfolioContext';

const round3 = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
};

const round2 = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
};

function rowFromSuggestion(item) {
  const payload = item.payload || {};
  const base = payload.base || {};
  const values = payload.values || {};
  const grossUnits = Number(base.grossUnits ?? values.grossUnits ?? 0);
  const withholdingRate = Number(base.withholdingRate ?? values.withholdingRate ?? 0);
  const withheldUnits = Number(values.withheldUnits ?? round3(grossUnits * withholdingRate) ?? 0);
  return {
    id: item.id,
    investmentId: item.investment_id,
    investmentName: item.investment_name || `Investment #${item.investment_id}`,
    notes: item.notes || payload.notes || null,
    vestDate: payload.transactionDate || item.transaction_date,
    originalVestDate: payload.transactionDate || item.transaction_date,
    grossUnits,
    taxRatePct: withholdingRate ? Number((withholdingRate * 100).toFixed(3)) : 0,
    withheldUnits,
    fmv: round2(values.fmv ?? base.fmv ?? 0),
    // hidden (Option C): FX is auto-derived, not shown, sent silently on accept
    fxRate: base.fxRate != null ? Number(base.fxRate) : null,
    fmvSourceDate: values.fmvSourceDate || base.fmvSourceDate || null,
    warnings: payload.warnings || [],
    deriving: false,
  };
}

const netUnitsOf = (row) => round3(Number(row.grossUnits || 0) - Number(row.withheldUnits || 0));

export default function RsuVestReview() {
  const { selectedId } = usePortfolio();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [applyingId, setApplyingId] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getRsuVestSuggestions({ status: 'pending', portfolioId: selectedId || null, limit: 500 });
      setRows((data?.suggestions || []).map(rowFromSuggestion));
    } catch (e) {
      setError(e.message || 'Failed to load vest suggestions');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { load(); }, [load]);

  const scan = async () => {
    setScanning(true);
    setError('');
    setMessage('');
    try {
      const data = await generateRsuVestSuggestions({ portfolioId: selectedId || null });
      setMessage(`Scan complete — ${data.queued || 0} new, ${data.refreshed || 0} refreshed${data.skipped ? `, ${data.skipped} not derivable` : ''}.`);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to scan for vests');
    } finally {
      setScanning(false);
    }
  };

  const patchRow = (id, patch) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const onGross = (id, value) => {
    setRows((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      const grossUnits = value === '' ? '' : Number(value);
      const g = Number(grossUnits) || 0;
      const withheldUnits = round3(g * (Number(r.taxRatePct) || 0) / 100);
      return { ...r, grossUnits, withheldUnits };
    }));
  };
  const onTaxRate = (id, value) => {
    setRows((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      const taxRatePct = value === '' ? '' : Number(value);
      const withheldUnits = round3((Number(r.grossUnits) || 0) * (Number(taxRatePct) || 0) / 100);
      return { ...r, taxRatePct, withheldUnits };
    }));
  };
  const onWithheld = (id, value) => {
    setRows((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      const withheldUnits = value === '' ? '' : Number(value);
      const g = Number(r.grossUnits) || 0;
      const taxRatePct = g > 0 ? Number(((Number(withheldUnits) || 0) / g * 100).toFixed(3)) : r.taxRatePct;
      return { ...r, withheldUnits, taxRatePct };
    }));
  };
  const onFmv = (id, value) => patchRow(id, { fmv: value === '' ? '' : Number(value) });

  const onVestDate = async (id, value) => {
    patchRow(id, { vestDate: value, deriving: true });
    const row = rows.find((r) => r.id === id);
    try {
      const derived = await deriveRsuVestValues({
        investmentId: row.investmentId,
        date: value,
        grossUnits: row.grossUnits,
      });
      if (derived && derived.derivable) {
        patchRow(id, {
          fmv: round2(derived.values?.fmv ?? row.fmv),
          fmvSourceDate: derived.values?.fmvSourceDate || null,
          fxRate: derived.values?.fxRate != null ? Number(derived.values.fxRate) : row.fxRate,
          warnings: derived.warnings || row.warnings,
          deriving: false,
        });
      } else {
        patchRow(id, { deriving: false });
      }
    } catch (_e) {
      patchRow(id, { deriving: false });
    }
  };

  const resolve = async (row, decision) => {
    setApplyingId(row.id);
    setError('');
    setMessage('');
    try {
      const overrides = decision === 'accept'
        ? {
          vestDate: row.vestDate,
          grossUnits: Number(row.grossUnits) || 0,
          fmv: Number(row.fmv) || 0,
          withholdingRate: (Number(row.taxRatePct) || 0) / 100,
          withheldUnits: Number(row.withheldUnits) || 0,
          fxRate: row.fxRate,
        }
        : {};
      const data = await resolveRsuVestSuggestions({ items: [{ id: row.id, overrides }], decision });
      if (decision === 'accept') {
        setMessage(data.accepted ? `Accepted vest for ${row.investmentName}.` : 'Nothing applied (check values).');
      } else {
        setMessage(`Rejected vest for ${row.investmentName}.`);
      }
      await load();
    } catch (e) {
      setError(e.message || 'Failed to resolve vest');
    } finally {
      setApplyingId(null);
    }
  };

  const dateWarn = (row) => {
    const a = new Date(`${String(row.vestDate).slice(0, 10)}T00:00:00Z`).getTime();
    const b = new Date(`${String(row.originalVestDate).slice(0, 10)}T00:00:00Z`).getTime();
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 7 * 86400000;
  };

  return (
    <Card className="shadow-sm">
      <Card.Header className="bg-white d-flex align-items-center justify-content-between py-2">
        <div className="small">
          <strong>RSU Vests to actualize</strong>
          <span className="text-muted ms-2">({rows.length})</span>
        </div>
        <div className="d-flex gap-2">
          <Button size="sm" variant="outline-secondary" onClick={load} disabled={loading || scanning || applyingId != null}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button size="sm" variant="primary" onClick={scan} disabled={scanning || applyingId != null}>
            {scanning ? 'Scanning…' : 'Scan for vests'}
          </Button>
        </div>
      </Card.Header>
      <Card.Body className="pt-3 pb-2">
        {error && <Alert variant="danger" className="small py-2">{error}</Alert>}
        {message && <Alert variant="success" className="small py-2">{message}</Alert>}
        {loading ? (
          <div className="small text-muted">Loading vests…</div>
        ) : rows.length === 0 ? (
          <div className="small text-muted">No vests awaiting actualization. Use “Scan for vests” to detect any.</div>
        ) : (
          <div className="d-flex flex-column gap-3">
            {rows.map((row) => {
              const net = netUnitsOf(row);
              const busy = applyingId === row.id;
              return (
                <div key={row.id} className="border rounded p-3">
                  <div className="d-flex justify-content-between align-items-start mb-2">
                    <div>
                      <div className="fw-semibold">{row.investmentName}</div>
                      {row.notes && <div className="text-muted small">{row.notes}</div>}
                    </div>
                    <Badge bg="light" text="dark" className="border">VEST</Badge>
                  </div>

                  <div className="row g-2 align-items-end">
                    <div className="col-6 col-md-2">
                      <Form.Label className="small text-muted mb-1">Vest date</Form.Label>
                      <Form.Control
                        size="sm"
                        type="date"
                        value={String(row.vestDate).slice(0, 10)}
                        onChange={(e) => onVestDate(row.id, e.target.value)}
                        isInvalid={dateWarn(row)}
                      />
                    </div>
                    <div className="col-6 col-md-2">
                      <Form.Label className="small text-muted mb-1">Gross units</Form.Label>
                      <Form.Control size="sm" type="number" step="0.001" value={row.grossUnits}
                        onChange={(e) => onGross(row.id, e.target.value)} />
                    </div>
                    <div className="col-6 col-md-2">
                      <Form.Label className="small text-muted mb-1">Tax withheld %</Form.Label>
                      <Form.Control size="sm" type="number" step="0.001" value={row.taxRatePct}
                        onChange={(e) => onTaxRate(row.id, e.target.value)} />
                    </div>
                    <div className="col-6 col-md-2">
                      <Form.Label className="small text-muted mb-1">Withheld units</Form.Label>
                      <Form.Control size="sm" type="number" step="0.001" value={row.withheldUnits}
                        onChange={(e) => onWithheld(row.id, e.target.value)} />
                    </div>
                    <div className="col-6 col-md-2">
                      <Form.Label className="small text-muted mb-1">
                        FMV / share $ {row.deriving && <span className="text-muted">…</span>}
                      </Form.Label>
                      <Form.Control size="sm" type="number" step="0.01" value={row.fmv}
                        onChange={(e) => onFmv(row.id, e.target.value)} />
                    </div>
                    <div className="col-6 col-md-2">
                      <Form.Label className="small text-muted mb-1">Net units</Form.Label>
                      <div className="form-control form-control-sm bg-light text-end fw-medium">
                        {net != null ? formatNumber(net, 3) : '—'}
                      </div>
                    </div>
                  </div>

                  {row.fmvSourceDate && (
                    <div className="text-muted small mt-2">
                      FMV = prior-session close on {formatDate(row.fmvSourceDate)}.
                    </div>
                  )}
                  {dateWarn(row) && (
                    <div className="text-danger small mt-1 d-flex align-items-center gap-1">
                      <AlertTriangle size={14} /> Vest date is more than 7 days from the scheduled date and cannot be accepted.
                    </div>
                  )}
                  {(row.warnings || [])
                    .filter((w) => w && w.code !== 'FX_REFERENCE_UNCERTAIN' && w.code !== 'NO_FX')
                    .map((w, i) => (
                      <div key={i} className="text-muted small mt-1">• {w.message}</div>
                    ))}

                  <div className="d-flex gap-2 mt-3">
                    <Button size="sm" variant="success" disabled={busy || dateWarn(row)}
                      onClick={() => resolve(row, 'accept')}>
                      {busy ? 'Applying…' : 'Accept'}
                    </Button>
                    <Button size="sm" variant="outline-danger" disabled={busy}
                      onClick={() => resolve(row, 'reject')}>
                      Reject
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
