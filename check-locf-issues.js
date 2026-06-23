const Database = require('better-sqlite3');
const db = new Database('data/investments.db');

// Check what LOCF issues were detected
const locfIssues = db.prepare(`
  SELECT 
    ddg.investment_id,
    i.name,
    i.asset_type,
    ddg.portfolio_id,
    ddg.gap_start_date,
    ddg.gap_end_date,
    ddg.expected_rows,
    ddg.actual_rows,
    ddg.issue_type,
    ddg.locf_applied_count,
    ddg.detected_at,
    ddg.resolved_at
  FROM daily_data_gaps ddg
  JOIN investments i ON i.id = ddg.investment_id
  WHERE ddg.issue_type LIKE '%locf%' 
     OR ddg.issue_type LIKE '%LOCF%'
  ORDER BY ddg.detected_at DESC
  LIMIT 30
`).all();

console.log('Recent LOCF-related gaps detected:');
console.log(JSON.stringify(locfIssues, null, 2));

// Also check dirty scopes with locf-lag-signal reason
const locfDirtyScopesCount = db.prepare(`
  SELECT 
    COUNT(*) as count,
    dirty_reason,
    source_event_id
  FROM dirty_backfill_scope
  WHERE dirty_reason LIKE '%locf%'
  GROUP BY dirty_reason, source_event_id
  ORDER BY COUNT(*) DESC
`).all();

console.log('\n\nDirty scopes marked for LOCF issues:');
console.log(JSON.stringify(locfDirtyScopesCount, null, 2));

// Check if there's a config or documentation about LOCF strategies
const locfConfig = db.prepare(`
  SELECT key, value FROM config WHERE key LIKE '%locf%' OR key LIKE '%LOCF%'
`).all();

console.log('\n\nLOCF Configuration:');
console.log(JSON.stringify(locfConfig, null, 2));
