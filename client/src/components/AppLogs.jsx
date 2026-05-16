import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Spinner, Table } from 'react-bootstrap';
import { Download, RefreshCw } from 'lucide-react';
import { downloadLogFile, getLogFiles } from '../services/api';

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export default function AppLogs() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [files, setFiles] = useState([]);
  const [logDir, setLogDir] = useState('');
  const [downloading, setDownloading] = useState('');

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      setError('');
      const data = await getLogFiles();
      setFiles(Array.isArray(data?.files) ? data.files : []);
      setLogDir(data?.log_dir || '');
    } catch (e) {
      setError(e.message || 'Failed to load log files');
    } finally {
      if (isRefresh) setRefreshing(false);
      else setLoading(false);
    }
  };

  useEffect(() => {
    load(false);
  }, []);

  const stats = useMemo(() => {
    const appCount = files.filter((f) => String(f.name || '').startsWith('app-')).length;
    const backfillCount = files.filter((f) => String(f.name || '').startsWith('backfill-')).length;
    return { appCount, backfillCount, total: files.length };
  }, [files]);

  const handleDownload = async (name) => {
    setDownloading(name);
    try {
      await downloadLogFile(name);
    } catch (e) {
      alert(`Download failed: ${e.message}`);
    } finally {
      setDownloading('');
    }
  };

  if (loading) {
    return (
      <Card className="shadow-sm border-0">
        <Card.Body className="d-flex align-items-center gap-2">
          <Spinner size="sm" />
          <span className="text-muted">Loading logs...</span>
        </Card.Body>
      </Card>
    );
  }

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2">
        <div>
          <h4 className="mb-1">App Logs</h4>
          <div className="text-muted small">Daily rotated app and backfill logs</div>
        </div>
        <Button variant="outline-secondary" size="sm" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw size={14} className={`me-1 ${refreshing ? 'spinner-rotate' : ''}`} />
          Refresh
        </Button>
      </div>

      {error ? <Alert variant="danger" className="mb-0">{error}</Alert> : null}

      <Card className="shadow-sm border-0">
        <Card.Body className="d-flex flex-wrap gap-2 align-items-center">
          <Badge bg="primary">Total: {stats.total}</Badge>
          <Badge bg="info">App: {stats.appCount}</Badge>
          <Badge bg="warning" text="dark">Backfill: {stats.backfillCount}</Badge>
          {logDir ? <span className="small text-muted ms-auto">{logDir}</span> : null}
        </Card.Body>
      </Card>

      <Card className="shadow-sm border-0">
        <Card.Body className="p-0">
          <Table responsive hover className="mb-0 align-middle">
            <thead>
              <tr>
                <th style={{ width: '45%' }}>File</th>
                <th style={{ width: '20%' }}>Type</th>
                <th style={{ width: '15%' }}>Size</th>
                <th style={{ width: '20%' }}>Updated</th>
                <th style={{ width: 110 }} className="text-end">Action</th>
              </tr>
            </thead>
            <tbody>
              {files.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center text-muted py-4">No log files found.</td>
                </tr>
              ) : files.map((file) => {
                const isApp = String(file.name || '').startsWith('app-');
                const isBusy = downloading === file.name;
                return (
                  <tr key={file.name}>
                    <td className="fw-semibold">{file.name}</td>
                    <td>{isApp ? 'App' : 'Backfill'}</td>
                    <td>{formatBytes(file.size_bytes)}</td>
                    <td>{formatDateTime(file.updated_at)}</td>
                    <td className="text-end">
                      <Button
                        variant="outline-primary"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => handleDownload(file.name)}
                      >
                        <Download size={14} className="me-1" />
                        {isBusy ? '...' : 'Get'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card.Body>
      </Card>
    </div>
  );
}
