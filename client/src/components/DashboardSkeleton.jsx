import React from 'react';
import { Card, Col, Row } from 'react-bootstrap';

function Shimmer({ className = '' }) {
  return <span className={`dashboard-shimmer ${className}`} aria-hidden="true" />;
}

export default function DashboardSkeleton({ assetType = false }) {
  return (
    <div className="dashboard-skeleton" role="status" aria-live="polite" aria-label="Loading dashboard">
      <div className="d-flex justify-content-between align-items-center mb-4 gap-3">
        <Shimmer className={assetType ? 'dashboard-shimmer-title-wide' : 'dashboard-shimmer-title'} />
        <div className="d-flex gap-2">
          <Shimmer className="dashboard-shimmer-control" />
          <Shimmer className="dashboard-shimmer-control" />
        </div>
      </div>

      <Row className="g-3 mb-4">
        {[0, 1, 2, 3].map((item) => (
          <Col xs={6} lg={3} key={item}>
            <Card className="shadow-sm h-100">
              <Card.Body>
                <Shimmer className="dashboard-shimmer-label" />
                <Shimmer className="dashboard-shimmer-value" />
                <Shimmer className="dashboard-shimmer-detail" />
              </Card.Body>
            </Card>
          </Col>
        ))}
      </Row>

      <Card className="shadow-sm mb-4">
        <Card.Body>
          <Shimmer className="dashboard-shimmer-section-title" />
          <div className="dashboard-skeleton-allocation mt-3">
            <div className="dashboard-skeleton-tiles">
              {[0, 1, 2, 3].map((item) => (
                <div className="dashboard-skeleton-tile" key={item}>
                  <Shimmer className="dashboard-shimmer-label" />
                  <Shimmer className="dashboard-shimmer-value-small" />
                  <Shimmer className="dashboard-shimmer-detail" />
                </div>
              ))}
            </div>
            <Shimmer className="dashboard-shimmer-donut" />
          </div>
        </Card.Body>
      </Card>

      <Card className="shadow-sm">
        <Card.Body>
          <Shimmer className="dashboard-shimmer-section-title" />
          <div className="mt-3">
            {[0, 1, 2, 3, 4].map((item) => (
              <div className="dashboard-skeleton-row" key={item}>
                <Shimmer className="dashboard-shimmer-cell-wide" />
                <Shimmer className="dashboard-shimmer-cell" />
                <Shimmer className="dashboard-shimmer-cell" />
                <Shimmer className="dashboard-shimmer-cell" />
              </div>
            ))}
          </div>
        </Card.Body>
      </Card>
      <span className="visually-hidden">Fresh portfolio data is loading.</span>
    </div>
  );
}