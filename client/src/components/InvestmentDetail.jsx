import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { Card, Row, Col, Table, Button, Form, Spinner, Badge, Modal } from 'react-bootstrap';
import { getInvestment, deleteInvestment, addTransaction, deleteTransaction, updateTransaction } from '../services/api';
import { formatINR, formatNumber, formatPct, formatDate, profitColor, ASSET_TYPE_LABELS } from '../utils/formatters';
import { ArrowLeft, Trash2, Plus, X, Settings, Pencil } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

const UNIT_ADD_TYPES = ['BUY', 'IPO', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION'];
const UNIT_SUB_TYPES = ['SELL', 'TRANSFER_OUT', 'SWITCH_OUT', 'WITHDRAWAL', 'CONSOLIDATION', 'CHARGES'];
const EDITABLE_TYPES = ['BUY', 'SELL', 'IPO', 'AMC', 'DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION'];
const TYPE_LABELS = { EMPLOYER_CONTRIBUTION: 'EMPLOYER', VOLUNTARY_CONTRIBUTION: 'VOLUNTARY' };

export default function InvestmentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedId } = usePortfolio();
  const cameFrom = location.state?.from;
  const transactionsSearch = location.state?.transactionsSearch || '';
  const investmentsSearch = location.state?.investmentsSearch || '';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAddTxn, setShowAddTxn] = useState(false);
  const [txnForm, setTxnForm] = useState({
    transaction_type: 'BUY',
    transaction_date: new Date().toISOString().split('T')[0],
    units: '',
    price_per_unit: '',
    amount: '',
    fees: '0',
    notes: '',
  });

  useEffect(() => { loadData(); }, [id, selectedId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const result = await getInvestment(id, selectedId);
      setData(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this investment and all its data?')) return;
    await deleteInvestment(id);
    navigate(`/investments${investmentsSearch ? `?${investmentsSearch}` : ''}`);
  };

  const handleAddTransaction = async (e) => {
    e.preventDefault();
    try {
      let amount = parseFloat(txnForm.amount);
      if (!amount && txnForm.units && txnForm.price_per_unit) {
        amount = parseFloat(txnForm.units) * parseFloat(txnForm.price_per_unit);
      }

      await addTransaction({
        investment_id: parseInt(id),
        portfolio_id: selectedId || null,
        transaction_type: txnForm.transaction_type,
        transaction_date: txnForm.transaction_date,
        units: txnForm.units ? parseFloat(txnForm.units) : null,
        price_per_unit: txnForm.price_per_unit ? parseFloat(txnForm.price_per_unit) : null,
        amount,
        fees: parseFloat(txnForm.fees) || 0,
        notes: txnForm.notes || null,
      });
      setShowAddTxn(false);
      setTxnForm({
        transaction_type: 'BUY', transaction_date: new Date().toISOString().split('T')[0],
        units: '', price_per_unit: '', amount: '', fees: '0', notes: '',
      });
      loadData();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  // Edit modal state
  const [editTxn, setEditTxn] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);

  // Delete confirmation modal state
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteText, setDeleteText] = useState('');

  const getChanges = () => {
    if (!editTxn) return [];
    const changes = [];
    if ((editForm.folio_number || '') !== (editTxn.folio_number || '')) changes.push('Folio');
    if (editForm.transaction_date !== editTxn.transaction_date) changes.push('Date');
    if (String(editForm.units || '') !== String(editTxn.units || '')) changes.push('Units');
    if (String(editForm.price_per_unit || '') !== String(editTxn.price_per_unit || '')) changes.push('Price/Unit');
    if (String(editForm.amount || '') !== String(editTxn.amount || '')) changes.push('Amount');
    if (String(editForm.fees || '') !== String(editTxn.fees || '')) changes.push('Charges');
    if ((editForm.broker || '') !== (editTxn.broker || '')) changes.push('Broker');
    if ((editForm.notes || '') !== (editTxn.notes || '')) changes.push('Notes');
    return changes;
  };
  const editChanges = getChanges();
  const hasChanges = editChanges.length > 0;

  const handleEditTxn = (txn) => {
    setEditTxn(txn);
    setEditForm({
      folio_number: txn.folio_number || '',
      transaction_date: txn.transaction_date,
      units: txn.units || '',
      price_per_unit: txn.price_per_unit || '',
      amount: txn.amount || '',
      fees: txn.fees || '',
      broker: txn.broker || '',
      notes: txn.notes || '',
    });
  };

  const handleEditSave = async () => {
    try {
      setSaving(true);
      await updateTransaction(editTxn.id, {
        folio_number: editForm.folio_number || null,
        transaction_date: editForm.transaction_date,
        units: editForm.units ? Number(editForm.units) : null,
        price_per_unit: editForm.price_per_unit ? Number(editForm.price_per_unit) : null,
        amount: Number(editForm.amount),
        fees: editForm.fees ? Number(editForm.fees) : 0,
        broker: editForm.broker || null,
        notes: editForm.notes || null,
      });
      setEditTxn(null);
      loadData();
    } catch (e) {
      alert('Failed to update: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTxn = async (id) => {
    try {
      await deleteTransaction(id);
      setDeleteConfirm(null);
      loadData();
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  };

  const updateTxnField = (field, value) => {
    const updated = { ...txnForm, [field]: value };
    if ((field === 'units' || field === 'price_per_unit') && updated.units && updated.price_per_unit) {
      updated.amount = (parseFloat(updated.units) * parseFloat(updated.price_per_unit)).toFixed(2);
    }
    setTxnForm(updated);
  };

  if (loading) return <div className="d-flex justify-content-center py-5"><Spinner animation="border" variant="primary" /></div>;
  if (!data) return <div className="text-danger">Investment not found</div>;

  const isPPF = data.asset_type === 'PPF' || data.asset_type === 'SSY' || data.asset_type === 'PF';
  const isBond = data.asset_type === 'BOND';
  const isNPS = data.asset_type === 'NPS';
  const txnTypes = isPPF
    ? ['DEPOSIT', 'WITHDRAWAL', 'INTEREST']
    : isBond
    ? ['BUY', 'SELL', 'INTEREST']
    : ['BUY', 'SELL', 'DIVIDEND'];

  return (
    <div>
      {/* Header */}
      <div className="d-flex flex-column flex-sm-row justify-content-between align-items-start gap-3 mb-4">
        <div>
          <Link to={cameFrom === 'transactions' ? `/transactions${transactionsSearch}` : `/investments${investmentsSearch ? `?${investmentsSearch}` : ''}`} className="small text-muted text-decoration-none d-flex align-items-center gap-1 mb-2">
            <ArrowLeft size={16} /> Back to {cameFrom === 'transactions' ? 'Transactions' : 'Investments'}
          </Link>
          <h1 className="h4 fw-bold mb-1">{data.display_name || data.name}</h1>
          <div className="d-flex align-items-center gap-2">
            <Badge bg="primary" className="bg-opacity-10 text-primary">{ASSET_TYPE_LABELS[data.asset_type]}</Badge>
            {data.is_active === 0 && <Badge bg="secondary">Inactive</Badge>}
          </div>
        </div>
        <div className="d-flex gap-2">
          <Button variant="primary" size="sm" onClick={() => setShowAddTxn(true)} className="d-flex align-items-center gap-1">
            <Plus size={16} /> Add Transaction
          </Button>
          <Link to={`/investments/${id}/settings`} state={{ from: cameFrom, transactionsSearch, investmentsSearch }} className="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1">
            <Settings size={16} /> Settings
          </Link>
          <Button variant="outline-danger" size="sm" onClick={handleDelete} className="d-flex align-items-center gap-1">
            <Trash2 size={16} /> Delete
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <Row className="g-3 mb-4">
        <Col xs={6} md={3}><SummaryCard label="Total Invested" value={formatINR(data.totalInvested)} /></Col>
        <Col xs={6} md={3}><SummaryCard label="Current Value" value={formatINR(data.latestValue?.current_value)} /></Col>
        <Col xs={6} md={3}>
          <SummaryCard
            label="Profit/Loss"
            value={`${data.latestValue?.profit_loss >= 0 ? '+' : ''}${formatINR(data.latestValue?.profit_loss)}`}
            color={profitColor(data.latestValue?.profit_loss)}
          />
        </Col>
        <Col xs={6} md={3}>
          <SummaryCard
            label="Return %"
            value={formatPct(data.latestValue?.profit_loss_pct)}
            color={profitColor(data.latestValue?.profit_loss_pct)}
          />
        </Col>
      </Row>

      {/* Details */}
      <Card className="shadow-sm mb-4">
        <Card.Body>
          <h2 className="h6 fw-semibold mb-3">Details</h2>
          <Row className="g-3 small">
            {data.ticker_symbol && <Col xs={6} md={3}><Detail label="Ticker" value={data.ticker_symbol} /></Col>}
            {data.isin_code && <Col xs={6} md={3}><Detail label="ISIN" value={data.isin_code} /></Col>}
            {data.amfi_code && <Col xs={6} md={3}><Detail label="AMFI Code" value={data.amfi_code} /></Col>}
            {data.category && <Col xs={6} md={3}><Detail label="Category" value={data.category} /></Col>}
            {!isPPF && <Col xs={6} md={3}><Detail label="Total Units" value={formatNumber(data.totalUnits, 4)} /></Col>}
            {data.latestValue && <Col xs={6} md={3}><Detail label="Last Price" value={`₹${formatNumber(data.latestValue.price_per_unit, 2)}`} /></Col>}
            {data.latestValue && <Col xs={6} md={3}><Detail label="1 Day Change" value={formatNumber(data.latestValue.day_change, 0)} color={profitColor(data.latestValue.day_change)} /></Col>}
            <Col xs={6} md={3}><Detail label="Currency" value={data.currency} /></Col>
          </Row>
        </Card.Body>
      </Card>

      {/* Add Transaction Form */}
      {showAddTxn && (
        <Card className="shadow-sm mb-4 border-primary">
          <Card.Body>
            <div className="d-flex justify-content-between align-items-center mb-3">
              <h2 className="h6 fw-semibold mb-0">Add Transaction</h2>
              <button onClick={() => setShowAddTxn(false)} className="btn-close" />
            </div>
            <Form onSubmit={handleAddTransaction}>
              <Row className="g-3">
                <Col md={4}>
                  <Form.Label className="small">Type</Form.Label>
                  <Form.Select size="sm" value={txnForm.transaction_type} onChange={(e) => updateTxnField('transaction_type', e.target.value)}>
                    {txnTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Form.Select>
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Date</Form.Label>
                  <Form.Control size="sm" type="date" value={txnForm.transaction_date} onChange={(e) => updateTxnField('transaction_date', e.target.value)} required />
                </Col>
                {!isPPF && (
                  <>
                    <Col md={4}>
                      <Form.Label className="small">Units</Form.Label>
                      <Form.Control size="sm" type="number" step="0.001" value={txnForm.units} onChange={(e) => updateTxnField('units', e.target.value)} placeholder="Number of units" />
                    </Col>
                    <Col md={4}>
                      <Form.Label className="small">Price per Unit</Form.Label>
                      <Form.Control size="sm" type="number" step="0.01" value={txnForm.price_per_unit} onChange={(e) => updateTxnField('price_per_unit', e.target.value)} placeholder="Price per unit" />
                    </Col>
                  </>
                )}
                <Col md={4}>
                  <Form.Label className="small">Amount (₹)</Form.Label>
                  <Form.Control size="sm" type="number" step="0.01" value={txnForm.amount} onChange={(e) => updateTxnField('amount', e.target.value)} placeholder="Total amount" required />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Charges (₹)</Form.Label>
                  <Form.Control size="sm" type="number" step="0.01" value={txnForm.fees} onChange={(e) => updateTxnField('fees', e.target.value)} />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Notes</Form.Label>
                  <Form.Control size="sm" type="text" value={txnForm.notes} onChange={(e) => updateTxnField('notes', e.target.value)} placeholder="Optional" />
                </Col>
                <Col xs={12}>
                  <Button type="submit" variant="primary" size="sm">Add Transaction</Button>
                </Col>
              </Row>
            </Form>
          </Card.Body>
        </Card>
      )}

      {/* Transactions Table */}
      <Card className="shadow-sm">
        <Card.Header className="bg-white">
          <h2 className="h6 fw-semibold mb-0">Transactions ({data.transactions.length})</h2>
        </Card.Header>
        {data.transactions.length === 0 ? (
          <Card.Body className="text-center text-muted py-4">
            No transactions recorded yet. Add your first transaction above.
          </Card.Body>
        ) : (
          <div className="responsive-table">
            <Table hover size="sm" className="mb-0 small">
              <thead className="table-light">
                <tr>
                  <th className="px-3">Date</th>
                  <th className="px-3">Type</th>
                  <th className="px-3 text-end">Units</th>
                  <th className="px-3 text-end">Price/Unit</th>
                  <th className="px-3 text-end">Amount</th>
                  <th className="px-3 text-end">Charges</th>
                  <th className="px-3 text-end">Holding</th>
                  {data.transactions.some(t => t.folio_number) && <th className="px-3">Folio</th>}
                  {!isNPS && <th className="px-3">Broker</th>}
                  <th className="px-3" style={isNPS ? {} : { width: 150 }}>Notes</th>
                  <th className="px-3 text-center" style={{ width: 80 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // Compute running holding from oldest to newest
                  // Corporate actions come before regular trades on the same date
                  const CORPORATE_TYPES = new Set(['SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'DIVIDEND', 'INTEREST']);
                  const txnSortKey = (t) => CORPORATE_TYPES.has(t.transaction_type) ? 0 : 1;
                  const sorted = [...data.transactions].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || txnSortKey(a) - txnSortKey(b) || a.id - b.id);
                  const holdingMap = {};
                  let balance = 0;
                  for (const txn of sorted) {
                    if (UNIT_ADD_TYPES.includes(txn.transaction_type)) balance += txn.units || 0;
                    else if (UNIT_SUB_TYPES.includes(txn.transaction_type)) balance -= txn.units || 0;
                    if (Math.abs(balance) < 1e-6) balance = 0;
                    holdingMap[txn.id] = balance;
                  }
                  const hasFolio = data.transactions.some(t => t.folio_number);
                  return [...sorted].reverse().map((txn) => (
                  <tr key={txn.id}>
                    <td className="px-3">{formatDate(txn.transaction_date)}</td>
                    <td className="px-3">
                      <span className={`badge rounded-pill badge-${txn.transaction_type.toLowerCase()}`}>
                        {TYPE_LABELS[txn.transaction_type] || txn.transaction_type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-3 text-end">{txn.units ? formatNumber(txn.units, 4) : '-'}</td>
                    <td className="px-3 text-end">{txn.price_per_unit ? `₹${formatNumber(txn.price_per_unit, 2)}` : '-'}</td>
                    <td className="px-3 text-end fw-medium">₹{formatNumber(txn.amount, 2)}</td>
                    <td className="px-3 text-end">{txn.fees > 0 ? `₹${formatNumber(txn.fees, 2)}` : '-'}</td>
                    <td className="px-3 text-end">{holdingMap[txn.id] != null ? formatNumber(holdingMap[txn.id], 4) : '-'}</td>
                    {hasFolio && <td className="px-3 text-muted" style={{ fontSize: '0.8rem' }}>{txn.folio_number || '-'}</td>}
                    {!isNPS && <td className="px-3 text-muted" style={{ fontSize: '0.8rem' }}>{txn.broker || '-'}</td>}
                    <td className="px-3 text-muted" style={isNPS ? {} : { maxWidth: 150, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={txn.notes || ''}>{txn.notes || '-'}</td>
                    <td className="px-3">
                      {EDITABLE_TYPES.includes(txn.transaction_type) && (
                        <div className="d-flex gap-1 row-actions">
                          <button onClick={() => handleEditTxn(txn)} className="btn btn-link btn-sm p-0 text-primary" title="Edit">
                            <Pencil size={14} />
                          </button>
                          <button onClick={() => { setDeleteConfirm(txn); setDeleteText(''); }} className="btn btn-link btn-sm p-0 text-danger" title="Delete">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  ));
                })()}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      {/* Edit Transaction Modal */}
      <Modal show={!!editTxn} onHide={() => setEditTxn(null)} centered size="lg">
        <Modal.Header closeButton>
          <Modal.Title className="h6">
            Edit {editTxn?.transaction_type?.replace(/_/g, ' ')} — {formatDate(editTxn?.transaction_date)}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {editTxn && (
            <div className="d-flex flex-column gap-3">
              <Row className="g-3">
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Folio</Form.Label>
                    <Form.Control
                      type="text"
                      size="sm"
                      value={editForm.folio_number}
                      onChange={(e) => setEditForm({ ...editForm, folio_number: e.target.value })}
                    />
                  </Form.Group>
                </Col>
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Date</Form.Label>
                    <Form.Control
                      type="date"
                      size="sm"
                      value={editForm.transaction_date || ''}
                      onChange={(e) => setEditForm({ ...editForm, transaction_date: e.target.value })}
                    />
                  </Form.Group>
                </Col>
              </Row>
              {editTxn.transaction_type !== 'AMC' && (
                <Row className="g-3">
                  <Col sm={6}>
                    <Form.Group>
                      <Form.Label className="small fw-semibold">Units</Form.Label>
                      <Form.Control
                        type="number"
                        size="sm"
                        step="any"
                        value={editForm.units}
                        onChange={(e) => setEditForm({ ...editForm, units: e.target.value })}
                      />
                    </Form.Group>
                  </Col>
                  <Col sm={6}>
                    <Form.Group>
                      <Form.Label className="small fw-semibold">Price/Unit</Form.Label>
                      <Form.Control
                        type="number"
                        size="sm"
                        step="any"
                        value={editForm.price_per_unit}
                        onChange={(e) => setEditForm({ ...editForm, price_per_unit: e.target.value })}
                      />
                    </Form.Group>
                  </Col>
                </Row>
              )}
              <Row className="g-3">
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Amount</Form.Label>
                    <Form.Control
                      type="number"
                      size="sm"
                      step="any"
                      value={editForm.amount}
                      onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                    />
                  </Form.Group>
                </Col>
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Charges</Form.Label>
                    <Form.Control
                      type="number"
                      size="sm"
                      step="any"
                      value={editForm.fees}
                      onChange={(e) => setEditForm({ ...editForm, fees: e.target.value })}
                    />
                  </Form.Group>
                </Col>
              </Row>
              <Row className="g-3">
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Broker</Form.Label>
                    <Form.Control
                      type="text"
                      size="sm"
                      value={editForm.broker}
                      onChange={(e) => setEditForm({ ...editForm, broker: e.target.value })}
                    />
                  </Form.Group>
                </Col>
              </Row>
              <Form.Group>
                <Form.Label className="small fw-semibold">Notes</Form.Label>
                <Form.Control
                  as="textarea"
                  size="sm"
                  rows={2}
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                />
              </Form.Group>
            </div>
          )}
        </Modal.Body>
        {hasChanges && (
          <div className="px-3 pb-2">
            <div className="small text-muted bg-light rounded p-2">
              <strong>Changes:</strong> {editChanges.join(', ')}
            </div>
          </div>
        )}
        <Modal.Footer>
          <Button variant="secondary" size="sm" onClick={() => setEditTxn(null)}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleEditSave} disabled={saving || !hasChanges}>
            {saving ? 'Saving...' : hasChanges ? 'Save Changes' : 'No Changes'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal show={!!deleteConfirm} onHide={() => setDeleteConfirm(null)} centered size="sm">
        <Modal.Header closeButton>
          <Modal.Title className="h6">Delete Transaction</Modal.Title>
        </Modal.Header>
        <Modal.Body className="small">
          Are you sure you want to delete this <strong>{deleteConfirm?.transaction_type?.replace(/_/g, ' ')}</strong> transaction
          on <strong>{formatDate(deleteConfirm?.transaction_date)}</strong>
          {deleteConfirm?.amount ? <> for <strong>₹{formatNumber(deleteConfirm.amount, 2)}</strong></> : null}?
          <div className="mt-3">
            <Form.Label className="small fw-semibold">Type <span className="text-danger">DELETE</span> to confirm</Form.Label>
            <Form.Control
              size="sm"
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              placeholder="Type DELETE"
              autoFocus
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" size="sm" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={() => handleDeleteTxn(deleteConfirm.id)} disabled={deleteText !== 'DELETE'}>Delete</Button>
        </Modal.Footer>
      </Modal>
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

function Detail({ label, value, color = '' }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className={`fw-medium ${color}`}>{value}</div>
    </div>
  );
}
