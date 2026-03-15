import React, { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Card, Table, Spinner, Form, Modal, Button } from 'react-bootstrap';
import { getTransactions, getBrokers, getInvestmentNames, updateTransaction, deleteTransaction } from '../services/api';
import { formatNumber, formatDate, ASSET_TYPE_LABELS } from '../utils/formatters';
import { usePortfolio } from '../context/PortfolioContext';

const TRANSACTION_TYPES = [
  'BUY', 'SELL', 'DIVIDEND', 'BONUS', 'IPO', 'AMC',
];

// User-action types that can be edited/deleted (not corporate actions)
const EDITABLE_TYPES = ['BUY', 'SELL', 'IPO', 'AMC', 'DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT'];

const TYPE_BADGE = {
  BUY: 'badge-buy',
  DEPOSIT: 'badge-deposit',
  IPO: 'badge-ipo',
  TRANSFER_IN: 'badge-buy',
  BONUS: 'badge-bonus',
  RIGHTS: 'badge-bonus',
  SPLIT: 'badge-split',
  DIVIDEND: 'badge-dividend',
  INTEREST: 'badge-interest',
  MERGER: 'badge-merger',
  CONSOLIDATION: 'badge-merger',
  SELL: 'badge-sell',
  WITHDRAWAL: 'badge-withdrawal',
  TRANSFER_OUT: 'badge-sell',
  AMC: 'badge-withdrawal',
};

export default function Transactions() {
  const { selectedId } = usePortfolio();
  const [transactions, setTransactions] = useState([]);
  const [brokers, setBrokers] = useState([]);
  const [investmentNames, setInvestmentNames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState([]);
  const [filterBroker, setFilterBroker] = useState('');
  const [filterInvestment, setFilterInvestment] = useState('');
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const typeDropdownRef = useRef(null);

  // Edit/Delete state
  const [editTxn, setEditTxn] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteText, setDeleteText] = useState('');

  // Compute which fields changed in edit form
  const getChanges = () => {
    if (!editTxn) return [];
    const changes = [];
    if (editForm.transaction_date !== editTxn.transaction_date) changes.push('Date');
    if (String(editForm.units || '') !== String(editTxn.units || '')) changes.push('Units');
    if (String(editForm.price_per_unit || '') !== String(editTxn.price_per_unit || '')) changes.push('Price/Unit');
    if (String(editForm.amount || '') !== String(editTxn.amount || '')) changes.push('Amount');
    if (String(editForm.fees || '') !== String(editTxn.fees || '')) changes.push('Charges');
    if ((editForm.notes || '') !== (editTxn.notes || '')) changes.push('Notes');
    return changes;
  };
  const editChanges = getChanges();
  const hasChanges = editChanges.length > 0;

  const handleEdit = (txn) => {
    setEditTxn(txn);
    setEditForm({
      transaction_date: txn.transaction_date,
      units: txn.units || '',
      price_per_unit: txn.price_per_unit || '',
      amount: txn.amount || '',
      fees: txn.fees || '',
      notes: txn.notes || '',
    });
  };

  const handleEditSave = async () => {
    try {
      setSaving(true);
      await updateTransaction(editTxn.id, {
        transaction_date: editForm.transaction_date,
        units: editForm.units ? Number(editForm.units) : null,
        price_per_unit: editForm.price_per_unit ? Number(editForm.price_per_unit) : null,
        amount: Number(editForm.amount),
        fees: editForm.fees ? Number(editForm.fees) : 0,
        notes: editForm.notes || null,
      });
      setEditTxn(null);
      loadTransactions();
    } catch (e) {
      alert('Failed to update: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteTransaction(id);
      setDeleteConfirm(null);
      loadTransactions();
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  };

  useEffect(() => {
    getBrokers().then(setBrokers).catch(() => {});
  }, []);

  // Close type dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (typeDropdownRef.current && !typeDropdownRef.current.contains(e.target)) {
        setTypeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    const params = selectedId ? { portfolio_id: selectedId } : {};
    getInvestmentNames(params).then(setInvestmentNames).catch(() => {});
    setFilterInvestment('');
  }, [selectedId]);

  useEffect(() => {
    loadTransactions();
  }, [selectedId, filterType, filterBroker, filterInvestment]);

  const loadTransactions = async () => {
    try {
      setLoading(true);
      const params = {};
      if (selectedId) params.portfolio_id = selectedId;
      if (filterType.length) params.type = filterType.join(',');
      if (filterBroker) params.broker = filterBroker;
      if (filterInvestment) params.investment_name = filterInvestment;
      const result = await getTransactions(params);
      setTransactions(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const typeCounts = transactions.reduce((acc, t) => {
    acc[t.transaction_type] = (acc[t.transaction_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="d-flex flex-column gap-3">
      <h1 className="h4 fw-bold">Transactions</h1>

      {/* Filter bar */}
      <div className="d-flex flex-wrap align-items-center gap-3">
        <div className="d-flex align-items-center gap-2 position-relative" ref={typeDropdownRef}>
          <label className="small fw-semibold text-muted text-uppercase">Type</label>
          <button
            onClick={() => setTypeDropdownOpen(!typeDropdownOpen)}
            className="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1"
            style={{ minWidth: 120 }}
          >
            {filterType.length === 0 ? (
              <span>All Types</span>
            ) : (
              <span className="d-flex flex-wrap gap-1">
                {filterType.map(t => (
                  <span key={t} className={`badge ${TYPE_BADGE[t] || 'bg-secondary'} d-inline-flex align-items-center`}>
                    {t.replace(/_/g, ' ')}
                    <button
                      onClick={(e) => { e.stopPropagation(); setFilterType(filterType.filter(x => x !== t)); }}
                      className="btn-close btn-close-white ms-1"
                      style={{ fontSize: '0.5rem' }}
                    />
                  </span>
                ))}
              </span>
            )}
            <svg className="ms-auto flex-shrink-0" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {typeDropdownOpen && (
            <div className="position-absolute top-100 start-0 mt-1 bg-white border rounded shadow-lg py-1" style={{ zIndex: 20, minWidth: 160 }}>
              {TRANSACTION_TYPES.map(t => {
                const selected = filterType.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => {
                      setFilterType(selected ? filterType.filter(x => x !== t) : [...filterType, t]);
                    }}
                    className={`d-flex align-items-center gap-2 w-100 text-start px-3 py-1 small border-0 bg-transparent ${selected ? 'fw-semibold' : ''}`}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8f9fa'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    <span
                      className="d-inline-flex align-items-center justify-content-center rounded border"
                      style={{
                        width: 16, height: 16, fontSize: '0.65rem',
                        ...(selected ? { backgroundColor: '#0d6efd', borderColor: '#0d6efd', color: '#fff' } : { borderColor: '#dee2e6' })
                      }}
                    >
                      {selected && '✓'}
                    </span>
                    <span className={`badge ${TYPE_BADGE[t] || 'bg-secondary'}`}>
                      {t.replace(/_/g, ' ')}
                    </span>
                  </button>
                );
              })}
              {filterType.length > 0 && (
                <>
                  <hr className="my-1" />
                  <button
                    onClick={() => { setFilterType([]); setTypeDropdownOpen(false); }}
                    className="w-100 text-start px-3 py-1 small text-muted border-0 bg-transparent"
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8f9fa'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    Clear selection
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="d-flex align-items-center gap-2">
          <label className="small fw-semibold text-muted text-uppercase">Investment</label>
          <Form.Select
            size="sm"
            value={filterInvestment}
            onChange={(e) => setFilterInvestment(e.target.value)}
            style={{ maxWidth: 220 }}
          >
            <option value="">All Investments</option>
            {investmentNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </Form.Select>
        </div>

        {brokers.length > 0 && (
          <div className="d-flex align-items-center gap-2">
            <label className="small fw-semibold text-muted text-uppercase">Broker</label>
            <Form.Select
              size="sm"
              value={filterBroker}
              onChange={(e) => setFilterBroker(e.target.value)}
              style={{ width: 'auto' }}
            >
              <option value="">All Brokers</option>
              {brokers.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </Form.Select>
          </div>
        )}

        {(filterType.length > 0 || filterBroker || filterInvestment) && (
          <button
            onClick={() => { setFilterType([]); setFilterBroker(''); setFilterInvestment(''); }}
            className="btn btn-link btn-sm text-muted text-decoration-underline p-0"
          >
            Clear filters
          </button>
        )}

        <span className="ms-auto d-flex align-items-center gap-2 small text-muted">
          {transactions.length} transaction{transactions.length !== 1 ? 's' : ''}
          <button
            onClick={loadTransactions}
            disabled={loading}
            className="btn btn-outline-secondary btn-sm d-inline-flex align-items-center justify-content-center p-0"
            style={{ width: 28, height: 28 }}
            title="Refresh transactions"
          >
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"
              className={loading ? 'spin' : ''}
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h5M20 20v-5h-5M4.93 9a8 8 0 0113.14-2.07L20 9M19.07 15a8 8 0 01-13.14 2.07L4 15"
              />
            </svg>
          </button>
        </span>
      </div>

      <Card className="shadow-sm">
        {loading ? (
          <div className="d-flex justify-content-center py-5">
            <Spinner animation="border" variant="primary" />
          </div>
        ) : transactions.length === 0 ? (
          <div className="p-5 text-center text-muted">
            <p>No transactions found.</p>
            {(filterType.length > 0 || filterBroker || filterInvestment) ? (
              <button onClick={() => { setFilterType([]); setFilterBroker(''); setFilterInvestment(''); }}
                className="btn btn-link text-primary mt-2">
                Clear filters
              </button>
            ) : (
              <Link to="/investments/add" className="btn btn-link text-primary mt-2">
                Add your first investment
              </Link>
            )}
          </div>
        ) : (
          <div className="responsive-table">
            <Table hover size="sm" className="mb-0 small">
              <thead className="table-light">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Investment</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2 text-end">Units</th>
                  <th className="px-3 py-2 text-end">Price/Unit</th>
                  <th className="px-3 py-2 text-end">Amount</th>
                  <th className="px-3 py-2 text-end">Charges</th>
                  <th className="px-3 py-2">Broker</th>
                  <th className="px-3 py-2">Notes</th>
                  <th className="px-3 py-2 text-center" style={{ width: 80 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((txn) => (
                  <tr key={txn.id}>
                    <td className="px-3 py-2 text-nowrap">{formatDate(txn.transaction_date)}</td>
                    <td className="px-3 py-2">
                      <Link to={`/investments/${txn.investment_id}`} className="text-primary fw-medium text-decoration-none">
                        {txn.investment_name}
                      </Link>
                      <div className="d-flex align-items-center gap-2 mt-1">
                        <span className="text-muted" style={{ fontSize: '0.75rem' }}>{ASSET_TYPE_LABELS[txn.asset_type]}</span>
                        {!selectedId && txn.portfolio_name && (
                          <span className="badge bg-light text-dark" style={{ fontSize: '0.7rem' }}>
                            {txn.portfolio_name}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`badge ${TYPE_BADGE[txn.transaction_type] || 'bg-secondary'}`}>
                        {txn.transaction_type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-end">{txn.units ? formatNumber(txn.units, 3) : '-'}</td>
                    <td className="px-3 py-2 text-end">{txn.price_per_unit ? `₹${formatNumber(txn.price_per_unit, 2)}` : '-'}</td>
                    <td className="px-3 py-2 text-end fw-medium">₹{formatNumber(txn.amount, 2)}</td>
                    <td className="px-3 py-2 text-end text-muted">{txn.fees ? `₹${formatNumber(txn.fees, 2)}` : '-'}</td>
                    <td className="px-3 py-2 text-muted" style={{ fontSize: '0.75rem' }}>{txn.broker || '-'}</td>
                    <td className="px-3 py-2 text-muted text-truncate" style={{ maxWidth: 150 }} title={txn.notes || ''}>{txn.notes || '-'}</td>
                    <td className="px-3 py-2 text-center">
                      {EDITABLE_TYPES.includes(txn.transaction_type) && (
                        <div className="d-flex justify-content-center gap-1 row-actions">
                          <button
                            className="btn btn-link btn-sm p-0 text-primary"
                            title="Edit"
                            onClick={() => handleEdit(txn)}
                          >
                            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button
                            className="btn btn-link btn-sm p-0 text-danger"
                            title="Delete"
                            onClick={() => { setDeleteConfirm(txn); setDeleteText(''); }}
                          >
                            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      {/* Edit Modal */}
      <Modal show={!!editTxn} onHide={() => setEditTxn(null)} centered>
        <Modal.Header closeButton>
          <Modal.Title className="h6">
            Edit {editTxn?.transaction_type?.replace(/_/g, ' ')} — {editTxn?.investment_name}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {editTxn && (
            <div className="d-flex flex-column gap-3">
              <Form.Group>
                <Form.Label className="small fw-semibold">Date</Form.Label>
                <Form.Control
                  type="date"
                  size="sm"
                  value={editForm.transaction_date || ''}
                  onChange={(e) => setEditForm({ ...editForm, transaction_date: e.target.value })}
                />
              </Form.Group>
              {editTxn.transaction_type !== 'AMC' && (
                <>
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
                </>
              )}
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
          Are you sure you want to delete this <strong>{deleteConfirm?.transaction_type}</strong> transaction
          for <strong>{deleteConfirm?.investment_name}</strong> on <strong>{formatDate(deleteConfirm?.transaction_date)}</strong>
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
          <Button variant="danger" size="sm" onClick={() => handleDelete(deleteConfirm.id)} disabled={deleteText !== 'DELETE'}>Delete</Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}
