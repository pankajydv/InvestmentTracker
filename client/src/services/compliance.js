// API client for compliance scan and gap reporting
import api from './api';

export async function triggerComplianceScan(mode = 'full') {
  const query = mode ? `?mode=${encodeURIComponent(String(mode))}` : '';
  const res = await api.post(`/compliance/scan${query}`);
  return res.data;
}

export async function getOpenGaps() {
  const res = await api.get('/compliance/open-gaps');
  return res.data;
}

export async function getComplianceStatus(runDate) {
  const query = runDate ? `?run_date=${encodeURIComponent(String(runDate))}` : '';
  const res = await api.get(`/utils/compliance-status${query}`);
  return res.data;
}

export async function createComplianceJob(mode = 'incremental', runDate) {
  const payload = { mode };
  if (runDate) payload.run_date = runDate;
  const res = await api.post('/utils/compliance-jobs', payload);
  return res.data;
}

export async function getComplianceJobs({ active = false, limit } = {}) {
  const params = new URLSearchParams();
  if (active) params.set('active', 'true');
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) params.set('limit', String(Math.floor(Number(limit))));
  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await api.get(`/utils/compliance-jobs${query}`);
  return res.data;
}

export async function getComplianceJob(jobId) {
  const safeId = encodeURIComponent(String(jobId || '').trim());
  const res = await api.get(`/utils/compliance-jobs/${safeId}`);
  return res.data;
}
