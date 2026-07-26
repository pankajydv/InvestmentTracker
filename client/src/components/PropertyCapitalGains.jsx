import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Form, Spinner, Table } from 'react-bootstrap';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { getPropertyItems, savePropertyItems } from '../services/api';
import { formatINRExact as formatINR } from '../utils/formatters';
import CollapsibleSectionHeader from './CollapsibleSectionHeader';

const ITEM_TYPES = [ 
  { key: 'SALE_CONSIDERATION', label: 'Sale Consideration' },
  { key: 'PURCHASE_CONSIDERATION', label: 'Purchase Consideration' },
  { key: 'LAND_COST', label: 'Land Cost' },
  { key: 'CONSTRUCTION_COST', label: 'Construction Cost' },
  { key: 'STAMP_DUTY', label: 'Stamp Duty / Registration' },
  { key: 'BROKERAGE', label: 'Brokerage' },
  { key: 'TRANSFER_EXPENSE', label: 'Transfer Expense' },
  { key: 'IMPROVEMENT_COST', label: 'Improvement Cost' },
  { key: 'OTHER_COST', label: 'Other Cost' },
  { key: 'CUSTOM', label: 'Custom' },
];

const TYPE_LABEL = Object.fromEntries(ITEM_TYPES.map((t) => [t.key, t.label]));

function ddmmyyyyToIso(v) {
  if (!v || typeof v !== 'string') return null;
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export default function PropertyCapitalGains({ fy, portfolioId, ais, ltcg112 = 0, onSaved, propertySignalUnknown = false, showHeader = true }) {
  const [expanded, setExpanded] = useState(true);
  const [savedRows, setSavedRows] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const tempIdSeq = useRef(0);

  const cloneRows = (inputRows) => (inputRows || []).map((row) => ({ ...row }));
  const makeTempId = () => {
    tempIdSeq.current += 1;
    return `temp-${Date.now()}-${tempIdSeq.current}`;
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getPropertyItems(fy, portfolioId || undefined);
      const nextRows = Array.isArray(data) ? data : [];
      setSavedRows(cloneRows(nextRows));
      setRows(cloneRows(nextRows));
    } catch (e) {
      setError(e.message || 'Failed to load property rows');
      setSavedRows([]);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!fy) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fy, portfolioId]);

  const suggestedRows = useMemo(() => {
    const sales = ais?.property_sales || {};
    const purchases = ais?.property_purchases || {};
    const saleDate = sales?.rows?.[0]?.transaction_date ? ddmmyyyyToIso(sales.rows[0].transaction_date) : null;
    const purchaseDate = purchases?.rows?.[0]?.date ? ddmmyyyyToIso(purchases.rows[0].date) : null;
    const saleAmount = Number(sales?.total_amount) || 0;
    const purchaseAmount = Number(purchases?.total_amount) || 0;
    return [
      { property_side: 'OLD', item_type: 'SALE_CONSIDERATION', label: 'Old Property Sale (AIS)', amount: saleAmount, txn_date: saleDate, notes: 'Auto-seeded from AIS' },
      { property_side: 'NEW', item_type: 'PURCHASE_CONSIDERATION', label: 'New Property Purchase (AIS)', amount: purchaseAmount, txn_date: purchaseDate, notes: 'Auto-seeded from AIS' },
      { property_side: 'OLD', item_type: 'LAND_COST', label: 'Land Cost', amount: 0, txn_date: null, notes: '' },
      { property_side: 'OLD', item_type: 'CONSTRUCTION_COST', label: 'Construction Cost', amount: 0, txn_date: null, notes: '' },
      { property_side: 'OLD', item_type: 'STAMP_DUTY', label: 'Old Property Stamp Duty', amount: 0, txn_date: null, notes: '' },
      { property_side: 'OLD', item_type: 'BROKERAGE', label: 'Old Property Brokerage', amount: 0, txn_date: null, notes: '' },
      { property_side: 'OLD', item_type: 'IMPROVEMENT_COST', label: 'Improvement Cost', amount: 0, txn_date: null, notes: '' },
      { property_side: 'OLD', item_type: 'TRANSFER_EXPENSE', label: 'Old Property Transfer Expense', amount: 0, txn_date: null, notes: '' },
      { property_side: 'NEW', item_type: 'STAMP_DUTY', label: 'New Property Stamp Duty', amount: 0, txn_date: null, notes: '' },
      { property_side: 'NEW', item_type: 'BROKERAGE', label: 'New Property Brokerage', amount: 0, txn_date: null, notes: '' },
    ];
  }, [ais]);

  const handleSeed = async () => {
    if (!fy || rows.length > 0) return;
    setSeeding(true);
    setError('');
    try {
      const created = [];
      for (const item of suggestedRows) {
        // Avoid adding zero-value AIS rows if AIS doesn't contain those sections.
        if (item.notes && !item.amount) continue;
        created.push({
          id: makeTempId(),
          fy,
          portfolio_id: portfolioId || null,
          ...item,
        });
      }
      setRows(created);
    } catch (e) {
      setError(e.message || 'Failed to add suggested rows');
    } finally {
      setSeeding(false);
    }
  };

  const handleAddCustom = async (side) => {
    try {
      const row = {
        id: makeTempId(),
        fy,
        portfolio_id: portfolioId || null,
        property_side: side,
        item_type: 'CUSTOM',
        label: '',
        amount: 0,
        txn_date: null,
        notes: '',
      };
      setRows((prev) => [...prev, row]);
    } catch (e) {
      setError(e.message || 'Failed to add row');
    }
  };

  const handleUpdate = async (id, patch) => {
    const current = rows.find((r) => r.id === id);
    if (!current) return;
    const next = {
      ...current,
      ...patch,
      ...(patch.item_type && patch.item_type !== 'CUSTOM' ? { label: TYPE_LABEL[patch.item_type] || patch.item_type } : {}),
    };
    setRows((prev) => prev.map((r) => (r.id === id ? next : r)));
  };

  const handleDelete = async (id) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const handleReset = () => {
    setRows(cloneRows(savedRows));
    setError('');
  };

  const handleSave = async () => {
    if (!fy || !portfolioId) return;
    setSaving(true);
    setError('');
    try {
      const saved = await savePropertyItems(
        fy,
        portfolioId,
        rows.map((row) => {
          const itemType = row.item_type || 'CUSTOM';
          return {
            property_side: row.property_side,
            item_type: itemType,
            label: itemType === 'CUSTOM' ? (row.label || 'Custom Cost') : (row.label || TYPE_LABEL[itemType] || itemType),
            amount: Number(row.amount) || 0,
            txn_date: row.txn_date || null,
            notes: row.notes || null,
          };
        }),
      );
      const nextRows = Array.isArray(saved) ? saved : [];
      setSavedRows(cloneRows(nextRows));
      setRows(cloneRows(nextRows));
      await onSaved?.();
    } catch (e) {
      setError(e.message || 'Failed to save property rows');
    } finally {
      setSaving(false);
    }
  };

  const summary = useMemo(() => {
    const oldSale = savedRows.filter((r) => r.property_side === 'OLD' && r.item_type === 'SALE_CONSIDERATION').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const oldCost = savedRows
      .filter((r) => r.property_side === 'OLD' && r.item_type !== 'SALE_CONSIDERATION')
      .reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const oldGain = round2(oldSale - oldCost);
    const oldLoss = round2(Math.max(0, -oldGain));
    const oldLtcgBefore54 = round2(Math.max(0, oldGain));

    const newPurchase = savedRows
      .filter((r) => r.property_side === 'NEW')
      .reduce((s, r) => s + (Number(r.amount) || 0), 0);

    const section54Exemption = round2(Math.min(oldLtcgBefore54, Math.max(0, newPurchase)));
    const oldLtcgAfter54 = round2(Math.max(0, oldLtcgBefore54 - section54Exemption));

    const setoffAgainstLtcg112 = round2(Math.min(oldLoss, Math.max(0, Number(ltcg112) || 0) + oldLtcgAfter54));
    const carryForwardLtcl = round2(Math.max(0, oldLoss - setoffAgainstLtcg112));

    return {
      oldSale,
      oldCost,
      oldGain,
      oldLoss,
      oldLtcgBefore54,
      section54Exemption,
      oldLtcgAfter54,
      setoffAgainstLtcg112,
      carryForwardLtcl,
      newPurchase,
    };
  }, [savedRows, ltcg112]);

  const oldRows = rows.filter((r) => r.property_side === 'OLD');
  const newRows = rows.filter((r) => r.property_side === 'NEW');
  const hasDirtyChanges = useMemo(() => {
    if (rows.length !== savedRows.length) return true;
    const normalize = (row) => ({
      property_side: row.property_side,
      item_type: row.item_type,
      label: row.item_type === 'CUSTOM' ? (row.label || '') : (row.label || TYPE_LABEL[row.item_type] || row.item_type),
      amount: Number(row.amount) || 0,
      txn_date: row.txn_date || null,
      notes: row.notes || null,
    });
    return JSON.stringify(rows.map(normalize)) !== JSON.stringify(savedRows.map(normalize));
  }, [rows, savedRows]);

  const isExpanded = showHeader ? expanded : true;

  return (
    <Card className={`shadow-sm mb-3 property-main-section ${showHeader ? '' : 'property-embedded-section'}`.trim()}>
      {showHeader && (
        <CollapsibleSectionHeader
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          title="Property Capital Gains"
          className="d-flex align-items-center gap-2 mb-0 property-main-header"
          titleClassName="h6 fw-semibold mb-0"
          summary={`${rows.length} rows${savedRows.length ? ` · Saved ${savedRows.length}` : ''}`}
        />
      )}
      {isExpanded && (
      <Card.Body className="small pt-2 pb-3">
        {propertySignalUnknown && (
          <div className="alert alert-warning py-2 mb-2" role="alert">
            This AIS upload is in a legacy format without property section fields. Re-upload AIS to auto-detect property sale details.
          </div>
        )}
        <div className="d-flex flex-wrap gap-2 align-items-center justify-content-between mb-1">
          <div className="text-muted mb-0" style={{ lineHeight: 1.2 }}>
            Persisted helper for old/new property inputs. You can add custom line items and reuse across sessions.
          </div>
          <div className="d-flex gap-2">
            <Button size="sm" variant="outline-primary" onClick={() => handleAddCustom('OLD')}><Plus size={14} className="me-1" />Add Old Cost</Button>
            <Button size="sm" variant="outline-primary" onClick={() => handleAddCustom('NEW')}><Plus size={14} className="me-1" />Add New Cost</Button>
            {rows.length === 0 && (
              <Button size="sm" onClick={handleSeed} disabled={seeding}>
                {seeding ? <Spinner animation="border" size="sm" /> : 'Add Suggested Rows'}
              </Button>
            )}
            <Button size="sm" variant="success" onClick={handleSave} disabled={!hasDirtyChanges || saving || loading}>
              {saving ? <Spinner animation="border" size="sm" /> : 'Save'}
            </Button>
            <Button size="sm" variant="outline-secondary" onClick={handleReset} disabled={!hasDirtyChanges || saving || loading}>
              Reset
            </Button>
          </div>
        </div>

        <div className="d-flex align-items-center gap-2 mb-2">
          <Badge bg={hasDirtyChanges ? 'warning' : 'secondary'} text={hasDirtyChanges ? 'dark' : 'light'}>
            {hasDirtyChanges ? 'Unsaved changes' : 'Saved'}
          </Badge>
          {hasDirtyChanges && <span className="text-muted small">Changes are not included in tax computation until you save.</span>}
        </div>

        {error && <div className="text-danger mb-2">{error}</div>}
        {loading ? <Spinner animation="border" size="sm" /> : null}

        <RowTable
          title="Old Property (Sold)"
          rows={oldRows}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
        />

        <RowTable
          title="New Property (Purchased)"
          rows={newRows}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
        />

        <Card className="mt-3 border-0 bg-light">
          <Card.Body className="py-2">
            <div className="row g-2">
              <div className="col-12 col-lg-4">
                <div className="property-summary-title mb-1">Property Summary</div>
                <SummaryLine label="Old Property Sale" value={formatINR(summary.oldSale)} />
                <SummaryLine label="Old Property Total Cost" value={formatINR(summary.oldCost)} />
                <SummaryLine label="Estimated Old Property Gain/Loss" value={formatINR(summary.oldGain)} valueClass={summary.oldGain < 0 ? 'text-success' : 'text-danger'} />
                {summary.oldLtcgBefore54 > 0 && <SummaryLine label="Old Property LTCG (before Section 54)" value={formatINR(summary.oldLtcgBefore54)} />}
              </div>
              <div className="col-12 col-lg-4">
                <div className="property-summary-title mb-1">Section 54</div>
                <SummaryLine label="New Property Eligible Investment" value={formatINR(summary.newPurchase)} />
                <SummaryLine label="Estimated Section 54 Exemption" value={formatINR(summary.section54Exemption)} valueClass="text-success" />
                {summary.oldLtcgAfter54 > 0 && <SummaryLine label="Old Property LTCG after Section 54" value={formatINR(summary.oldLtcgAfter54)} />}
              </div>
              <div className="col-12 col-lg-4">
                <div className="property-summary-title mb-1">Setoff Check</div>
                <SummaryLine label="Current LTCG 112 (Foreign)" value={formatINR(ltcg112)} />
                <SummaryLine label="Estimated LTCL Setoff vs LTCG 112" value={formatINR(summary.setoffAgainstLtcg112)} />
                <SummaryLine label="Estimated Carry-forward LTCL" value={formatINR(summary.carryForwardLtcl)} />
              </div>
            </div>
          </Card.Body>
        </Card>
      </Card.Body>
      )}
    </Card>
  );
}

function RowTable({ title, rows, onUpdate, onDelete }) {
  const [editingId, setEditingId] = useState(null);

  return (
    <div className="mb-2">
      <div className="fw-semibold mb-1">{title} <Badge bg="secondary">{rows.length}</Badge></div>
      {rows.length === 0 ? <div className="text-muted small">No rows yet.</div> : (
        <div className="table-responsive">
          <Table size="sm" className="small property-rows-table mb-0">
            <thead className="table-light">
              <tr>
                <th style={{ width: '35%' }}>Item Type</th>
                <th style={{ width: '16%' }}>Date</th>
                <th style={{ width: '16%' }} className="text-end">Amount</th>
                <th style={{ width: '25%' }}>Notes</th>
                <th style={{ width: '8%' }} className="text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isEditing = editingId === r.id;
                const isCustom = r.item_type === 'CUSTOM';
                return (
                  <tr key={r.id}>
                    <td>
                      {isEditing ? (
                        <>
                          <Form.Select
                            size="sm"
                            value={r.item_type}
                            onChange={(e) => onUpdate(r.id, { item_type: e.target.value })}
                          >
                            {ITEM_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                          </Form.Select>
                          {isCustom ? (
                            <Form.Control
                              className="mt-1"
                              size="sm"
                              placeholder="Custom label"
                              value={r.label || ''}
                              onChange={(e) => onUpdate(r.id, { label: e.target.value })}
                            />
                          ) : null}
                        </>
                      ) : (
                        <span>{isCustom ? (r.label || 'Custom') : (TYPE_LABEL[r.item_type] || r.item_type)}</span>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <Form.Control
                          size="sm"
                          type="date"
                          value={r.txn_date || ''}
                          onChange={(e) => onUpdate(r.id, { txn_date: e.target.value || null })}
                        />
                      ) : (
                        <span>{r.txn_date || '-'}</span>
                      )}
                    </td>
                    <td className="text-end">
                      {isEditing ? (
                        <Form.Control
                          size="sm"
                          type="number"
                          value={r.amount ?? 0}
                          onChange={(e) => onUpdate(r.id, { amount: Number(e.target.value) || 0 })}
                        />
                      ) : (
                        <span className="fw-semibold">{formatINR(r.amount || 0)}</span>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <Form.Control
                          size="sm"
                          placeholder="Optional note"
                          value={r.notes || ''}
                          onChange={(e) => onUpdate(r.id, { notes: e.target.value })}
                        />
                      ) : (
                        <span className="text-muted">{r.notes || '-'}</span>
                      )}
                    </td>
                    <td className="text-end">
                      <Button
                        size="sm"
                        variant="link"
                        className="p-0 me-2 property-action-btn"
                        onClick={() => setEditingId((curr) => (curr === r.id ? null : r.id))}
                        title={isEditing ? 'Done' : 'Edit'}
                      >
                        {isEditing ? <Check size={14} /> : <Pencil size={14} />}
                      </Button>
                      <Button size="sm" variant="link" className="text-danger p-0 property-delete-btn" onClick={() => onDelete(r.id)} title="Delete">
                        <Trash2 size={14} />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}

function SummaryLine({ label, value, valueClass = '' }) {
  return (
    <div className="d-flex justify-content-between gap-2 py-1 property-summary-line">
      <span className="property-summary-label">{label}</span>
      <strong className={`property-summary-value ${valueClass}`.trim()}>{value}</strong>
    </div>
  );
}
