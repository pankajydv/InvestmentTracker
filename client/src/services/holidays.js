// API client for market holidays and weekends
import api from './api';

export async function getMarketHolidays(year) {
  const res = await api.get(`/holidays/${year}`);
  return res.data.holidays;
}

export async function getWeekends(year) {
  const res = await api.get(`/holidays/${year}/weekends`);
  return res.data.weekends;
}

export async function syncMarketHolidays(year, holidays) {
  const res = await api.post('/holidays/sync', { year, holidays });
  return res.data;
}
