import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Card, Row, Col, Table, Button, Form, Spinner, Badge } from 'react-bootstrap';
import { getInvestment, deleteInvestment, addTransaction, deleteTransaction } from '../services/api';
import { formatINR, formatNumber, formatPct, formatDate, profitColor, ASSET_TYPE_LABELS } from '../utils/formatters';
import { ArrowLeft, Trash2, Plus, X } from 'lucide-react';

export default function InvestmentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
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

  useEffect(() => { loadData(); }, [id]);

  const loadData = async () => {
    try {
      setLoading(true);
      const result = await getInvestment(id);
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
    navigate('/investments');
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

  const handleDeleteTxn = async (txnId) => {
    if (!window.confirm('Delete this transaction?')) return;
    await deleteTransaction(txnId);
    loadData();
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

  const isPPF = data.asset_type === 'PPF' || data.asset_type === 'PF';
  const txnTypes = isPPF
    ? ['DEPOSIT', 'WITHDRAWAL', 'INTEREST']
    : ['BUY', 'SELL', 'DIVIDEND'];

  return (
    <div>
      {/* Header */}
      <div className="d-flex flex-column flex-sm-row justify-content-between align-items-start gap-3 mb-4">
        <div>
          <Link to="/investments" className="small text-muted text-decoration-none d-flex align-items-center gap-1 mb-2">
            <ArrowLeft size={16} /> Back to Investments
          </Link>
          <h1 className="h4 fw-bold mb-1">{data.name}</h1>
          <div className="d-flex align-items-center gap-2">
            <Badge bg="primary" className="bg-opacity-10 text-primary">{ASSET_TYPE_LABELS[data.asset_type]}</Badge>
            {data.portfolio_name && (
              <Badge bg="light" text="dark" className="border d-flex align-items-center gap-1">
                <span className="portfolio-dot" style={{ backgroundColor: data.portfolio_color || '#6b7280', width: 8, height: 8 }} />
                {data.portfolio_name}
              </Badge>
            )}
          </div>
        </div>
        <div className="d-flex gap-2">
          <Button variant="primary" size="sm" onClick={() => setShowAddTxn(true)} className="d-flex align-items-center gap-1">
            <Plus size={16} /> Add Transaction
          </Button>
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
            {data.amfi_code && <Col xs={6} md={3}><Detail label="AMFI Code" value={data.amfi_code} /></Col>}
            {data.folio_number && <Col xs={6} md={3}><Detail label="Folio No." value={data.folio_number} /></Col>}
            {!isPPF && <Col xs={6} md={3}><Detail label="Total Units" value={formatNumber(data.totalUnits, 3)} /></Col>}
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
                  <Form.Label className="small">Fees (₹)</Form.Label>
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
                  <th className="px-3 text-end">Fees</th>
                  <th className="px-3">Notes</th>
                  <th className="px-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.transactions.map((txn) => (
                  <tr key={txn.id}>
                    <td className="px-3">{formatDate(txn.transaction_date)}</td>
                    <td className="px-3">
                      <span className={`badge rounded-pill badge-${txn.transaction_type.toLowerCase()}`}>
                        {txn.transaction_type}
                      </span>
                    </td>
                    <td className="px-3 text-end">{txn.units ? formatNumber(txn.units, 3) : '-'}</td>
                    <td className="px-3 text-end">{txn.price_per_unit ? `₹${formatNumber(txn.price_per_unit, 2)}` : '-'}</td>
                    <td className="px-3 text-end fw-medium">₹{formatNumber(txn.amount, 2)}</td>
                    <td className="px-3 text-end">{txn.fees > 0 ? `₹${formatNumber(txn.fees, 2)}` : '-'}</td>
                    <td className="px-3 text-muted">{txn.notes || '-'}</td>
                    <td className="px-3">
                      <button onClick={() => handleDeleteTxn(txn.id)} className="btn btn-link text-danger p-0" title="Delete">
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
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
