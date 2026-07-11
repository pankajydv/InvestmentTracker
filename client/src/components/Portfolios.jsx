import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, Form, Button, Modal, Row, Col, Spinner, Alert, Nav, Table } from 'react-bootstrap';
import { getPortfolios, updatePortfolio, deletePortfolio, createPortfolio, getExpenses, getExpensesSummary, addAmcCharge, deleteExpense } from '../services/api';
import { formatINR, formatDate, profitColor } from '../utils/formatters';
import { usePortfolio } from '../context/PortfolioContext';
import { resolvePortfolioColor } from '../utils/portfolioColors';
import { Users, Pencil, Trash2, Plus, Check, X, Receipt } from 'lucide-react';

const COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

const EXPENSE_TYPE_LABELS = {
  AMC: 'AMC / Maintenance',
  PLATFORM_FEE: 'Platform Fee',
  CDSL: 'CDSL / Depository',
  ACCOUNT_OPENING: 'Account Opening',
  OTHER: 'Other',
};
const EXPENSE_TYPES = Object.keys(EXPENSE_TYPE_LABELS);

export default function Portfolios() {
  const { refreshPortfolios, portfolios: ctxPortfolios, selectedId, selectedIds, selectedPortfolio } = usePortfolio();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('tab') || 'members');
  const [portfolios, setPortfolios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Portfolio edit state
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', pan_number: '', email: '', color: '' });

  // Portfolio add state
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', pan_number: '', email: '', color: '#3b82f6' });
  const [saving, setSaving] = useState(false);

  // Portfolio delete state
  const [deleteTarget, setDeleteTarget] = useState(null);

  // Charges state
  const [expenses, setExpenses] = useState([]);
  const [summary, setSummary] = useState(null);
  const [chargesLoading, setChargesLoading] = useState(false);
  const [filterType, setFilterType] = useState('');
  const [showAddCharge, setShowAddCharge] = useState(false);
  const [chargeForm, setChargeForm] = useState({ portfolio_id: '', expense_type: 'AMC', expense_date: '', amount: '', broker: '', notes: '' });
  const [chargeSaving, setChargeSaving] = useState(false);
  const [deleteChargeId, setDeleteChargeId] = useState(null);

  useEffect(() => { loadPortfolios(); }, []);

  useEffect(() => {
    if (tab === 'charges') loadCharges();
  }, [tab, filterType, selectedId, selectedIds]);

  useEffect(() => {
    if (!selectedId) return;
    setChargeForm(prev => ({ ...prev, portfolio_id: String(selectedId) }));
  }, [selectedId]);

  const switchTab = (t) => {
    setTab(t);
    setSearchParams(t === 'members' ? {} : { tab: t });
  };

  const loadPortfolios = async () => {
    try {
      setLoading(true);
      const data = await getPortfolios();
      setPortfolios(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadCharges = async () => {
    try {
      setChargesLoading(true);
      const params = {};
      if (filterType) params.expense_type = filterType;

      if (selectedIds.length > 1) {
        const responses = await Promise.all(
          selectedIds.map((id) => Promise.all([
            getExpenses({ ...params, portfolio_id: id }),
            getExpensesSummary(id),
          ]))
        );

        const mergedExpenses = responses
          .flatMap(([list]) => list)
          .sort((a, b) => String(b.expense_date || '').localeCompare(String(a.expense_date || '')));

        const summaryByType = {};
        let totalExpenses = 0;
        for (const [, sum] of responses) {
          totalExpenses += Number(sum?.total_expenses) || 0;
          for (const row of sum?.byType || []) {
            if (!summaryByType[row.expense_type]) {
              summaryByType[row.expense_type] = {
                expense_type: row.expense_type,
                total: 0,
                count: 0,
              };
            }
            summaryByType[row.expense_type].total += Number(row.total) || 0;
            summaryByType[row.expense_type].count += Number(row.count) || 0;
          }
        }

        setExpenses(mergedExpenses);
        setSummary({
          total_expenses: totalExpenses,
          byType: Object.values(summaryByType).sort((a, b) => b.total - a.total),
        });
      } else {
        if (selectedId) params.portfolio_id = selectedId;
        const [expList, sum] = await Promise.all([
          getExpenses(params),
          getExpensesSummary(selectedId || undefined),
        ]);
        setExpenses(expList);
        setSummary(sum);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setChargesLoading(false);
    }
  };

  // ── Portfolio CRUD ──────────────────────────────────────────────────

  const startEdit = (p) => {
    setEditId(p.id);
    setEditForm({ name: p.name, pan_number: p.pan_number || '', email: p.email || '', color: p.color });
  };

  const cancelEdit = () => setEditId(null);

  const saveEdit = async () => {
    try {
      setSaving(true);
      await updatePortfolio(editId, {
        name: editForm.name,
        pan_number: editForm.pan_number || null,
        email: editForm.email || null,
        color: editForm.color,
      });
      setEditId(null);
      await loadPortfolios();
      refreshPortfolios();
    } catch (e) {
      alert('Failed to update: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    if (!addForm.name.trim()) return alert('Name is required');
    try {
      setSaving(true);
      await createPortfolio({
        name: addForm.name.trim(),
        pan_number: addForm.pan_number.trim().toUpperCase() || null,
        email: addForm.email.trim().toLowerCase() || null,
        color: addForm.color,
      });
      setShowAdd(false);
      setAddForm({ name: '', pan_number: '', email: '', color: '#3b82f6' });
      await loadPortfolios();
      refreshPortfolios();
    } catch (e) {
      alert('Failed to create: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deletePortfolio(deleteTarget.id);
      setDeleteTarget(null);
      await loadPortfolios();
      refreshPortfolios();
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  };

  // ── Charges CRUD ────────────────────────────────────────────────────

  const handleAddCharge = async () => {
    const effectivePortfolioId = selectedId || Number(chargeForm.portfolio_id);
    if (!effectivePortfolioId) return alert('Please select a portfolio');
    if (!chargeForm.expense_date || !chargeForm.amount) return alert('Date and Amount are required');
    try {
      setChargeSaving(true);
      await addAmcCharge({
        portfolio_id: effectivePortfolioId,
        expense_type: chargeForm.expense_type,
        expense_date: chargeForm.expense_date,
        amount: Number(chargeForm.amount),
        broker: chargeForm.broker || null,
        notes: chargeForm.notes || null,
      });
      setShowAddCharge(false);
      setChargeForm({ portfolio_id: '', expense_type: 'AMC', expense_date: '', amount: '', broker: '', notes: '' });
      loadCharges();
    } catch (e) {
      alert('Failed to add charge: ' + e.message);
    } finally {
      setChargeSaving(false);
    }
  };

  const handleDeleteCharge = async () => {
    try {
      await deleteExpense(deleteChargeId);
      setDeleteChargeId(null);
      loadCharges();
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────

  if (loading) return <div className="text-center py-5"><Spinner animation="border" variant="primary" /></div>;

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex align-items-center justify-content-between">
        <h1 className="h4 fw-bold mb-0">
          <Users size={24} className="me-2 text-muted" />
          Portfolio Management
        </h1>
        {tab === 'members' && (
          <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
            <Plus size={16} className="me-1" />Add Portfolio
          </Button>
        )}
        {tab === 'charges' && (
          <Button variant="primary" size="sm" onClick={() => setShowAddCharge(true)}>
            <Plus size={16} className="me-1" />Add Charge
          </Button>
        )}
      </div>

      {error && <Alert variant="danger" dismissible onClose={() => setError(null)}>{error}</Alert>}

      {/* Tabs */}
      <Nav variant="tabs" activeKey={tab} onSelect={switchTab}>
        <Nav.Item>
          <Nav.Link eventKey="members" className="d-flex align-items-center gap-1">
            <Users size={15} /> Members
          </Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="charges" className="d-flex align-items-center gap-1">
            <Receipt size={15} /> Charges
          </Nav.Link>
        </Nav.Item>
      </Nav>

      {/* ── Members Tab ──────────────────────────────────────────── */}
      {tab === 'members' && (
        <Row className="g-3">
          {portfolios.map((p) => (
            <Col md={6} lg={4} key={p.id}>
              <Card className="shadow-sm h-100">
                <Card.Body>
                  {editId === p.id ? (
                    <div className="d-flex flex-column gap-2">
                      <Form.Control
                        size="sm"
                        value={editForm.name}
                        onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        placeholder="Display Name"
                        autoFocus
                      />
                      <Form.Control
                        size="sm"
                        value={editForm.pan_number}
                        onChange={(e) => setEditForm({ ...editForm, pan_number: e.target.value.toUpperCase() })}
                        placeholder="PAN Number (e.g. ABCDE1234F)"
                        className="font-monospace"
                        maxLength={10}
                      />
                      <Form.Control
                        size="sm"
                        type="email"
                        value={editForm.email}
                        onChange={(e) => setEditForm({ ...editForm, email: e.target.value.toLowerCase() })}
                        placeholder="Email (e.g. user@example.com)"
                      />
                      <div className="d-flex align-items-center gap-1">
                        <span className="text-muted small me-1">Color:</span>
                        {COLORS.map((c) => (
                          <button
                            key={c}
                            onClick={() => setEditForm({ ...editForm, color: c })}
                            className="rounded-circle border-0 p-0"
                            style={{
                              width: 22, height: 22, backgroundColor: c,
                              outline: editForm.color === c ? '2px solid #333' : 'none',
                              outlineOffset: 2,
                              transform: editForm.color === c ? 'scale(1.15)' : 'scale(1)',
                            }}
                          />
                        ))}
                      </div>
                      <div className="d-flex gap-2 mt-1">
                        <Button variant="primary" size="sm" onClick={saveEdit} disabled={saving} className="d-flex align-items-center gap-1">
                          <Check size={14} />{saving ? 'Saving...' : 'Save'}
                        </Button>
                        <Button variant="light" size="sm" onClick={cancelEdit} className="d-flex align-items-center gap-1">
                          <X size={14} />Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="d-flex align-items-start justify-content-between mb-3">
                        <div className="d-flex align-items-center gap-2">
                          <span className="rounded-circle flex-shrink-0" style={{ width: 20, height: 20, backgroundColor: p.color }} />
                          <div>
                            <div className="fw-bold">{p.name}</div>
                            {p.pan_number && (
                              <div className="text-muted font-monospace" style={{ fontSize: '0.75rem' }}>PAN: {p.pan_number}</div>
                            )}
                            {p.email && (
                              <div className="text-muted" style={{ fontSize: '0.75rem' }}>{p.email}</div>
                            )}
                          </div>
                        </div>
                        <div className="d-flex gap-1">
                          <button className="btn btn-sm btn-link text-muted p-1" title="Edit" onClick={() => startEdit(p)}><Pencil size={14} /></button>
                          <button className="btn btn-sm btn-link text-danger p-1" title="Delete" onClick={() => setDeleteTarget(p)}><Trash2 size={14} /></button>
                        </div>
                      </div>
                      <div className="d-flex gap-4 text-muted small">
                        <div>
                          <div className="fw-semibold text-dark">{p.investment_count || 0}</div>
                          <div>Investments</div>
                        </div>
                        <div>
                          <div className="fw-semibold text-dark">{formatINR(p.total_value)}</div>
                          <div>Current Value</div>
                        </div>
                        <div>
                          <div className={`fw-semibold ${profitColor(p.total_profit_loss)}`}>
                            {p.total_profit_loss >= 0 ? '+' : ''}{formatINR(p.total_profit_loss)}
                          </div>
                          <div>Returns</div>
                        </div>
                      </div>
                    </>
                  )}
                </Card.Body>
              </Card>
            </Col>
          ))}
          {portfolios.length === 0 && (
            <Col>
              <Card className="shadow-sm"><Card.Body className="text-center text-muted py-5">No portfolios yet. Click "Add Portfolio" to create one.</Card.Body></Card>
            </Col>
          )}
        </Row>
      )}

      {/* ── Charges Tab ──────────────────────────────────────────── */}
      {tab === 'charges' && (
        <>
          {/* Summary Cards */}
          {summary && (
            <div className="d-flex gap-3 overflow-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
              <Card className="shadow-sm flex-shrink-0" style={{ minWidth: 220, flex: '1 1 220px' }}>
                <Card.Body className="text-center">
                  <div className="text-muted small mb-1">Total Charges</div>
                  <div className="fs-4 fw-bold text-danger">{formatINR(summary.total_expenses)}</div>
                </Card.Body>
              </Card>
              {summary.byType?.map((t) => (
                <Card key={t.expense_type} className="shadow-sm flex-shrink-0" style={{ minWidth: 220, flex: '1 1 220px' }}>
                  <Card.Body className="text-center">
                    <div className="text-muted small mb-1">{EXPENSE_TYPE_LABELS[t.expense_type] || t.expense_type}</div>
                    <div className="fs-5 fw-semibold">{formatINR(t.total)}</div>
                    <div className="text-muted" style={{ fontSize: '0.75rem' }}>{t.count} charge{t.count !== 1 ? 's' : ''}</div>
                  </Card.Body>
                </Card>
              ))}
            </div>
          )}

          {/* Filters */}
          <div className="d-flex flex-wrap align-items-center gap-3">
            <div className="d-flex align-items-center gap-2">
              <label className="small fw-semibold text-muted">Type</label>
              <Form.Select size="sm" value={filterType} onChange={(e) => setFilterType(e.target.value)} style={{ width: 180 }}>
                <option value="">All Types</option>
                {EXPENSE_TYPES.map((t) => (
                  <option key={t} value={t}>{EXPENSE_TYPE_LABELS[t]}</option>
                ))}
              </Form.Select>
            </div>
            <span className="text-muted small">{chargesLoading ? '...' : `${expenses.length} record${expenses.length !== 1 ? 's' : ''}`}</span>
          </div>

          {/* Table */}
          <Card className="shadow-sm">
            <div className="table-responsive">
              <Table hover className="mb-0 align-middle" size="sm">
                <thead className="bg-light">
                  <tr>
                    <th className="ps-3">Date</th>
                    <th>Portfolio</th>
                    <th>Type</th>
                    <th className="text-end">Amount</th>
                    <th>Broker</th>
                    <th>Notes</th>
                    <th style={{ width: 50 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center text-muted py-4">
                        No charges recorded yet. Click "Add Charge" to record one.
                      </td>
                    </tr>
                  ) : expenses.map((e) => (
                    <tr key={e.id}>
                      <td className="ps-3">{formatDate(e.expense_date)}</td>
                      <td>
                        <span className="d-flex align-items-center gap-2">
                          <span className="portfolio-dot" style={{ backgroundColor: resolvePortfolioColor(e), width: 10, height: 10 }} />
                          {e.portfolio_name}
                        </span>
                      </td>
                      <td><span className="badge bg-secondary bg-opacity-10 text-dark">{EXPENSE_TYPE_LABELS[e.expense_type] || e.expense_type}</span></td>
                      <td className="text-end fw-medium text-danger">-{formatINR(e.amount)}</td>
                      <td className="text-muted">{e.broker || '—'}</td>
                      <td className="text-muted small">{e.notes || '—'}</td>
                      <td>
                        <button className="btn btn-sm btn-link text-danger p-0" title="Delete" onClick={() => setDeleteChargeId(e.id)}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>
        </>
      )}

      {/* ── Add Portfolio Modal ──────────────────────────────────── */}
      <Modal show={showAdd} onHide={() => setShowAdd(false)} centered>
        <Modal.Header closeButton><Modal.Title className="h6">Add Portfolio</Modal.Title></Modal.Header>
        <Modal.Body>
          <div className="d-flex flex-column gap-3">
            <Form.Group>
              <Form.Label className="small fw-semibold">Name *</Form.Label>
              <Form.Control
                value={addForm.name}
                onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                placeholder="e.g. Rahul Yadav"
                autoFocus
              />
            </Form.Group>
            <Form.Group>
              <Form.Label className="small fw-semibold">PAN Number</Form.Label>
              <Form.Control
                value={addForm.pan_number}
                onChange={(e) => setAddForm({ ...addForm, pan_number: e.target.value.toUpperCase() })}
                placeholder="e.g. ABCDE1234F"
                className="font-monospace"
                maxLength={10}
              />
            </Form.Group>
            <Form.Group>
              <Form.Label className="small fw-semibold">Email</Form.Label>
              <Form.Control
                type="email"
                value={addForm.email}
                onChange={(e) => setAddForm({ ...addForm, email: e.target.value.toLowerCase() })}
                placeholder="e.g. user@example.com"
              />
            </Form.Group>
            <div>
              <div className="small fw-semibold mb-2">Color</div>
              <div className="d-flex align-items-center gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setAddForm({ ...addForm, color: c })}
                    className="rounded-circle border-0 p-0"
                    style={{
                      width: 28, height: 28, backgroundColor: c,
                      outline: addForm.color === c ? '2px solid #333' : 'none',
                      outlineOffset: 2,
                      transform: addForm.color === c ? 'scale(1.15)' : 'scale(1)',
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={() => setShowAdd(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleAdd} disabled={saving}>
            {saving ? 'Creating...' : 'Create Portfolio'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Delete Portfolio Confirmation */}
      <Modal show={!!deleteTarget} onHide={() => setDeleteTarget(null)} centered size="sm">
        <Modal.Body className="text-center py-4">
          <p className="mb-1 fw-semibold">Delete "{deleteTarget?.name}"?</p>
          <p className="text-muted small mb-3">Transactions will be unassigned, not deleted.</p>
          <div className="d-flex gap-2 justify-content-center">
            <Button variant="light" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>Delete</Button>
          </div>
        </Modal.Body>
      </Modal>

      {/* ── Add Charge Modal ─────────────────────────────────────── */}
      <Modal show={showAddCharge} onHide={() => setShowAddCharge(false)} centered>
        <Modal.Header closeButton><Modal.Title className="h6">Add Charge</Modal.Title></Modal.Header>
        <Modal.Body>
          <div className="d-flex flex-column gap-3">
            {!selectedPortfolio && (
              <Form.Group>
                <Form.Label className="small fw-semibold">Portfolio *</Form.Label>
                <Form.Select value={chargeForm.portfolio_id} onChange={(e) => setChargeForm({ ...chargeForm, portfolio_id: e.target.value })}>
                  <option value="">Select portfolio</option>
                  {ctxPortfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Form.Select>
              </Form.Group>
            )}
            <Form.Group>
              <Form.Label className="small fw-semibold">Type</Form.Label>
              <Form.Select value={chargeForm.expense_type} onChange={(e) => setChargeForm({ ...chargeForm, expense_type: e.target.value })}>
                {EXPENSE_TYPES.map((t) => <option key={t} value={t}>{EXPENSE_TYPE_LABELS[t]}</option>)}
              </Form.Select>
            </Form.Group>
            <Row>
              <Col>
                <Form.Group>
                  <Form.Label className="small fw-semibold">Date *</Form.Label>
                  <Form.Control type="date" value={chargeForm.expense_date} onChange={(e) => setChargeForm({ ...chargeForm, expense_date: e.target.value })} />
                </Form.Group>
              </Col>
              <Col>
                <Form.Group>
                  <Form.Label className="small fw-semibold">Amount *</Form.Label>
                  <Form.Control type="number" step="0.01" min="0" value={chargeForm.amount} onChange={(e) => setChargeForm({ ...chargeForm, amount: e.target.value })} placeholder="0.00" />
                </Form.Group>
              </Col>
            </Row>
            <Form.Group>
              <Form.Label className="small fw-semibold">Broker</Form.Label>
              <Form.Control value={chargeForm.broker} onChange={(e) => setChargeForm({ ...chargeForm, broker: e.target.value })} placeholder="e.g. Zerodha" />
            </Form.Group>
            <Form.Group>
              <Form.Label className="small fw-semibold">Notes</Form.Label>
              <Form.Control as="textarea" rows={2} value={chargeForm.notes} onChange={(e) => setChargeForm({ ...chargeForm, notes: e.target.value })} placeholder="Optional notes" />
            </Form.Group>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={() => setShowAddCharge(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleAddCharge} disabled={chargeSaving}>
            {chargeSaving ? 'Saving...' : 'Add Charge'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Delete Charge Confirmation */}
      <Modal show={!!deleteChargeId} onHide={() => setDeleteChargeId(null)} centered size="sm">
        <Modal.Body className="text-center py-4">
          <p className="mb-1 fw-semibold">Delete this charge?</p>
          <p className="text-muted small mb-3">This action cannot be undone.</p>
          <div className="d-flex gap-2 justify-content-center">
            <Button variant="light" size="sm" onClick={() => setDeleteChargeId(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={handleDeleteCharge}>Delete</Button>
          </div>
        </Modal.Body>
      </Modal>
    </div>
  );
}
