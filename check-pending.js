const Database = require('better-sqlite3');
const db = new Database('data/investments.db');

// Check pending scopes timeline
const timeline = db.prepare(`
  SELECT 
    COUNT(*) as total_pending,
    MIN(created_at) as oldest_created,
    MAX(created_at) as newest_created,
    MAX(updated_at) as latest_updated
  FROM dirty_backfill_scope 
  WHERE status = 'pending'
`).get();

console.log('Pending dirty scopes timeline:');
console.log(JSON.stringify(timeline, null, 2));

// Check what reasons/sources created them
const bySource = db.prepare(`
  SELECT 
    dirty_reason,
    source_event_id,
    COUNT(*) as count,
    MAX(created_at) as created_at,
    MAX(updated_at) as updated_at
  FROM dirty_backfill_scope 
  WHERE status = 'pending'
  GROUP BY dirty_reason, source_event_id
  ORDER BY created_at DESC
`).all();

console.log('\nPending scopes grouped by reason/source:');
console.log(JSON.stringify(bySource, null, 2));
