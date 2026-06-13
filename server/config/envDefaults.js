const fs = require('fs');
const path = require('path');

let alreadyApplied = false;

function normalizeAppMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'dev' || raw === 'development') return 'dev';
  return 'production';
}

function toEnvString(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function resolveConfigPath() {
  const rootDir = path.join(__dirname, '..', '..');
  const explicit = process.env.INVESTTRACK_CONFIG;
  const hasExplicitAppMode = process.env.APP_MODE != null && String(process.env.APP_MODE).trim() !== '';
  const mode = hasExplicitAppMode
    ? normalizeAppMode(process.env.APP_MODE)
    : (String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'production' : 'dev');

  const modeFileName = mode === 'dev' ? 'investtrack-dev.json' : 'investtrack-prod.json';

  const rootCandidates = [path.join(rootDir, 'configs', modeFileName)];
  const cwdCandidates = [path.join(process.cwd(), 'configs', modeFileName)];
  const rootFlatCandidates = [path.join(rootDir, modeFileName)];
  const cwdFlatCandidates = [path.join(process.cwd(), modeFileName)];

  const candidates = [
    explicit,
    ...rootCandidates,
    ...rootFlatCandidates,
    ...cwdCandidates,
    ...cwdFlatCandidates,
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function readEnvDefaults() {
  const configPath = resolveConfigPath();
  if (!configPath) return { envDefaults: null, configPath: null };

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const envDefaults = parsed && typeof parsed.envDefaults === 'object' ? parsed.envDefaults : null;
    return { envDefaults, configPath };
  } catch (err) {
    console.error(`[EnvDefaults] Failed to read config ${configPath}: ${err.message}`);
    return { envDefaults: null, configPath };
  }
}

function applyEnvDefaults(options = {}) {
  const force = options.force === true;
  if (alreadyApplied && !force) return { applied: false, count: 0, configPath: null };

  const { envDefaults, configPath } = readEnvDefaults();
  if (!envDefaults || !Object.keys(envDefaults).length) {
    alreadyApplied = true;
    return { applied: false, count: 0, configPath };
  }

  let count = 0;
  for (const [key, value] of Object.entries(envDefaults)) {
    if (force || process.env[key] == null || process.env[key] === '') {
      process.env[key] = toEnvString(value);
      count += 1;
    }
  }

  alreadyApplied = true;
  return { applied: count > 0, count, configPath };
}

module.exports = {
  applyEnvDefaults,
};
