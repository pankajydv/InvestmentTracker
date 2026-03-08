import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Row, Col, Card, Spinner, Form, Button } from 'react-bootstrap';
import { getInvestments } from '../services/api';
import { formatINR, ASSET_TYPE_LABELS } from '../utils/formatters';
import { PlusCircle, Filter, EyeOff, Eye } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

const ASSET_TYPES = ['', 'MUTUAL_FUND', 'INDIAN_STOCK', 'FOREIGN_STOCK', 'PPF', 'PF'];

export default function Investments() {
  const { selectedId } = usePortfolio();
  const [searchParams, setSearchParams] = useSearchParams();
  const [investments, setInvestments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hideSold, setHideSold] = useState(() => localStorage.getItem('hideSoldInvestments') !== 'false');
  const typeFilter = searchParams.get('type') || '';

  useEffect(() => {
    loadInvestments();
  }, [typeFilter, selectedId, hideSold]);

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
      const result = await getInvestments(typeFilter, selectedId, { hideSold });
      setInvestments(result);
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
              <Card as={Link} to={`/investments/${inv.id}`} className="shadow-sm h-100 text-decoration-none" style={{ transition: 'box-shadow 0.2s' }}>
                <Card.Body>
                  <div className="d-flex justify-content-between align-items-start mb-2">
                    <div>
                      <h6 className="fw-semibold mb-1">{inv.name}</h6>
                      <span className="badge bg-primary bg-opacity-10 text-primary">{ASSET_TYPE_LABELS[inv.asset_type]}</span>
                    </div>
                  </div>
                  <div className="small text-muted">
                    {inv.ticker_symbol && <div>Ticker: <span className="text-body">{inv.ticker_symbol}</span></div>}
                    {inv.amfi_code && <div>AMFI: <span className="text-body">{inv.amfi_code}</span></div>}
                    {inv.folio_number && <div>Folio: <span className="text-body">{inv.folio_number}</span></div>}
                    <div>Currency: <span className="text-body">{inv.currency}</span></div>
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
