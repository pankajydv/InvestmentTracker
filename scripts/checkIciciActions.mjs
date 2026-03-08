// Check ICICI Prudential Life corporate actions (splits, dividends, bonuses) 2016-2020
// IPO was in Sep 2016
const url = 'https://query1.finance.yahoo.com/v8/finance/chart/ICICIPRULI.NS?period1=1472688000&period2=1577836800&events=splits,dividends&interval=1mo';

(async () => {
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await resp.json();
  const events = data.chart?.result?.[0]?.events;
  
  console.log('=== SPLITS ===');
  if (events?.splits) {
    for (const [ts, split] of Object.entries(events.splits)) {
      const date = new Date(parseInt(ts) * 1000).toISOString().split('T')[0];
      console.log(`  ${date}: ${split.numerator}:${split.denominator} (${split.splitRatio})`);
    }
  } else {
    console.log('  No splits found');
  }
  
  console.log('\n=== DIVIDENDS ===');
  if (events?.dividends) {
    for (const [ts, div] of Object.entries(events.dividends)) {
      const date = new Date(parseInt(ts) * 1000).toISOString().split('T')[0];
      console.log(`  ${date}: Rs ${div.amount}`);
    }
  } else {
    console.log('  No dividends found');
  }
})();
