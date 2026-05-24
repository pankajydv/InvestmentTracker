import React from 'react';
import { Card, Accordion } from 'react-bootstrap';

export default function MetricsFaq() {
  return (
    <div>
      <h1 className="h4 fw-bold mb-2">Metrics FAQ</h1>
      <p className="text-muted mb-4">
        This page explains how portfolio-level totals and individual investment rows are calculated.
      </p>

      <Card className="shadow-sm mb-4">
        <Card.Body>
          <h2 className="h6 fw-semibold mb-2">Metric Basis Used</h2>
          <ul className="small mb-0">
            <li><strong>Top Summary Cards:</strong> Cost Basis</li>
            <li><strong>Individual Investment Rows:</strong> Attribution Basis</li>
            <li><strong>Asset Footer Total Row:</strong> Cost Basis</li>
          </ul>
        </Card.Body>
      </Card>

      <Accordion defaultActiveKey="0" className="mb-4">
        <Accordion.Item eventKey="0">
          <Accordion.Header>Why can row sums differ from footer totals?</Accordion.Header>
          <Accordion.Body>
            Row values are investment-attribution based. Footer totals are cost-basis based.
            After switches/transfers, these represent different accounting lenses, so direct row-sum equality is not always expected.
          </Accordion.Body>
        </Accordion.Item>
        <Accordion.Item eventKey="1">
          <Accordion.Header>What does Cost Basis mean here?</Accordion.Header>
          <Accordion.Body>
            Cost Basis totals focus on external cash movement. Internal reallocations between funds
            are excluded from invested/received totals in this lens.
          </Accordion.Body>
        </Accordion.Item>
        <Accordion.Item eventKey="2">
          <Accordion.Header>What does Attribution Basis mean here?</Accordion.Header>
          <Accordion.Body>
            Attribution metrics answer investment-level performance questions. If value moves in/out via
            switches or transfers, that movement is attributed to the specific investment rows involved.
          </Accordion.Body>
        </Accordion.Item>
        <Accordion.Item eventKey="3">
          <Accordion.Header>Why can Cash Out (Realized Proceeds) be larger than Total P&amp;L?</Accordion.Header>
          <Accordion.Body>
            Cash Out (Realized Proceeds) is cash received. Total P&amp;L is net gain/loss after cost basis and current value are considered.
            They are related but not the same metric.
          </Accordion.Body>
        </Accordion.Item>
      </Accordion>

      <Card className="shadow-sm">
        <Card.Body>
          <h2 className="h6 fw-semibold mb-2">Core Identity</h2>
          <div className="small">
            <strong>Total P&amp;L</strong> = <strong>Current Value</strong> + <strong>Cash Out (Realized Proceeds)</strong> - <strong>Cost Basis</strong>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
}
