import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Button, Collapse, Form, Spinner, Table } from 'react-bootstrap';
import { getDashboardRollover } from '../services/api';
import { usePortfolio } from '../context/PortfolioContext';
import { formatINR, formatINRExact, formatNumber, profitColor } from '../utils/formatters';
import { usePrivacyMaskRefresh } from '../utils/privacyMode';
import CollapsibleSectionHeader from './CollapsibleSectionHeader';

export default function DashboardRolloverTable({ title, description, assetType = null, showSource = true, compactCollapsed = false, defaultExpanded = false, wrapperClassName = 'shadow-sm mt-4' }) {
  usePrivacyMaskRefresh();
  const { selectedIds } = usePortfolio();
  const selectedIdsKey = (selectedIds || []).join(',');
  const DEFAULT_PAGE_SIZE = 366;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const [filters, setFilters] = useState({
    from: '',
    to: '',
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  });
  const filtersRef = useRef(filters);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const loadData = useCallback(async (nextFilters = null) => {
    const effectiveFilters = nextFilters || filtersRef.current;
    try {
      setLoading(true);
      setError('');
      const result = await getDashboardRollover({
        assetType,
        from: effectiveFilters.from,
        to: effectiveFilters.to,
        page: effectiveFilters.page,
        pageSize: effectiveFilters.pageSize,
        portfolioIds: (selectedIds || []).length > 0 ? selectedIds : undefined,
      });
      setData(result);
      setFilters((prev) => ({
        ...prev,
        from: prev.from || result?.window?.requested_from || '',
        to: prev.to || result?.window?.requested_to || '',
        page: Number(result?.pagination?.page || prev.page || 1),
        pageSize: Number(result?.pagination?.page_size || prev.pageSize || DEFAULT_PAGE_SIZE),
      }));
    } catch (e) {
      setError(e.message || 'Failed to load rollover rows');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [assetType, selectedIds, selectedIdsKey]);

  useEffect(() => {
    if (!expanded) return;
    loadData(filtersRef.current);
  }, [expanded, loadData]);

  const emptyColSpan = showMore
    ? (showSource ? 9 : 8)
    : (showSource ? 5 : 4);

  return (
    <Card className={`${wrapperClassName} ${compactCollapsed && !expanded ? 'rollup-card-collapsed' : ''}`}>
      <Card.Body className={compactCollapsed && !expanded ? 'py-2 px-3' : undefined}>
        <CollapsibleSectionHeader
          className={`d-flex align-items-center gap-2 ${expanded ? 'mb-2' : 'mb-0'}`}
          rightClassName="table-toolbar-actions"
          expanded={expanded}
          onToggle={() => {
            const nextExpanded = !expanded;
            setExpanded(nextExpanded);
            if (nextExpanded && !data && !loading) {
              loadData();
            }
          }}
          title={title}
          right={expanded ? (
            <Button
              size="sm"
              variant="link"
              className="p-0 text-decoration-none table-compact-toggle"
              onClick={() => setShowMore((prev) => !prev)}
            >
              {showMore ? 'Less fields' : 'More fields'}
            </Button>
          ) : null}
        />

        <Collapse in={expanded}>
          <div>
            <Form
              className="table-toolbar mb-2"
              onSubmit={(e) => {
                e.preventDefault();
                loadData();
              }}
            >
              <div className="table-toolbar-main">
              <Form.Group className="table-toolbar-field">
                <span className="table-toolbar-label">From</span>
                <Form.Control
                  size="sm"
                  type="date"
                  value={filters.from}
                  onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value, page: 1 }))}
                />
              </Form.Group>
              <Form.Group className="table-toolbar-field">
                <span className="table-toolbar-label">To</span>
                <Form.Control
                  size="sm"
                  type="date"
                  value={filters.to}
                  onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value, page: 1 }))}
                />
              </Form.Group>
              <Form.Group className="table-toolbar-field table-toolbar-field-sm">
                <span className="table-toolbar-label">Rows</span>
                <Form.Control
                  size="sm"
                  type="number"
                  min="1"
                  max="5000"
                  value={filters.pageSize}
                  onChange={(e) => setFilters((prev) => ({
                    ...prev,
                    pageSize: Math.max(1, Math.min(5000, Number(e.target.value || DEFAULT_PAGE_SIZE))),
                    page: 1,
                  }))}
                  style={{ width: 92 }}
                />
              </Form.Group>
              <Form.Group className="table-toolbar-field table-toolbar-field-sm">
                <span className="table-toolbar-label">Page</span>
                <Form.Control
                  size="sm"
                  type="number"
                  min="1"
                  value={filters.page}
                  onChange={(e) => setFilters((prev) => ({
                    ...prev,
                    page: Math.max(1, Number(e.target.value || 1)),
                  }))}
                  style={{ width: 74 }}
                />
              </Form.Group>
              <Button size="sm" type="submit" variant="outline-primary" disabled={loading}>
                {loading ? '...' : 'Go'}
              </Button>
              </div>

              {data?.pagination && (
                <div className="table-toolbar-status small">
                  <Button
                    size="sm"
                    type="button"
                    variant="outline-secondary"
                    disabled={loading || !data.pagination.has_previous}
                    onClick={() => {
                      const nextFilters = { ...filters, page: Math.max(1, filters.page - 1) };
                      setFilters(nextFilters);
                      loadData(nextFilters);
                    }}
                  >
                    Prev
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline-secondary"
                    disabled={loading || !data.pagination.has_next}
                    onClick={() => {
                      const nextFilters = { ...filters, page: filters.page + 1 };
                      setFilters(nextFilters);
                      loadData(nextFilters);
                    }}
                  >
                    Next
                  </Button>
                  <span className="rounded-3 px-2 py-1 bg-light">
                    {data.pagination.page}/{data.pagination.total_pages}
                  </span>
                </div>
              )}
            </Form>

            {error && <div className="text-danger small mb-2">{error}</div>}

            {loading ? (
              <div className="py-3 d-flex align-items-center gap-2 text-muted small">
                <Spinner animation="border" size="sm" /> Loading rollover rows...
              </div>
            ) : (
              <div className="responsive-table">
                <Table size="sm" className="mb-0 align-middle small">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th className="text-end">Current Value</th>
                      <th className="text-end">1D Change</th>
                      <th className="text-end">1D %</th>
                      {showSource && <th className="ps-4">Source</th>}
                      {showMore && <th className="text-end">Net Invested</th>}
                      {showMore && <th className="text-end">Realized</th>}
                      {showMore && <th className="text-end">P/L</th>}
                      {showMore && <th className="text-end">Portfolios</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.rows || []).length === 0 ? (
                      <tr>
                        <td colSpan={emptyColSpan} className="text-center text-muted py-3">No rollover rows in selected window.</td>
                      </tr>
                    ) : (
                      data.rows.map((row) => (
                        <tr key={row.date}>
                          <td>{row.date}</td>
                          <td className="text-end">{formatINR(row.current_value)}</td>
                          <td className={`text-end ${profitColor(row.day_change)}`}>{formatINRExact(row.day_change, 0)}</td>
                          <td className={`text-end ${profitColor(row.day_change_pct)}`}>{formatNumber(row.day_change_pct, 2)}%</td>
                          {showSource && <td className="ps-4">{row.price_source || '-'}</td>}
                          {showMore && <td className="text-end">{formatINR(row.invested_amount)}</td>}
                          {showMore && <td className="text-end">{formatINR(row.realized_proceeds)}</td>}
                          {showMore && <td className={`text-end ${profitColor(row.profit_loss)}`}>{formatINR(row.profit_loss)}</td>}
                          {showMore && <td className="text-end">{row.contributing_portfolios || 0}</td>}
                        </tr>
                      ))
                    )}
                  </tbody>
                </Table>
              </div>
            )}
          </div>
        </Collapse>
      </Card.Body>
    </Card>
  );
}
