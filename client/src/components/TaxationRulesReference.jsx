import React, { useState } from 'react';
import { Badge, Button, Card, Form, Spinner, Table } from 'react-bootstrap';
import { ChevronDown, ChevronRight, Info, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { formatINR } from '../utils/formatters';
import { deleteTaxRules, saveTaxRules } from '../services/api';

function pct(rate) { return `${(Number(rate) * 100).toFixed(rate % 0.01 === 0 ? 0 : 1)}%`; }
function toRate(s) { const n = parseFloat(s); return Number.isFinite(n) ? n / 100 : 0; }
function toInt(s) { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; }

function formToPayload(form) {
  return {
    newRegime: {
      status: 'supported',
      standardDeduction: toInt(form.standardDeduction),
      slabs: form.slabs.map((s) => ({
        upto: s.upto === '' ? Infinity : Number(s.upto),
        rate: toRate(s.rate),
        label: s.label,
      })),
      capitalGains: {
        stcg: { rate: toRate(form.stcgRate), section: '111A (Equity, STT paid)', description: 'Short-Term Capital Gain (equity with STT)' },
        ltcgEquity: { rate: toRate(form.ltcgEquityRate), section: '112A', exemption: toInt(form.ltcgExemption), description: `Long-Term Capital Gain (equity) – ${formatINR(toInt(form.ltcgExemption), 0, { sensitive: false })} exempt` },
        ltcgForeign: { rate: toRate(form.ltcgForeignRate), section: '112', description: 'Long-Term Capital Gain (foreign)' },
        stcgForeign: { rate: 'slab', section: 'Slab rate', description: 'Short-Term Capital Gain (foreign) – taxed at slab rate' },
      },
      rebate87A: { limit: toInt(form.rebateLimit), amount: toInt(form.rebateAmount), description: form.rebateDescription },
      surcharge: form.surcharge.map((s) => ({
        upto: s.upto === '' ? Infinity : Number(s.upto),
        rate: toRate(s.rate),
        label: s.label,
      })),
      cess: { rate: toRate(form.cessRate), baseAmount: 'Tax + Surcharge', description: form.cessDescription },
    },
  };
}

function rulesApiToForm(rules) {
  return {
    standardDeduction: String(rules.standard_deduction ?? ''),
    stcgRate: String((Number(rules.capital_gains?.stcg?.rate) * 100).toFixed(1)),
    ltcgEquityRate: String((Number(rules.capital_gains?.ltcg_equity?.rate) * 100).toFixed(2)),
    ltcgExemption: String(rules.capital_gains?.ltcg_equity?.exemption ?? ''),
    ltcgForeignRate: String((Number(rules.capital_gains?.ltcg_foreign?.rate) * 100).toFixed(2)),
    rebateLimit: String(rules.rebate_87a?.limit ?? ''),
    rebateAmount: String(rules.rebate_87a?.amount ?? ''),
    rebateDescription: rules.rebate_87a?.description ?? '',
    cessRate: String((Number(rules.cess?.rate) * 100).toFixed(0)),
    cessDescription: rules.cess?.description ?? '',
    slabs: (rules.slabs ?? []).map((s) => ({
      upto: s.upto === Infinity || s.upto == null ? '' : String(s.upto),
      rate: String((s.rate * 100).toFixed(0)),
      label: s.label ?? '',
    })),
    surcharge: (rules.surcharge ?? []).map((s) => ({
      upto: s.upto === Infinity || s.upto == null ? '' : String(s.upto),
      rate: String((s.rate * 100).toFixed(0)),
      label: s.label ?? '',
    })),
  };
}

const BLANK_SLAB = { upto: '', rate: '', label: '' };

export default function TaxationRulesReference({ rules, fy, onSaved }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isDbOverride = rules?.source === 'db';

  function startEdit() { setForm(rulesApiToForm(rules)); setEditing(true); setIsExpanded(true); setError(''); }
  function cancelEdit() { setEditing(false); setForm(null); setError(''); }

  async function handleSave() {
    setSaving(true); setError('');
    try { await saveTaxRules(fy, formToPayload(form)); setEditing(false); setForm(null); await onSaved?.(); }
    catch (e) { setError(e.message || 'Save failed'); }
    finally { setSaving(false); }
  }

  async function handleReset() {
    if (!window.confirm(`Remove custom override for FY ${fy} and revert to built-in rules?`)) return;
    setSaving(true);
    try { await deleteTaxRules(fy); setEditing(false); setForm(null); await onSaved?.(); }
    catch (e) { setError(e.message || 'Reset failed'); }
    finally { setSaving(false); }
  }

  function setSlabField(idx, field, value) {
    setForm((f) => ({ ...f, slabs: f.slabs.map((s, i) => i === idx ? { ...s, [field]: value } : s) }));
  }
  function setSurchargeField(idx, field, value) {
    setForm((f) => ({ ...f, surcharge: f.surcharge.map((s, i) => i === idx ? { ...s, [field]: value } : s) }));
  }

  if (!rules || !rules.standard_deduction) return null;

  return (
    <Card className="mt-4 border-info bg-light">
      <Card.Header className="bg-info text-white d-flex align-items-center gap-2" style={{ padding: '0.75rem 1.25rem' }}>
        <Info size={18} className="flex-shrink-0" onClick={() => setIsExpanded((v) => !v)} style={{ cursor: 'pointer' }} />
        <div className="flex-grow-1 d-flex justify-content-between align-items-center">
          <span className="fw-semibold" onClick={() => setIsExpanded((v) => !v)} style={{ cursor: 'pointer' }}>
            Taxation Rules — FY {fy} (New Regime §115BAC)
            {isDbOverride && <Badge bg="warning" text="dark" className="ms-2 small">Custom</Badge>}
          </span>
          <div className="d-flex align-items-center gap-2">
            {!editing && (
              <Button size="sm" variant="light" onClick={startEdit} title="Edit rules">
                <Pencil size={13} className="me-1" />Edit
              </Button>
            )}
            {!editing && isDbOverride && (
              <Button size="sm" variant="outline-light" onClick={handleReset} disabled={saving} title="Revert to built-in rules">
                <RotateCcw size={13} className="me-1" />Revert
              </Button>
            )}
            <span onClick={() => setIsExpanded((v) => !v)} style={{ cursor: 'pointer' }}>
              {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
            </span>
          </div>
        </div>
      </Card.Header>

      {isExpanded && !editing && <ReadOnlyView rules={rules} />}

      {isExpanded && editing && form && (
        <Card.Body>
          {error && <div className="alert alert-danger small py-2 mb-3">{error}</div>}

          <div className="row g-3 mb-3">
            <div className="col-md-4">
              <Form.Label className="fw-semibold small">Standard Deduction (₹)</Form.Label>
              <Form.Control size="sm" type="number" value={form.standardDeduction}
                onChange={(e) => setForm((f) => ({ ...f, standardDeduction: e.target.value }))} />
            </div>
            <div className="col-md-4">
              <Form.Label className="fw-semibold small">STCG 111A Rate (%)</Form.Label>
              <Form.Control size="sm" type="number" step="0.1" value={form.stcgRate}
                onChange={(e) => setForm((f) => ({ ...f, stcgRate: e.target.value }))} />
            </div>
          </div>

          <div className="row g-3 mb-3">
            <div className="col-md-3">
              <Form.Label className="fw-semibold small">LTCG 112A Rate (%)</Form.Label>
              <Form.Control size="sm" type="number" step="0.1" value={form.ltcgEquityRate}
                onChange={(e) => setForm((f) => ({ ...f, ltcgEquityRate: e.target.value }))} />
            </div>
            <div className="col-md-3">
              <Form.Label className="fw-semibold small">LTCG 112A Exemption (₹)</Form.Label>
              <Form.Control size="sm" type="number" value={form.ltcgExemption}
                onChange={(e) => setForm((f) => ({ ...f, ltcgExemption: e.target.value }))} />
            </div>
            <div className="col-md-3">
              <Form.Label className="fw-semibold small">LTCG 112 Foreign Rate (%)</Form.Label>
              <Form.Control size="sm" type="number" step="0.1" value={form.ltcgForeignRate}
                onChange={(e) => setForm((f) => ({ ...f, ltcgForeignRate: e.target.value }))} />
            </div>
            <div className="col-md-3">
              <Form.Label className="fw-semibold small">Cess Rate (%)</Form.Label>
              <Form.Control size="sm" type="number" step="0.5" value={form.cessRate}
                onChange={(e) => setForm((f) => ({ ...f, cessRate: e.target.value }))} />
            </div>
          </div>

          <div className="row g-3 mb-3">
            <div className="col-md-4">
              <Form.Label className="fw-semibold small">Rebate 87A — Income Limit (₹)</Form.Label>
              <Form.Control size="sm" type="number" value={form.rebateLimit}
                onChange={(e) => setForm((f) => ({ ...f, rebateLimit: e.target.value }))} />
            </div>
            <div className="col-md-4">
              <Form.Label className="fw-semibold small">Rebate 87A — Amount (₹)</Form.Label>
              <Form.Control size="sm" type="number" value={form.rebateAmount}
                onChange={(e) => setForm((f) => ({ ...f, rebateAmount: e.target.value }))} />
            </div>
          </div>

          <SlabEditor label="Income Slabs" slabs={form.slabs}
            onAdd={() => setForm((f) => ({ ...f, slabs: [...f.slabs, { ...BLANK_SLAB }] }))}
            onChange={setSlabField}
            onRemove={(idx) => setForm((f) => ({ ...f, slabs: f.slabs.filter((_, i) => i !== idx) }))} />

          <SlabEditor label="Surcharge Slabs" slabs={form.surcharge}
            onAdd={() => setForm((f) => ({ ...f, surcharge: [...f.surcharge, { ...BLANK_SLAB }] }))}
            onChange={setSurchargeField}
            onRemove={(idx) => setForm((f) => ({ ...f, surcharge: f.surcharge.filter((_, i) => i !== idx) }))} />

          <div className="d-flex gap-2">
            <Button size="sm" variant="primary" onClick={handleSave} disabled={saving}>
              {saving && <Spinner animation="border" size="sm" className="me-1" />}Save Rules
            </Button>
            <Button size="sm" variant="outline-secondary" onClick={cancelEdit} disabled={saving}>Cancel</Button>
          </div>
        </Card.Body>
      )}
    </Card>
  );
}

function SlabEditor({ label, slabs, onAdd, onChange, onRemove }) {
  return (
    <div className="mb-3">
      <div className="d-flex align-items-center justify-content-between mb-1">
        <span className="fw-semibold small">{label}</span>
        <Button size="sm" variant="outline-secondary" onClick={onAdd}><Plus size={13} /> Add</Button>
      </div>
      <Table size="sm" bordered className="small">
        <thead className="table-light"><tr><th>Upper limit (₹, blank = ∞)</th><th>Rate (%)</th><th>Label</th><th></th></tr></thead>
        <tbody>
          {slabs.map((s, idx) => (
            <tr key={idx}>
              <td><Form.Control size="sm" type="number" placeholder="∞" value={s.upto} onChange={(e) => onChange(idx, 'upto', e.target.value)} /></td>
              <td><Form.Control size="sm" type="number" step="1" value={s.rate} onChange={(e) => onChange(idx, 'rate', e.target.value)} /></td>
              <td><Form.Control size="sm" value={s.label} onChange={(e) => onChange(idx, 'label', e.target.value)} /></td>
              <td><Button size="sm" variant="outline-danger" onClick={() => onRemove(idx)}><Trash2 size={12} /></Button></td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function ReadOnlyView({ rules }) {
  return (
    <Card.Body>
      <div className="small">
        <div className="mb-3"><span className="fw-semibold">Standard Deduction:</span> {formatINR(rules.standard_deduction, 0, { sensitive: false })}</div>
        <div className="mb-3">
          <div className="fw-semibold mb-1">Income Slabs</div>
          <Table size="sm" bordered className="mb-0">
            <thead className="table-light"><tr><th>Range</th><th className="text-end">Rate</th></tr></thead>
            <tbody>{rules.slabs?.map((s, i) => (<tr key={i}><td>{s.label}</td><td className="text-end"><Badge bg="secondary">{pct(s.rate)}</Badge></td></tr>))}</tbody>
          </Table>
        </div>
        <div className="mb-3">
          <div className="fw-semibold mb-1">Capital Gains</div>
          <Table size="sm" borderless className="mb-0">
            <tbody>
              <tr><td>STCG 111A</td><td><Badge bg="warning" text="dark">{pct(rules.capital_gains?.stcg?.rate)}</Badge></td></tr>
              <tr><td>LTCG 112A — exempt up to {formatINR(rules.capital_gains?.ltcg_equity?.exemption, 0, { sensitive: false })}</td><td><Badge bg="success">{pct(rules.capital_gains?.ltcg_equity?.rate)}</Badge></td></tr>
              <tr><td>LTCG 112 Foreign</td><td><Badge bg="success">{pct(rules.capital_gains?.ltcg_foreign?.rate)}</Badge></td></tr>
            </tbody>
          </Table>
        </div>
        <div className="mb-3"><span className="fw-semibold">Rebate 87A:</span> Up to {formatINR(rules.rebate_87a?.limit, 0, { sensitive: false })} → rebate {formatINR(rules.rebate_87a?.amount, 0, { sensitive: false })}</div>
        <div className="mb-3">
          <div className="fw-semibold mb-1">Surcharge</div>
          <Table size="sm" bordered className="mb-0">
            <thead className="table-light"><tr><th>Income Range</th><th className="text-end">Rate</th></tr></thead>
            <tbody>{rules.surcharge?.map((s, i) => (<tr key={i}><td>{s.label}</td><td className="text-end"><Badge bg="info">{pct(s.rate)}</Badge></td></tr>))}</tbody>
          </Table>
        </div>
        <div><span className="fw-semibold">Cess:</span> {pct(rules.cess?.rate)} of (Tax + Surcharge)</div>
      </div>
    </Card.Body>
  );
}
