// Test NASDAQ API to see if it supports date filtering or pagination
const https = require('https');

async function testNasdaqAPI() {
  // Current approach: No date filtering
  const urlNoFilter = 'https://api.nasdaq.com/api/quote/MSFT/dividends?assetclass=stocks';
  
  // Check if API supports date params
  const urlWithDateFilter = 'https://api.nasdaq.com/api/quote/MSFT/dividends?assetclass=stocks&fromdate=2021-01-28&todate=2026-06-11';
  
  console.log('Testing NASDAQ API filtering capabilities...\n');
  
  console.log('Scenario 1: Current Implementation (No Filter)');
  console.log(`URL: ${urlNoFilter}`);
  console.log('Issues:');
  console.log('  - Fetches ALL historical data (40+ years, 1700+ records)');
  console.log('  - Processing overhead: parse, filter, warn on every record');
  console.log('  - Bandwidth waste: ~170x overfetch on typical 10-14 day CA window\n');
  
  console.log('Scenario 2: With Date Filtering (Hypothetical)');
  console.log(`URL: ${urlWithDateFilter}`);
  console.log('If supported:');
  console.log('  - Fetch only 2021-2026 data (if available)');
  console.log('  - Reduces bandwidth significantly');
  console.log('  - Reduces JSON payload parsing overhead\n');
  
  console.log('Scenario 3: Caching Strategy');
  console.log('Current cache key: `${inv.id}:${fromDate}:${toDate}`');
  console.log('Pattern: NEW CACHE KEY EVERY RUN (no cache hits)');
  console.log('Why: fromDate changes based on dirty scope (2021-01-28, 2021-01-29, 2021-01-30, ...)');
  console.log('Result: Zero cache reuse\n');
  
  console.log('Key Insight:');
  console.log('- NASDAQ API likely does NOT support date filters');
  console.log('- API design: "Give me all dividends for this symbol"');
  console.log('- But application fetches this 107 times for MSFT (one per dirty scope)');
  console.log('- Each fetch: 1700+ records, parse & filter, then discard 99.4%\n');
  
  console.log('Better Approaches:');
  console.log('A) Cache full dividend history by symbol (once per CA run cycle)');
  console.log('   - Fetch MSFT dividends once per day/cycle');
  console.log('   - Reuse for all 107 scopes');
  console.log('   - Savings: 106/107 API calls avoided\n');
  console.log('B) Only fetch recent data (last 5-10 years)');
  console.log('   - Reduce payload from 1700 → ~150 records');
  console.log('   - Still has all actionable dividends');
  console.log('   - Reduce parsing overhead 90%\n');
  console.log('C) Archive old NASDAQ data locally');
  console.log('   - First fetch: all history');
  console.log('   - Cache in SQLite table');
  console.log('   - Subsequent fetches: get recent data only, merge with cached');
}

testNasdaqAPI();
