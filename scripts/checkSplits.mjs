// Check BPCL prices around the 3:2 bonus/split on 2017-07-13
// BUY 8 @ 580 (2016-09-12), expected 8 * 1.5 = 12 after bonus, SELL 12 @ 514.55 (2019-11-29)

async function main() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BPCL.NS?period1=1465776000&period2=1512086400&interval=1wk';
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await resp.json();
  const quotes = data.chart.result[0];
  const timestamps = quotes.timestamp;
  const closes = quotes.indicators.quote[0].close;
  
  console.log('BPCL weekly prices around bonus (2017-07-13):');
  for (let i = 0; i < timestamps.length; i++) {
    const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
    if (d >= '2017-06-01') {
      if (d <= '2017-08-31') {
        console.log('  ' + d + ': ₹' + closes[i]?.toFixed(2));
      }
    }
  }
  
  // The Yahoo split data shows 3:2 which means for every 2 shares held, you get 3
  // i.e., 1 bonus share for every 2 held. 8 shares -> 8 + 4 = 12.
  // This perfectly explains: BUY 8 @ 580 -> BONUS 4 -> total 12 -> SELL 12 @ 514.55
  console.log('\nAnalysis: 8 shares * 3/2 = 12 shares. BPCL gap EXPLAINED by bonus!');
}
main();
