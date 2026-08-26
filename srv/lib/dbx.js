
'use strict';

const cds = require('@sap/cds');
const { DBSQLClient } = require('@databricks/sql');
const { CACHE } = require('./dbx-config');

const LOG = cds.log('databricks');

const MAX_ERROR_DETAIL = 2000;

function errorText(err) {
  if (!err) return '';
  const seen = new Set();
  const parts = [];
  const push = (v) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    parts.push(t);
  };
  push(err.message);
  push(err.code);
  push(err.response && err.response.displayMessage);
  push(err.response && err.response.sqlState);
  push(err.response && err.response.errorMessage);
  return parts.join('\n');
}

function objectFrom(sqlText) {
  if (typeof sqlText !== 'string') return null;
  const m = sqlText.match(
    /(?:FROM|JOIN|DESCRIBE\s+TABLE|INTO)\s+([A-Za-z0-9_]+\.[A-Za-z0-9_]+\.`?[A-Za-z0-9_]+`?)/i
  );
  return m ? m[1].replace(/`/g, '') : null;
}

const ERROR_RULES = [
  {
    code   : 'SOURCE_UNREACHABLE',
    status : 503,
    test   : /FAILED_JDBC|SQLSTATE:\s*HV000|Failed to connect to the database/i,
    message: (ctx) =>
      `The source database behind ${ctx.catalog ? `the "${ctx.catalog}" catalog` : 'the federated catalog'} ` +
      'is not reachable from Databricks. This is a data-source outage, not an application error - ' +
      'check the Unity Catalog connection credentials, the database server status and its network access.',
  },
  {
    code   : 'NOT_CONFIGURED',
    status : 503,
    test   : /Missing Databricks config/i,
    message: () =>
      'Databricks is not configured for this environment. Set DATABRICKS_SERVER_HOSTNAME, ' +
      'DATABRICKS_HTTP_PATH and DATABRICKS_TOKEN in .env.',
  },
  {
    code   : 'UNAUTHORIZED',
    status : 502,
    test   : /Invalid access token|\bHTTP 40[13]\b|statusCode.?.?40[13]|PERMISSION_DENIED|UNAUTHORIZED|INSUFFICIENT_PERMISSIONS|token (?:has )?expired|expired token/i,
    message: (ctx) =>
      `Databricks rejected the request as unauthorised${ctx.object ? ` for ${ctx.object}` : ''}. ` +
      'The access token may have expired, or the principal is missing rights on the catalog.',
  },
  {
    code   : 'OBJECT_NOT_FOUND',
    status : 502,
    test   : /TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|CATALOG_NOT_FOUND|cannot be found|does not exist/i,
    message: (ctx) =>
      `${ctx.object || 'The requested table'} does not exist in Databricks. ` +
      'Check TABLES / catalog settings in srv/lib/dbx-config.js.',
  },
  {
    code   : 'COLUMN_MISMATCH',
    status : 500,
    test   : /has no column matching/i,
    message: (ctx, detail) => detail.split('\n')[0],
  },
  {
    code   : 'WAREHOUSE_UNAVAILABLE',
    status : 503,
    test   : /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|TEMPORARILY_UNAVAILABLE|starting/i,
    message: () =>
      'The Databricks SQL warehouse could not be reached. It may be stopped, starting up, ' +
      'or blocked by the network.',
  },
];

const FALLBACK_RULE = {
  code   : 'QUERY_FAILED',
  status : 502,
  message: (ctx, detail) => {
    const first = (detail.split('\n')[0] || 'Unknown error').slice(0, 300);
    return `Databricks query failed${ctx.object ? ` for ${ctx.object}` : ''}: ${first}`;
  },
};

function classifyError(err, context = {}) {
  const detail = errorText(err);
  const object = context.object || objectFrom(err && err.dbxSql) || null;
  const catalog = object ? object.split('.')[0] : null;
  const ctx = { ...context, object, catalog };

  const rule = ERROR_RULES.find((r) => r.test.test(detail)) || FALLBACK_RULE;

  return {
    code    : rule.code,
    status  : rule.status,
    message : rule.message(ctx, detail),
    object,
    catalog,
    detail  : detail.slice(0, MAX_ERROR_DETAIL),
  };
}

const cache = new Map();
const inFlight = new Map();

function cacheGet(key) {
  if (!CACHE.enabled) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.rows;
}

function cacheSet(key, rows) {
  if (!CACHE.enabled) return;
  cache.set(key, { expires: Date.now() + CACHE.ttlMs, rows });
}

function invalidate(substring) {
  if (!substring) return cache.clear();
  for (const key of cache.keys()) {
    if (key.includes(substring)) cache.delete(key);
  }
}

function requireConfig() {
  const host  = process.env.DATABRICKS_SERVER_HOSTNAME;
  const path  = process.env.DATABRICKS_HTTP_PATH;
  const token = process.env.DATABRICKS_TOKEN;

  if (!host || !path || !token) {
    throw new Error(
      'Missing Databricks config. Set DATABRICKS_SERVER_HOSTNAME, ' +
      'DATABRICKS_HTTP_PATH and DATABRICKS_TOKEN in .env'
    );
  }
  return { host, path, token };
}

async function runStatement(sqlText, maxRows) {
  const { host, path, token } = requireConfig();
  const client = new DBSQLClient();
  let session;

  const started = Date.now();
  try {
    await client.connect({ token, host, path });
    session = await client.openSession();

    const operation = await session.executeStatement(sqlText, {
      runAsync: true,
      maxRows: maxRows ?? CACHE.maxRows,
    });

    const rows = await operation.fetchAll();
    await operation.close();

    LOG.info(`query ok  ${rows.length} rows  ${Date.now() - started}ms`);
    return rows;
  } catch (err) {
    try { if (err && !err.dbxSql) err.dbxSql = sqlText; } catch { }
    throw err;
  } finally {
    if (session) { try { await session.close(); } catch {  } }
    try { await client.close(); } catch {  }
  }
}

async function query(sqlText, options = {}) {
  const key = sqlText;

  if (!options.noCache) {
    const cached = cacheGet(key);
    if (cached) {
      LOG.debug(`cache hit (${cached.length} rows)`);
      return cached;
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const promise = runStatement(sqlText, options.maxRows)
    .then((rows) => {
      if (!options.noCache) cacheSet(key, rows);
      return rows;
    })
    .finally(() => inFlight.delete(key));

  if (!options.noCache) inFlight.set(key, promise);
  return promise;
}

const col = (name) => '`' + String(name).replace(/`/g, '``') + '`';

// Separator-insensitive: "Source system ID", "source_system_id" and
// "SourceSystemID" all normalise to "sourcesystemid", so a rename that only
// changes casing or separators no longer silently yields null columns.
const normaliseColumn = (name) => String(name ?? '')
  .normalize('NFKC')
  .replace(/[\u200B-\u200D\uFEFF]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

const describeColumn = (name) => String(name ?? '').replace(
  /[^\x20-\x7E]/g,
  (ch) => `<U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`
);

async function columnsOf(fqTable) {
  const rows = await query(`DESCRIBE TABLE ${fqTable}`);
  const names = [];
  for (const row of rows) {
    const raw = row.col_name ?? row.COL_NAME ?? Object.values(row)[0];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) break;
    names.push(raw);
  }
  return names;
}

async function resolveColumns(fqTable, wanted) {
  const actual = await columnsOf(fqTable);
  const byNormalised = new Map();
  for (const name of actual) {
    const key = normaliseColumn(name);
    if (!byNormalised.has(key)) byNormalised.set(key, name);
  }

  const resolved = {};
  const missing = [];
  for (const [key, configured] of Object.entries(wanted)) {
    if (configured === null || configured === undefined) {
      resolved[key] = null;
      continue;
    }
    const hit = byNormalised.get(normaliseColumn(configured));
    if (hit === undefined) {
      resolved[key] = null;
      missing.push(configured);
    } else {
      resolved[key] = hit;
      if (hit !== configured) {
        LOG.info(
          `column "${configured}" resolved to "${describeColumn(hit)}" in ${fqTable}`
        );
      }
    }
  }
  return { resolved, missing, actual };
}

function pick(row, name) {
  if (row == null || name == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const target = normaliseColumn(name);
  for (const key of Object.keys(row)) {
    if (normaliseColumn(key) === target) return row[key];
  }
  return undefined;
}

const clean = (v) => (typeof v === 'string' ? v.trim() : v);

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round = (v, dp = 2) => {
  const n = num(v);
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

const slug = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const supplierIdFrom = (vendorNumber) => {
  const v = clean(vendorNumber);
  return v === null || v === undefined || v === '' ? null : String(v);
};

const makeSupplierId = (row, columns) =>
  supplierIdFrom(row[columns?.vendorNumber || 'SourceSystemVendorNumber']);

function dedupeIds(rows, onDuplicate) {
  const seen = Object.create(null);
  for (const r of rows) {
    if (!r.ID) r.ID = cds.utils.uuid();
    if (seen[r.ID] === undefined) {
      seen[r.ID] = 0;
    } else {
      if (onDuplicate) onDuplicate(r.ID, r);
      r.ID = `${r.ID}-${++seen[r.ID]}`;
    }
  }
  return rows;
}

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

const yearMonth = (year, month) =>
  year == null || month == null ? null : `${year}-${String(month).padStart(2, '0')}`;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const monthName = (month) => MONTH_NAMES[Number(month) - 1] || null;
const monthShort = (month) => (monthName(month) || '').slice(0, 3) || null;

module.exports = {
  query,
  invalidate,
  classifyError,
  errorText,
  col,
  normaliseColumn,
  describeColumn,
  columnsOf,
  resolveColumns,
  pick,
  clean,
  num,
  round,
  slug,
  makeSupplierId,
  supplierIdFrom,
  dedupeIds,
  lit,
  yearMonth,
  monthName,
  monthShort,
};
