/**
 * Databricks SQL access layer.
 *
 * Responsibilities:
 *   - one connection helper instead of the ad-hoc client in cat-service.js
 *   - TTL cache so a single dashboard render doesn't open five warehouse
 *     sessions for the same query
 *   - in-flight de-duplication (concurrent identical queries share a promise)
 *   - small helpers used by every handler: clean/num/slug/makeSupplierId
 *
 * Nothing here knows about business meaning — see otd.js / compliance.js.
 */

'use strict';

const cds = require('@sap/cds');
const { DBSQLClient } = require('@databricks/sql');
const { CACHE } = require('./dbx-config');

const LOG = cds.log('databricks');

// ─── Cache ──────────────────────────────────────────────────────────────────

/** @type {Map<string, {expires:number, rows:any[]}>} */
const cache = new Map();
/** @type {Map<string, Promise<any[]>>} */
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

/** Drop everything, or every key containing `substring`. */
function invalidate(substring) {
  if (!substring) return cache.clear();
  for (const key of cache.keys()) {
    if (key.includes(substring)) cache.delete(key);
  }
}

// ─── Query ──────────────────────────────────────────────────────────────────

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
  } finally {
    if (session) { try { await session.close(); } catch { /* ignore */ } }
    try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * Execute SQL against the warehouse, with caching and in-flight de-duplication.
 *
 * @param {string} sqlText
 * @param {{maxRows?:number, noCache?:boolean}} [options]
 * @returns {Promise<any[]>} array of plain objects
 */
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

// ─── Value helpers ──────────────────────────────────────────────────────────

const clean = (v) => (typeof v === 'string' ? v.trim() : v);

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Round a numeric to `dp` decimal places, preserving null. */
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

/**
 * Suppliers.ID is the Databricks business key, SourceSystemVendorNumber, used
 * verbatim. It is unique per row in fiori_mv_supplier_list, and the spend and
 * compliance views carry the same column — so child rows join on it directly,
 * with no name matching and no synthetic composite.
 *
 * Only whitespace is trimmed; the value is otherwise untouched so it stays
 * traceable back to the source system.
 */
const supplierIdFrom = (vendorNumber) => {
  const v = clean(vendorNumber);
  return v === null || v === undefined || v === '' ? null : String(v);
};

const makeSupplierId = (row, columns) =>
  supplierIdFrom(row[columns?.vendorNumber || 'SourceSystemVendorNumber']);

/**
 * Make IDs unique in place, appending -1, -2 … to duplicates.
 *
 * With SourceSystemVendorNumber as the key this should be a no-op for
 * Suppliers; `onDuplicate` fires if it isn't, because silently renaming a
 * vendor key would hide a data-quality problem in the source view.
 */
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

/**
 * SQL-quote a string literal for safe inline interpolation.
 * Only used for values we build ourselves (never raw user input paths).
 */
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** `YYYY-MM` from year + month. */
const yearMonth = (year, month) =>
  year == null || month == null ? null : `${year}-${String(month).padStart(2, '0')}`;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const monthName = (month) => MONTH_NAMES[Number(month) - 1] || null;
const monthShort = (month) => (monthName(month) || '').slice(0, 3) || null;

module.exports = {
  query,
  invalidate,
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
