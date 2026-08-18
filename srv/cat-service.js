/**
 * SupplierService implementation.
 *
 * Every entity here is a *virtual* projection over Databricks: nothing is
 * persisted locally. Each READ handler follows the same shape —
 *
 *     query Databricks → map rows to CDS shape → filter → sort → page
 *
 * — which `serveFromDatabricks()` factors out, so adding a new dashboard
 * dataset is a ~10-line handler.
 *
 * Databricks object and column names live ONLY in srv/lib/dbx-config.js.
 */

'use strict';

const cds = require('@sap/cds');

const dbx = require('./lib/dbx');
const {
  fq, fqPpm, TABLES, SUPPLIER_COLUMNS: SC, SPEND_COLUMNS: SPC, PPM_COLUMNS: PPMC,
  OTD, COMPLIANCE_STANDARDS,
} = require('./lib/dbx-config');
const otd = require('./lib/otd');
const compliance = require('./lib/compliance');

const LOG = cds.log('supplier-service');

// ─── Base SQL for the confirmed views/tables ──────────────────────────
const SUPPLIER_SQL = `SELECT * FROM ${fq(TABLES.supplierList)}`;
const SPEND_SQL    = `SELECT * FROM ${fq(TABLES.spendByYear)}`;

// PPM lives in a separate reporting catalog/schema, hence fqPpm() not fq().
const PPM_SQL      = `SELECT * FROM ${fqPpm(TABLES.ppmData)}`;

// ─── Row mappers ────────────────────────────────────────────

const { clean, num, round, supplierIdFrom, monthShort } = dbx;

/** fiori_mv_supplier_list → SupplierService.Suppliers */
function mapSupplierRow(row) {
  const segment = clean(row[SC.segment]);
  const plant   = clean(row[SC.plant]);
  const vendor  = supplierIdFrom(row[SC.vendorNumber]);

  return {
    ID:               vendor,
    vendorNumber:     vendor,
    name:             clean(row[SC.name]),
    responsible:      clean(row[SC.responsible]),
    category:         clean(row[SC.category]),
    subcategory:      clean(row[SC.subcategory]),
    mainSupplies:     clean(row[SC.mainSupplies]),
    score:            num(row[SC.score]),
    nextReview:       clean(row[SC.nextReview]),
    complianceStatus: clean(row[SC.complianceStatus]),
    isTopSupplier:    row[SC.isTopSupplier] ?? false,

    // Flat text plus the projection aliases the UI already binds to.
    segmentText:      segment,
    plantText:        plant,
    segmentName:      segment,
    plantName:        plant,
    plantLocation:    SC.plantLocation ? clean(row[SC.plantLocation]) : null,

    activeQualityClaims: num(row[SC.activeQualityClaims]),
    currentPPM:          round(row[SC.currentPPM], 2),
    currentOTD:          round(row[SC.currentOTD], 2),
  };
}

/**
 * fiori_mv_spend_by_year → SupplierService.SpendData
 *
 * One row per vendor per year. supplier_ID is the vendor number, so the chart
 * on the object page filters with a plain key match — no name lookup.
 */
function mapSpendRow(row) {
  const vendor = supplierIdFrom(row[SPC.vendorNumber]);
  const year   = num(row[SPC.year]);

  return {
    ID:           [vendor, year].filter((v) => v !== null).join('-') || cds.utils.uuid(),
    supplier_ID:  vendor,
    vendorNumber: vendor,
    supplierName: clean(row[SPC.supplierName]),
    year,
    yearLabel:    year === null ? null : String(year),
    amount:       round(row[SPC.amount], 2),
  };
}

/**
 * bs_db_sql_bs_reporting.dbo.q_ppm_opm2 → SupplierService.PPMData
 *
 * `Cal. year / month` arrives as a single 'mm.yyyy' string (e.g. '04.2026').
 * It is split into numeric month/year plus a short calendar label ('Apr')
 * for chart axes, mirroring DeliveryData's month/monthLabel pair. Target has
 * no source column — the view carries only the actual PPM qty — so it is
 * fixed at the same 500 default the CDS field declares.
 */
function mapPpmRow(row) {
  const vendor = supplierIdFrom(row[PPMC.vendorNumber]);

  const raw = clean(row[PPMC.yearMonth]);
  const [monthPart, yearPart] = raw ? String(raw).split('.') : [null, null];
  const month = num(monthPart);
  const year  = num(yearPart);

  return {
    ID:          [vendor, year, month].filter((v) => v !== null).join('-') || cds.utils.uuid(),
    supplier_ID: vendor,
    year,
    month,
    monthLabel: monthShort(month),
    // 'YYYY-MM' — the monthly chart's dimension. monthLabel alone would merge
    // e.g. Apr 2024 and Apr 2025 into a single averaged column.
    yearMonth:  (year === null || month === null)
      ? null
      : `${year}-${String(month).padStart(2, '0')}`,
    ppm:        num(row[PPMC.ppm]),
    target:     500,
  };
}

// ─── Supplier index ─────────────────────────────────────────────────────────
//
// Suppliers.ID is SourceSystemVendorNumber, unique per row. Child views that
// carry the same column join on it directly. The index exists only for views
// that do NOT carry it and must fall back to matching on supplier name.
//
async function supplierIndex() {
  const rows = await dbx.query(SUPPLIER_SQL);

  /** @type {Map<string, string[]>} name → vendor numbers with that name */
  const nameToIds = new Map();
  /** @type {Set<string>} every known vendor number */
  const knownIds = new Set();

  for (const row of rows) {
    const id = supplierIdFrom(row[SC.vendorNumber]);
    if (!id) continue;
    knownIds.add(id);

    const name = clean(row[SC.name]);
    if (!name) continue;
    if (!nameToIds.has(name)) nameToIds.set(name, []);
    if (!nameToIds.get(name).includes(id)) nameToIds.get(name).push(id);
  }

  return { nameToIds, knownIds };
}

/**
 * Resolve a child row to Suppliers.ID(s).
 *
 * Prefers the row's own vendor-number column. Only when that column is absent
 * or unpopulated does it fall back to name matching — and a name can match
 * several vendor numbers, so the row is emitted once per match rather than
 * being arbitrarily assigned to one.
 *
 * @param {any[]} rows
 * @param {{nameToIds:Map<string,string[]>}} index
 * @param {(row:any, opts:{supplierId?:string}) => any} mapper
 * @param {string|null} vendorColumn  column on `rows` holding the vendor number
 */
function resolveSuppliers(rows, index, mapper, vendorColumn = 'vendor_number') {
  const out = [];
  for (const row of rows) {
    const direct = vendorColumn ? supplierIdFrom(row[vendorColumn]) : null;
    if (direct) { out.push(mapper(row, { supplierId: direct })); continue; }

    const ids = index.nameToIds.get(clean(row.supplier_name));
    if (!ids || !ids.length) {
      // Unknown to the supplier list — kept so data-quality gaps stay visible
      // rather than being silently dropped.
      out.push(mapper(row, {}));
      continue;
    }
    for (const id of ids) out.push(mapper(row, { supplierId: id }));
  }
  return out;
}

// ─── Generic in-memory OData handling ───────────────────────────────────────
//
// CAP cannot push $filter / $orderby / $top down into these hand-built result
// sets, so they are applied here over the mapped array.
//

/** Flatten a CQN where-clause into a list of { ref, op, val } comparisons. */
function extractComparisons(where) {
  const out = [];
  if (!Array.isArray(where)) return out;

  for (let i = 0; i < where.length; i++) {
    const token = where[i];
    if (token && token.xpr) { out.push(...extractComparisons(token.xpr)); continue; }
    if (!token || !token.ref) continue;

    const op = where[i + 1];
    const rhs = where[i + 2];
    if (typeof op !== 'string' || rhs === undefined || rhs === null) continue;
    if (!('val' in rhs)) continue;

    out.push({ ref: token.ref.join('_'), op: op.toLowerCase(), val: rhs.val });
    i += 2;
  }
  return out;
}

const COMPARE = {
  '=':  (a, b) => String(a ?? '') === String(b ?? ''),
  '==': (a, b) => String(a ?? '') === String(b ?? ''),
  '!=': (a, b) => String(a ?? '') !== String(b ?? ''),
  '<>': (a, b) => String(a ?? '') !== String(b ?? ''),
  '>':  (a, b) => Number(a) > Number(b),
  '>=': (a, b) => Number(a) >= Number(b),
  '<':  (a, b) => Number(a) < Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
  like: (a, b) => String(a ?? '').toLowerCase()
    .includes(String(b ?? '').replace(/%/g, '').toLowerCase()),
};

function applyFilter(rows, where) {
  const comparisons = extractComparisons(where);
  if (!comparisons.length) return rows;

  return rows.filter((row) => comparisons.every(({ ref, op, val }) => {
    // '<assoc>_ID' in CQN matches the same key shape in the mapped row.
    if (!(ref in row)) return true;
    const cmp = COMPARE[op];
    return cmp ? cmp(row[ref], val) : true;
  }));
}

/**
 * The parent key of a navigation-path read, e.g. /Suppliers('X')/spendData.
 *
 * That request compiles to CQN as SELECT.from.ref = [ { id, where }, 'spendData' ]
 * — the parent's key predicate lives in the FIRST ref segment's own `where`,
 * completely separate from SELECT.where (which only holds a $filter on the
 * target collection itself, if any). A handler that only reads SELECT.where —
 * as this one used to — never sees that predicate, so every Databricks-derived
 * child collection (SpendData, DeliveryData, …) reads as if unscoped: the same
 * full result for every supplier. Verified directly via cds.ql:
 *   SELECT.from("SupplierService.Suppliers[ID='X'].spendData").SELECT.from
 *   → { ref: [ { id: 'SupplierService.Suppliers',
 *                where: [{ref:['ID']}, '=', {val:'X'}] },
 *              'spendData' ] }
 *
 * @param {any} SELECT  req.query.SELECT
 * @returns {string|null} the parent Suppliers.ID, or null for a non-nav read
 */
function extractNavigationSupplierId(SELECT) {
  const segments = SELECT?.from?.ref;
  if (!Array.isArray(segments)) return null;

  for (const seg of segments) {
    if (seg && typeof seg === 'object' && Array.isArray(seg.where)) {
      const hit = extractComparisons(seg.where).find((c) => c.ref === 'ID' && c.op.startsWith('='));
      if (hit) return hit.val;
    }
  }
  return null;
}

function applyOrderBy(rows, orderBy) {
  if (!Array.isArray(orderBy) || !orderBy.length) return rows;

  return [...rows].sort((a, b) => {
    for (const term of orderBy) {
      const key = term.ref?.join('_');
      if (!key) continue;
      const dir = String(term.sort || 'asc').toLowerCase() === 'desc' ? -1 : 1;
      const av = a[key], bv = b[key];
      if (av === bv) continue;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp = (typeof av === 'number' && typeof bv === 'number')
        ? av - bv
        : String(av).localeCompare(String(bv));
      if (cmp) return cmp * dir;
    }
    return 0;
  });
}

// ─── $apply aggregation (groupby + aggregate) ───────────────────────────────
//
// Every chart on the dashboard (Spend Development, On Time Delivery, OTD at
// Danfoss Sites) is bound to an Analytics.AggregatedProperty, which Fiori
// Elements requests via OData's $apply=groupby((dim),aggregate(measure with
// fn as alias)). CAP's protocol adapter translates that into CQN — a
// SELECT.groupBy array plus aggregate function objects mixed into
// SELECT.columns — and normally the generic DB executor performs the actual
// grouping in SQL. These entities never reach the DB (custom READ handlers
// return fully-formed rows directly), so nothing else does that grouping.
// Without this, the response keeps the raw column name (e.g. `amount`)
// instead of the requested measure alias (`totalSpend`), the chart can't
// find the field it asked for, and it renders empty — dimension axis present,
// no bars.
//
// CQN shape verified directly via cds.ql:
//   columns: [ {ref:['year']}, {func:'sum', args:[{ref:['amount']}], as:'totalSpend'} ]
//   groupBy: [ {ref:['year']} ]

const AGGREGATE_FN = {
  sum:           (vals) => vals.reduce((s, v) => s + v, 0),
  average:       (vals) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null),
  avg:           (vals) => AGGREGATE_FN.average(vals),
  min:           (vals) => (vals.length ? Math.min(...vals) : null),
  max:           (vals) => (vals.length ? Math.max(...vals) : null),
  count:         (vals) => vals.length,
  countdistinct: (vals) => new Set(vals).size,
};

/**
 * Apply SELECT.groupBy + any aggregate columns over already-filtered rows.
 * Returns null when the query isn't an aggregation request (no groupBy), so
 * the caller falls back to the normal per-row path unchanged.
 *
 * @param {any[]} rows     filtered, mapped CDS rows
 * @param {any} SELECT     req.query.SELECT
 * @returns {any[]|null}
 */
function applyAggregation(rows, SELECT) {
  const groupBy = SELECT?.groupBy;
  if (!groupBy || !groupBy.length) return null;

  const groupKeys = groupBy.map((g) => g.ref.join('_'));
  // Fall back to the bare group-by fields if the request has no explicit
  // column list (uncommon, but keeps this from throwing on odd queries).
  const columns = SELECT?.columns?.length ? SELECT.columns : groupBy.map((g) => ({ ref: g.ref }));

  const groups = new Map();
  for (const row of rows) {
    const key = groupKeys.map((k) => row[k]).join('\x01');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const out = [];
  for (const groupRows of groups.values()) {
    const rec = {};
    for (const col of columns) {
      if (col.func) {
        const argRef = col.args?.[0]?.ref;
        const field = argRef ? argRef.join('_') : null;
        const vals = field
          ? groupRows.map((r) => r[field]).filter((v) => v !== null && v !== undefined)
          : groupRows;
        const fn = AGGREGATE_FN[String(col.func).toLowerCase()] || AGGREGATE_FN.sum;
        rec[col.as || col.func] = fn(vals);
      } else if (col.ref) {
        const key = col.ref.join('_');
        rec[col.as || key] = groupRows[0][key];
      }
    }
    out.push(rec);
  }
  return out;
}

/**
 * Build a READ handler for a Databricks-derived entity.
 *
 * @param {string} label   log label
 * @param {(req:any) => Promise<any[]>} load  returns fully mapped CDS rows
 * @param {{onDuplicate?: (id:string, row:any) => void}} [opts]
 */
function serveFromDatabricks(label, load, opts = {}) {
  return async function handler(req, next) {
    try {
      const all = dbx.dedupeIds(await load(req), opts.onDuplicate);

      // Single-key read (…/Entity('ID'))
      const keyRef = req.data && req.data.ID;
      if (keyRef) {
        const one = all.find((r) => r.ID === keyRef);
        return one || next();
      }

      const { SELECT } = req.query;

      // Scope to the parent supplier for navigation-path reads
      // (/Suppliers('X')/spendData) before anything else — this is what the
      // Spend Development chart, and any other supplier-scoped chart, is
      // actually reading through.
      const navSupplierId = extractNavigationSupplierId(SELECT);
      let rows = navSupplierId ? all.filter((r) => r.supplier_ID === navSupplierId) : all;
      rows = applyFilter(rows, SELECT?.where);

      const aggregated = applyAggregation(rows, SELECT);
      if (aggregated) rows = aggregated;

      rows = applyOrderBy(rows, SELECT?.orderBy);

      const total = rows.length;
      const skip = SELECT?.limit?.offset?.val ?? 0;
      const top  = SELECT?.limit?.rows?.val;

      const page = rows.slice(skip, top != null ? skip + top : undefined);
      page.$count = total;

      LOG.debug(`${label} READ total=${total} skip=${skip} top=${top} returned=${page.length}` +
        (aggregated ? ' (aggregated)' : ''));
      return page;
    } catch (err) {
      LOG.error(`${label} READ failed:`, err);
      return req.error(502, `Failed to fetch ${label} from Databricks: ${err.message}`);
    }
  };
}

// ─── OTD loading ────────────────────────────────────────────────────────────

/**
 * Monthly OTD, at two grains:
 *   plantName === null → all-sites roll-up (trend chart + KPI)
 *   plantName === 'X'  → that Danfoss site only (site filter)
 *
 * Actuals are trimmed to the trailing window, then the forecast tail is added
 * from the Databricks forecast view (or projected locally as a fallback).
 */
async function loadMonthlyOtd() {
  const [rows, index] = await Promise.all([
    dbx.query(otd.monthlyOtdSql()),
    supplierIndex(),
  ]);

  const perSite = resolveSuppliers(rows, index, (r, o) => otd.mapMonthlyRow(r, o));
  let mapped = otd.rollUpSites(perSite).concat(perSite);

  if (OTD.forecast.source === 'view') {
    try {
      const fcRows = await dbx.query(otd.forecastSql());
      const fcPerSite = resolveSuppliers(fcRows, index,
        (r, o) => otd.mapMonthlyRow(r, { ...o, isForecast: true }));
      mapped = mapped.concat(otd.rollUpSites(fcPerSite), fcPerSite);
    } catch (err) {
      // A missing or renamed forecast view must not break the whole dashboard.
      LOG.warn(
        `OTD forecast view ${TABLES.otdForecast} unavailable (${err.message}); ` +
        'falling back to a locally computed projection.'
      );
      mapped = mapped.concat(forecastPerGrain(mapped));
    }
  } else if (OTD.forecast.source === 'compute') {
    mapped = mapped.concat(forecastPerGrain(mapped));
  }

  return otd.trailingWindow(mapped);
}

/** Project each supplier × site series forward independently. */
function forecastPerGrain(actuals) {
  const out = [];
  const groups = otd.groupBy(actuals.filter((r) => !r.isForecast), otd.grainKey);
  for (const list of groups.values()) out.push(...otd.computeForecast(list));
  return out;
}

async function loadSiteOtd() {
  const [rows, index] = await Promise.all([
    dbx.query(otd.siteOtdSql()),
    supplierIndex(),
  ]);
  return resolveSuppliers(rows, index, (r, o) => otd.mapSiteRow(r, o));
}

/**
 * One KPI roll-up row per supplier. Built from the all-sites rows only —
 * feeding per-site rows in would count every month once per site.
 */
async function loadOtdSummary() {
  const monthly = (await loadMonthlyOtd()).filter((r) => !r.plantName);
  const groups = otd.groupBy(monthly, (r) => r.supplier_ID);
  return [...groups.entries()].map(([id, rows]) => otd.summarise(rows, id));
}

/**
 * The compliance table is keyed by aribaid, so complianceSql() joins it through
 * d_vendormaster to reach the SAP vendor number. The full supplier index (not
 * just the name map) is handed to the mapper because it decides between the
 * '01/1102524' and '1102524' spellings by checking which one the supplier list
 * actually carries.
 */
async function loadCompliance() {
  const [rows, index] = await Promise.all([
    dbx.query(compliance.complianceSql()),
    supplierIndex(),
  ]);

  const items = compliance.mapComplianceRows(rows, index);
  const matched = new Set(
    items.map((i) => i.supplier_ID).filter((id) => index.knownIds.has(id))
  ).size;

  LOG.info(
    `ComplianceItems: ${rows.length} joined row(s) → ${items.length} item(s) ` +
    `across ${matched} known supplier(s).`
  );
  if (rows.length && !matched) {
    LOG.warn(
      `No compliance row resolved to a supplier. Check that ${TABLES.compliance}.` +
      'aribaid matches d_vendormaster.aribaid, and that the resulting vendor ' +
      `number matches ${SC.vendorNumber} in ${TABLES.supplierList}.`
    );
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Service
// ═══════════════════════════════════════════════════════════════════════════

module.exports = cds.service.impl(async function () {

  // ─── Suppliers ────────────────────────────────────────────────────────────

  this.on('READ', 'Suppliers', serveFromDatabricks('Suppliers', async () => {
    const rows = await dbx.query(SUPPLIER_SQL);
    const mapped = rows.map(mapSupplierRow);

    const missing = mapped.filter((r) => !r.ID).length;
    if (missing) {
      LOG.warn(`${missing} supplier row(s) have no ${SC.vendorNumber}; ` +
        'they will get generated keys and child data will not attach.');
    }
    return mapped;
  }, {
    // The vendor number is expected to be unique. If it isn't, say so loudly
    // rather than quietly renaming keys and breaking every child join.
    onDuplicate: (id) => LOG.warn(
      `Duplicate ${SC.vendorNumber} "${id}" in ${TABLES.supplierList}. ` +
      'Suppliers.ID assumes it is unique — spend and OTD may attach to the wrong record.'
    ),
  }));

  // ─── Spend (yearly) ───────────────────────────────────────────────────────

  this.on('READ', 'SpendData', serveFromDatabricks('SpendData', async () => {
    const rows = await dbx.query(SPEND_SQL);
    // Ascending year so the column chart reads left-to-right without relying
    // on the client to sort.
    return rows.map(mapSpendRow).sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
  }));

  // ─── PPM (monthly) ───────────────────────────────────────────
  this.on('READ', 'PPMData', serveFromDatabricks('PPMData', async () => {
    const rows = await dbx.query(PPM_SQL);
    LOG.info(`PPMData: fetched ${rows.length} raw row(s) from Databricks (${TABLES.ppmData})`);
    if (rows.length) LOG.info('PPMData: sample raw row(s)', rows.slice(0, 3));

    const mapped = rows.map(mapPpmRow);
    LOG.info(`PPMData: mapped ${mapped.length} row(s) to CDS schema`);
    if (mapped.length) LOG.info('PPMData: sample mapped row(s)', mapped.slice(0, 3));

    // Ascending year/month so the trend chart reads left-to-right without
    // relying on the client to sort.
    return mapped.sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || (a.month ?? 0) - (b.month ?? 0));
  }));

  // ─── Dashboard datasets ───────────────────────────────────────────────────

  this.on('READ', 'DeliveryData',    serveFromDatabricks('DeliveryData', loadMonthlyOtd));
  this.on('READ', 'DeliveryBySite',  serveFromDatabricks('DeliveryBySite', loadSiteOtd));
  this.on('READ', 'OTDSummary',      serveFromDatabricks('OTDSummary', loadOtdSummary));
  this.on('READ', 'ComplianceItems', serveFromDatabricks('ComplianceItems', loadCompliance));

  // ─── Aggregate dashboard payload (one request, one render) ────────────────

  this.on('getDashboard', async (req) => {
    const supplierID = req.data?.supplierID || null;
    try {
      const [monthly, sites, complianceItems, suppliers] = await Promise.all([
        loadMonthlyOtd(),
        loadSiteOtd(),
        loadCompliance(),
        dbx.query(SUPPLIER_SQL).then((rows) => rows.map(mapSupplierRow)),
      ]);

      const forSupplier = (rows) =>
        (supplierID ? rows.filter((r) => r.supplier_ID === supplierID) : rows);

      const myMonthly = forSupplier(monthly)
        .sort((a, b) => otd.periodKey(a) - otd.periodKey(b));
      const mySites = forSupplier(sites)
        .sort((a, b) => (b.onTimePercent ?? -1) - (a.onTimePercent ?? -1));
      const myCompliance = forSupplier(complianceItems)
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

      // The KPI must come from the all-sites grain, otherwise each month would
      // be counted once per Danfoss site.
      const allSitesMonthly = myMonthly.filter((r) => !r.plantName);
      const supplier = suppliers.find((s) => s.ID === supplierID);

      return {
        supplierID,
        supplierName: supplier?.name ?? null,
        generatedAt: new Date().toISOString(),
        summary: otd.summarise(allSitesMonthly, supplierID),
        // Both grains: rows with plantName === null are the all-sites series
        // the charts default to; the rest back the site filter.
        monthly: myMonthly,
        sites: mySites,
        compliance: myCompliance,
        // Roll-up kept consistent with the per-standard card.
        complianceStatus: compliance.rollUp(myCompliance),
        thresholds: {
          target: OTD.target,
          warning: OTD.warning,
          critical: OTD.critical,
        },
        legend: {
          strict: OTD.windows.strict.label,
          tolerant: OTD.windows.tolerant.label,
        },
        standards: COMPLIANCE_STANDARDS.map((s) => s.label),
      };
    } catch (err) {
      LOG.error('getDashboard failed:', err);
      return req.error(502, `Failed to build dashboard: ${err.message}`);
    }
  });

  // ─── Cache control ────────────────────────────────────────────────────────

  this.on('refreshCache', async (req) => {
    dbx.invalidate(req.data?.scope);
    return req.data?.scope
      ? `Cache entries matching "${req.data.scope}" dropped.`
      : 'Databricks cache cleared.';
  });

  // ─── Legacy raw-data functions, kept for compatibility ────────────────────

  this.on('getData', async (req) => {
    try {
      const rows = await dbx.query(SUPPLIER_SQL);
      return rows.map(mapSupplierRow);
    } catch (err) {
      LOG.error('getData failed:', err);
      return req.error(502, `Failed to fetch data from Databricks: ${err.message}`);
    }
  });

  this.on('getSpendData', async (req) => {
    try {
      const rows = await dbx.query(SPEND_SQL);
      return rows.map(mapSpendRow);
    } catch (err) {
      LOG.error('getSpendData failed:', err);
      return req.error(502, `Failed to load spend data: ${err.message}`);
    }
  });
});

// Exposed for offline testing (test/aggregation.test.js) — the in-memory
// $filter / $apply implementation is exercised directly against CQN built
// with cds.ql, without booting a server.
module.exports.applyFilter = applyFilter;
module.exports.applyOrderBy = applyOrderBy;
module.exports.applyAggregation = applyAggregation;
module.exports.extractNavigationSupplierId = extractNavigationSupplierId;

module.exports.mapPpmRow = mapPpmRow;
module.exports.mapSpendRow = mapSpendRow;
module.exports.mapSupplierRow = mapSupplierRow;
module.exports.PPM_SQL = PPM_SQL;
