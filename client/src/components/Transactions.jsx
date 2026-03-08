import React, { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Card, Table, Spinner, Form } from 'react-bootstrap';
import { getTransactions, getBrokers, getInvestmentNames } from '../services/api';
import { formatNumber, formatDate, ASSET_TYPE_LABELS } from '../utils/formatters';
import { usePortfolio } from '../context/PortfolioContext';

const TRANSACTION_TYPES = [
  'BUY', 'SELL', 'DIVIDEND', 'BONUS', 'IPO',
];

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

        <span className="ms-auto small text-muted">
          {transactions.length} transaction{transactions.length !== 1 ? 's' : ''}
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
                  <th className="px-3 py-2">Broker</th>
                  <th className="px-3 py-2">Notes</th>
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
                    <td className="px-3 py-2 text-muted" style={{ fontSize: '0.75rem' }}>{txn.broker || '-'}</td>
                    <td className="px-3 py-2 text-muted text-truncate" style={{ maxWidth: 150 }}>{txn.notes || '-'}</td>
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
