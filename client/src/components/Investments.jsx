import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Row, Col, Card, Spinner, Form, Button } from 'react-bootstrap';
import { getInvestments } from '../services/api';
import { formatINR, formatPct, ASSET_TYPE_LABELS, ASSET_TYPE_FULL_NAMES } from '../utils/formatters';
import { PlusCircle, Filter, EyeOff, Eye, RefreshCw, Percent } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

const ASSET_TYPES = ['', 'MUTUAL_FUND', 'INDIAN_STOCK', 'FOREIGN_STOCK', 'NPS', 'PPF', 'SSY', 'PF', 'BOND', 'SGB'];

export default function Investments() {
  const { selectedId, selectedIds } = usePortfolio();
  const [searchParams, setSearchParams] = useSearchParams();
  const [investments, setInvestments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hideSold, setHideSold] = useState(() => localStorage.getItem('hideSoldInvestments') !== 'false');
  const typeFilter = searchParams.get('type') || '';

  useEffect(() => {
    loadInvestments();
  }, [typeFilter, selectedId, selectedIds, hideSold]);

  const toggleHideSold = () => {
    setHideSold(prev => {
      const next = !prev;
      localStorage.setItem('hideSoldInvestments', String(next));
      return next;
    });
  };

  const loadInvestments = async () => {
    try {
      setLoading(true);
      if (selectedIds.length > 1) {
        const results = await Promise.all(selectedIds.map((id) => getInvestments(typeFilter, id, { hideSold })));
        const seen = new Set();
        const merged = [];
        for (const list of results) {
          for (const inv of list || []) {
            if (seen.has(inv.id)) continue;
            seen.add(inv.id);
            merged.push(inv);
          }
        }
        setInvestments(merged);
      } else {
        const result = await getInvestments(typeFilter, selectedId, { hideSold });
        setInvestments(result);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="d-flex flex-column flex-sm-row justify-content-between align-items-start align-items-sm-center gap-3 mb-4">
        <h1 className="h4 fw-bold mb-0">Investments</h1>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <div className="d-flex align-items-center gap-2">
            <Filter size={16} className="text-muted" />
            <Form.Select
              size="sm"
              value={typeFilter}
              onChange={(e) => setSearchParams(e.target.value ? { type: e.target.value } : {})}
              style={{ width: 'auto' }}
            >
              <option value="">All Types</option>
              {ASSET_TYPES.filter(Boolean).map((t) => (
                <option key={t} value={t}>{ASSET_TYPE_LABELS[t]}</option>
              ))}
            </Form.Select>
          </div>
          <Button
            variant={hideSold ? 'outline-warning' : 'outline-secondary'}
            size="sm"
            onClick={toggleHideSold}
            className="d-flex align-items-center gap-1"
            title={hideSold ? 'Showing active holdings only' : 'Showing all investments'}
          >
            {hideSold ? <EyeOff size={16} /> : <Eye size={16} />}
            {hideSold ? 'Sold hidden' : 'Showing all'}
          </Button>
          <Link to="/interest-rates" className="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1">
            <Percent size={16} /> Interest Rates
          </Link>
          <Link to="/corporate-actions" className="btn btn-outline-primary btn-sm d-flex align-items-center gap-1">
            <RefreshCw size={16} /> Sync Corporate Actions
          </Link>
          <Link to="/investments/add" className="btn btn-primary btn-sm d-flex align-items-center gap-1">
            <PlusCircle size={16} /> Add Investment
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" variant="primary" />
        </div>
      ) : investments.length === 0 ? (
        <Card className="shadow-sm text-center p-5">
          <Card.Body>
            <p className="text-muted mb-3">No investments found.</p>
            <Link to="/investments/add" className="text-decoration-none fw-medium">Add your first investment</Link>
          </Card.Body>
        </Card>
      ) : (
        <Row className="g-3">
          {investments.map((inv) => (
            <Col key={inv.id} md={6} lg={4}>
              <Card as={Link} to={`/investments/${inv.id}`} state={{ investmentsSearch: searchParams.toString() }} className="shadow-sm h-100 text-decoration-none" style={{ transition: 'box-shadow 0.2s' }}>
                <Card.Body className="p-3">
                  <div className="d-flex justify-content-between align-items-start mb-1">
                    <div>
                      <h6 className="fw-semibold mb-1 text-truncate" style={{ maxWidth: '24rem' }}>{inv.display_name || inv.name}</h6>
                      <span className="badge bg-primary bg-opacity-10 text-primary" title={ASSET_TYPE_FULL_NAMES[inv.asset_type]}>{ASSET_TYPE_LABELS[inv.asset_type]}</span>
                      {inv.is_active === 0 && <span className="badge bg-secondary ms-1">Inactive</span>}
                    </div>
                  </div>
                  <div className="small text-muted d-flex flex-wrap gap-2 mb-1" style={{ lineHeight: 1.2 }}>
                    {inv.ticker_symbol && <span>Symbol: <span className="text-body">{inv.ticker_symbol.replace(/\.(NS|BO)$/, '')}</span></span>}
                    {inv.isin_code && <span>ISIN: <span className="text-body">{inv.isin_code}</span></span>}
                    {inv.amfi_code && <span>AMFI: <span className="text-body">{inv.amfi_code}</span></span>}
                    {inv.category && <span>Category: <span className="text-body">{inv.category}</span></span>}
                  </div>
                </Card.Body>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </div>
  );
}
