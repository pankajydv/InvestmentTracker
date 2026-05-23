import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, ProgressBar, Spinner, Table } from 'react-bootstrap';
import { Download, RefreshCw } from 'lucide-react';
import { downloadLogFile, getComplianceJobs, getLogFiles } from '../services/api';

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
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobError, setJobError] = useState('');
  const [complianceJobs, setComplianceJobs] = useState([]);

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

  const loadComplianceJobs = async ({ activeOnly = false, silent = false } = {}) => {
    try {
      if (!silent) setJobsLoading(true);
      setJobError('');
      const data = await getComplianceJobs({ active: activeOnly, limit: 25 });
      setComplianceJobs(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch (e) {
      setJobError(e.message || 'Failed to load compliance jobs');
    } finally {
      if (!silent) setJobsLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;

    const tick = async () => {
      if (!mounted) return;
      await loadComplianceJobs({ activeOnly: false, silent: true });
    };

    loadComplianceJobs({ activeOnly: false, silent: false });
    const intervalId = window.setInterval(tick, 5000);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const stats = useMemo(() => {
    return { total: files.length };
  }, [files]);

  const activeJobs = complianceJobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const recentJobs = complianceJobs.slice(0, 8);

  const prettyMode = (mode) => {
    if (mode === 'full') return 'Deep';
    if (mode === 'incremental') return 'Fast';
    return mode || '-';
  };

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
          <div className="text-muted small">Daily rotated unified logs</div>
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
          <Badge bg="info">Unified: {stats.total}</Badge>
          {logDir ? <span className="small text-muted ms-auto">{logDir}</span> : null}
        </Card.Body>
      </Card>

      <Card className="shadow-sm border-0">
        <Card.Header className="bg-white d-flex justify-content-between align-items-center">
          <div className="fw-semibold">Compliance Jobs</div>
          <Button
            variant="outline-secondary"
            size="sm"
            onClick={() => loadComplianceJobs({ activeOnly: false, silent: false })}
            disabled={jobsLoading}
          >
            <RefreshCw size={14} className={`me-1 ${jobsLoading ? 'spinner-rotate' : ''}`} />
            Refresh
          </Button>
        </Card.Header>
        <Card.Body>
          {jobError ? <Alert variant="danger" className="mb-3">{jobError}</Alert> : null}

          {jobsLoading && complianceJobs.length === 0 ? (
            <div className="d-flex align-items-center gap-2 text-muted small">
              <Spinner size="sm" />
              Loading compliance jobs...
            </div>
          ) : (
            <>
              <div className="mb-3">
                <div className="small text-muted mb-2">Active</div>
                {activeJobs.length === 0 ? (
                  <div className="small text-muted">No active compliance jobs.</div>
                ) : (
                  <div className="d-flex flex-column gap-2">
                    {activeJobs.map((job) => (
                      <div key={job.id} className="border rounded p-2">
                        <div className="d-flex justify-content-between align-items-center mb-1">
                          <div className="small fw-semibold">
                            {job.id} • {prettyMode(job.mode)}
                          </div>
                          <Badge bg={job.status === 'running' ? 'primary' : 'secondary'}>{job.status}</Badge>
                        </div>
                        <div className="small text-muted mb-1">Phase: {job.phase || '-'}</div>
                        <ProgressBar now={Number(job.progressPct || 0)} label={`${Number(job.progressPct || 0)}%`} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="small text-muted mb-2">Recent</div>
                {recentJobs.length === 0 ? (
                  <div className="small text-muted">No compliance jobs yet.</div>
                ) : (
                  <Table size="sm" className="mb-0">
                    <thead>
                      <tr>
                        <th>Job ID</th>
                        <th>Mode</th>
                        <th>Status</th>
                        <th>Progress</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentJobs.map((job) => (
                        <tr key={job.id}>
                          <td className="text-break" style={{ maxWidth: 220 }}>{job.id}</td>
                          <td>{prettyMode(job.mode)}</td>
                          <td>
                            <Badge bg={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : 'primary'}>
                              {job.status}
                            </Badge>
                          </td>
                          <td>{Number(job.progressPct || 0)}%</td>
                          <td>{formatDateTime(job.finishedAt || job.startedAt || job.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </div>
            </>
          )}
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
                const isBusy = downloading === file.name;
                return (
                  <tr key={file.name}>
                    <td className="fw-semibold">{file.name}</td>
                    <td>Unified</td>
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
