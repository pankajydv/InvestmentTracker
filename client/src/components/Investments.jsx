import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Row, Col, Card, Spinner } from 'react-bootstrap';
import { getCorporateActionSuggestionCount, getInvestments } from '../services/api';
import { ASSET_TYPE_LABELS, ASSET_TYPE_FULL_NAMES, ASSET_TYPE_FILTER_ORDER } from '../utils/formatters';
import { PlusCircle, RefreshCw, Percent } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';
import { useAppSettings } from '../context/AppSettingsContext';

const TYPE_ALL = '';

function compareInvestments(a, b) {
  const nameA = String(a?.display_name || a?.name || '').toLowerCase();
  const nameB = String(b?.display_name || b?.name || '').toLowerCase();
  return nameA.localeCompare(nameB);
}

export default function Investments() {
  const { selectedId, selectedIds } = usePortfolio();
  const { settings } = useAppSettings();
  const [searchParams, setSearchParams] = useSearchParams();
  const [investments, setInvestments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingSuggestionCount, setPendingSuggestionCount] = useState(0);
  const typeFilter = searchParams.get('type') || '';
  const hideSold = settings.hideSoldInvestments;

  useEffect(() => {
    loadInvestments();
  }, [typeFilter, selectedId, selectedIds, hideSold]);

  useEffect(() => {
    let cancelled = false;
    const loadPendingCount = async () => {
      try {
        const data = await getCorporateActionSuggestionCount(selectedId || null);
        if (!cancelled) setPendingSuggestionCount(Number(data?.count || 0));
      } catch (_e) {
        if (!cancelled) setPendingSuggestionCount(0);
      }
    };
    loadPendingCount();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

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
        setInvestments(merged.sort(compareInvestments));
      } else {
        const result = await getInvestments(typeFilter, selectedId, { hideSold });
        setInvestments([...(result || [])].sort(compareInvestments));
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
        <div className="d-flex align-items-center gap-2 flex-wrap investments-toolbar">
          <div className="d-flex align-items-center gap-2 flex-nowrap overflow-auto investments-type-filters" role="group" aria-label="Filter by asset type">
            <button
              type="button"
              className={`btn btn-sm ${typeFilter === TYPE_ALL ? 'btn-primary' : 'btn-outline-secondary'}`}
              onClick={() => setSearchParams({})}
            >
              All
            </button>
            {ASSET_TYPE_FILTER_ORDER.map((assetType) => (
              <button
                key={assetType}
                type="button"
                className={`btn btn-sm ${typeFilter === assetType ? 'btn-primary' : 'btn-outline-secondary'}`}
                title={ASSET_TYPE_FULL_NAMES[assetType] || assetType}
                onClick={() => setSearchParams({ type: assetType })}
              >
                {ASSET_TYPE_LABELS[assetType] || assetType}
              </button>
            ))}
          </div>
          <span className="small text-muted investments-sold-status">
            {hideSold ? 'Sold investments hidden' : 'Showing sold investments'}
          </span>
          <Link to="/interest-rates" className="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1">
            <Percent size={16} /> Interest Rates
          </Link>
          <Link to="/corporate-actions" className="btn btn-outline-primary btn-sm d-flex align-items-center gap-1 position-relative">
            <RefreshCw size={16} /> Sync Corporate Actions
            {pendingSuggestionCount > 0 && (
              <span className="badge rounded-pill bg-danger">{pendingSuggestionCount}</span>
            )}
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
