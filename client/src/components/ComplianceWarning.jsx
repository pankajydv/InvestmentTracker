import React, { useState, useEffect } from 'react';
import { Alert, Button, Modal, Table, Spinner } from 'react-bootstrap';
import { AlertTriangle } from 'lucide-react';

export function ComplianceWarning({ gaps, loading }) {
  const [showDetails, setShowDetails] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Re-show the banner whenever the set of gaps changes.
  const gapsSignature = (gaps || []).length;
  useEffect(() => {
    setDismissed(false);
  }, [gapsSignature]);

  if (loading) return null;
  if (!gaps || gaps.length === 0) return null;
  if (dismissed) return null;

  return (
    <>
      <Alert
        variant="warning"
        dismissible
        onClose={() => setDismissed(true)}
        className="d-flex align-items-center justify-content-between gap-2"
      >
        <div className="d-flex align-items-center gap-2">
          <AlertTriangle size={20} className="text-warning" />
          <span>
            <strong>{gaps.length} missing data gap{gaps.length !== 1 ? 's' : ''} detected</strong> - 
            Check the details to see what date ranges are missing. The next scheduler run will automatically fill these gaps.
          </span>
        </div>
        <Button variant="outline-warning" size="sm" onClick={() => setShowDetails(true)}>
          View Details
        </Button>
      </Alert>

      <Modal show={showDetails} onHide={() => setShowDetails(false)} size="lg" centered>
        <Modal.Header closeButton>
          <Modal.Title>Missing Data Gaps</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Table size="sm" striped bordered>
            <thead>
              <tr>
                <th>Table</th>
                <th>Entity ID</th>
                <th>Gap Start Date</th>
                <th>Gap End Date</th>
                <th>Detected</th>
              </tr>
            </thead>
            <tbody>
              {gaps.map((gap, idx) => (
                <tr key={idx}>
                  <td>{gap.table_name}</td>
                  <td>{gap.entity_id}</td>
                  <td>{gap.gap_start_date}</td>
                  <td>{gap.gap_end_date}</td>
                  <td>{new Date(gap.detected_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowDetails(false)}>Close</Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
