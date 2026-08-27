
'use strict';

const cds = require('@sap/cds');

const dbx = require('./lib/dbx');
const {
  fq, fqg, fqPpm, TABLES, SUPPLIER_COLUMNS: SC, SPEND_COLUMNS: SPC, PPM_COLUMNS: PPMC,
  OPM_COLUMNS: OPMC, OTD_COLUMNS: OTDC,

  OTD, COMPLIANCE_STANDARDS,
} = require('./lib/dbx-config');
const otd = require('./lib/otd');
const compliance = require('./lib/compliance');

const LOG = cds.log('supplier-service');

const SUPPLIER_SQL = `SELECT * FROM ${fqg(TABLES.supplierList)}`;

function lazySql(label, build) {
  let pending = null;
  return function sql() {
    if (!pending) {
      pending = Promise.resolve()
        .then(build)
        .then((text) => {
          LOG.info(`${label} SQL resolved:${text}`);
          return text;
        })
        .catch((err) => { pending = null; throw err; });
    }
    return pending;
  };
}

async function resolveOrThrow(label, fqTable, wanted) {
  const { resolved, missing, actual } = await dbx.resolveColumns(fqTable, wanted);
  if (missing.length) {
    LOG.error(
      `${label}: ${fqTable} has no column matching ${missing.map((m) => `"${m}"`).join(', ')}. ` +
      `Actual columns: ${actual.map((a) => `"${dbx.describeColumn(a)}"`).join(', ')}`
    );
    throw new Error(
      `${fqTable} has no column matching ${missing.map((m) => `"${m}"`).join(', ')}. ` +
      `Update ${label}_COLUMNS in srv/lib/dbx-config.js — the table has: ` +
      actual.map((a) => `"${dbx.describeColumn(a)}"`).join(', ')
    );
  }
  return resolved;
}

const opmSql = lazySql('OPM', async () => {
  const table = fqPpm(TABLES.ppmData);
  const c = await resolveOrThrow('OPM', table, {
    vendorNumber    : PPMC.vendorNumber,
    yearMonth       : OPMC.yearMonth,
    notifications   : OPMC.notifications,
    goodsReceiptQty : OPMC.goodsReceiptQty,
  });
  const { col } = dbx;
  return `
  SELECT
    ${col(c.vendorNumber)} AS vendor_number,
    ${col(c.yearMonth)}    AS year_month,
    SUM(${col(c.notifications)})   AS notifications,
    SUM(${col(c.goodsReceiptQty)}) AS goods_receipt_qty
  FROM ${table}
  GROUP BY ${col(c.vendorNumber)}, ${col(c.yearMonth)}`;
});

const otdSql = lazySql('OTD', async () => {
  const table = fqPpm(TABLES.otdData);
  const c = await resolveOrThrow('OTD', table, {
    sourceSystemId : OTDC.sourceSystemId,
    vendor         : OTDC.vendor,
    yearMonth      : OTDC.yearMonth,
    early3         : OTDC.early3,
    early2         : OTDC.early2,
    early1         : OTDC.early1,
    onTime         : OTDC.onTime,
    delay1         : OTDC.delay1,
    totalLines     : OTDC.totalLines,
  });
  const { col } = dbx;
  return `
  SELECT
    ${col(c.sourceSystemId)} AS source_system_id,
    ${col(c.vendor)}         AS vendor,
    ${col(c.yearMonth)}      AS year_month,
    SUM(${col(c.early3)})     AS early3,
    SUM(${col(c.early2)})     AS early2,
    SUM(${col(c.early1)})     AS early1,
    SUM(${col(c.onTime)})     AS on_time,
    SUM(${col(c.delay1)})     AS delay1,
    SUM(${col(c.totalLines)}) AS total_lines
  FROM ${table}
  GROUP BY ${col(c.sourceSystemId)}, ${col(c.vendor)}, ${col(c.yearMonth)}`;
});

const spendSql = lazySql('SPEND', async () => {
  const table = fqg(TABLES.spendByYear);
  const c = await resolveOrThrow('SPEND', table, {
    vendorNumber : SPC.vendorNumber,
    year         : SPC.year,
    amount       : SPC.amount,
    supplierName : SPC.supplierName,
  });
  const { col } = dbx;
  const name = c.supplierName
    ? `MAX(${col(c.supplierName)})`
    : 'CAST(NULL AS STRING)';

  return `
  SELECT
    ${col(c.vendorNumber)} AS vendor_number,
    ${name}                AS supplier_name,
    ${col(c.year)}         AS year,
    SUM(${col(c.amount)})  AS amount
  FROM ${table}
  WHERE ${col(c.vendorNumber)} IS NOT NULL
    AND ${col(c.year)} IS NOT NULL
  GROUP BY ${col(c.vendorNumber)}, ${col(c.year)}
  ORDER BY vendor_number, year`;
});

const PPM_SQL      = `SELECT * FROM ${fqPpm(TABLES.ppmData)}`;

const { clean, num, round, supplierIdFrom, monthShort, pick } = dbx;

function mapSupplierRow(row) {
  const segment = clean(pick(row, SC.segment));
  const plant   = clean(pick(row, SC.plant));
  const vendor  = supplierIdFrom(pick(row, SC.vendorNumber));

  return {
    ID:               vendor,
    vendorNumber:     vendor,
    name:             clean(pick(row, SC.name)),
    responsible:      clean(pick(row, SC.responsible)),
    category:         clean(pick(row, SC.category)),
    subcategory:      clean(pick(row, SC.subcategory)),
    mainSupplies:     clean(pick(row, SC.mainSupplies)),
    score:            num(pick(row, SC.score)),
    nextReview:       clean(pick(row, SC.nextReview)),
    complianceStatus: clean(pick(row, SC.complianceStatus)),
    isTopSupplier:    pick(row, SC.isTopSupplier) ?? false,
    segmentText:      segment,
    plantText:        plant,
    segmentName:      segment,
    plantName:        plant,
    plantLocation:    SC.plantLocation ? clean(pick(row, SC.plantLocation)) : null,

    activeQualityClaims: num(pick(row, SC.activeQualityClaims)),
    currentPPM:          round(pick(row, SC.currentPPM), 2),
    currentOTD:          round(pick(row, SC.currentOTD), 2),
  };
}

// Reads the aliases produced by spendSql(), not raw source column names.
function mapSpendRow(row) {
  const vendor = supplierIdFrom(pick(row, 'vendor_number'));
  const year   = num(pick(row, 'year'));

  return {
    ID:           [vendor, year].filter((v) => v !== null).join('-') || cds.utils.uuid(),
    supplier_ID:  vendor,
    vendorNumber: vendor,
    supplierName: clean(pick(row, 'supplier_name')) ?? null,
    year,
    yearLabel:    year === null ? null : String(year),
    amount:       round(pick(row, 'amount'), 2),
  };
}

function withSupplierName(rec, index) {
  if (!rec.supplierName && rec.supplier_ID && index && index.idToName) {
    rec.supplierName = index.idToName.get(rec.supplier_ID) ?? null;
  }
  return rec;
}

// Segment and Danfoss Plant live on the supplier list, not on the metric tables.
// Stamping them onto each child row is what lets the charts stack by them.
function withSupplierMeta(rec, index) {
  withSupplierName(rec, index);
  if (rec.supplier_ID && index) {
    if (rec.segmentName === undefined || rec.segmentName === null) {
      rec.segmentName = index.idToSegment?.get(rec.supplier_ID) ?? null;
    }
    if (rec.plantName === undefined || rec.plantName === null) {
      rec.plantName = index.idToPlant?.get(rec.supplier_ID) ?? null;
    }
  }
  // One combined series keeps a stacked column readable: two separate series
  // dimensions make sap.viz overlay the bars instead of stacking them.
  if (rec.segmentPlant === undefined || rec.segmentPlant === null) {
    const parts = [rec.segmentName, rec.plantName].filter(Boolean);
    rec.segmentPlant = parts.length ? parts.join(' / ') : null;
  }
  return rec;
}

// A supplier name can span several vendor numbers, one per segment/plant. The list
// shows one row per name, so the object page charts read every sibling vendor number
// and let the stack dimension separate them again.
async function siblingSupplierIds(supplierId) {
  const index = await supplierIndex();
  const name = index.idToName.get(supplierId);
  const ids = name ? index.nameToIds.get(name) : null;
  return new Set(ids && ids.length ? ids : [supplierId]);
}

function mapPpmRow(row) {
  const vendor = supplierIdFrom(pick(row, PPMC.vendorNumber));

  const raw = clean(pick(row, PPMC.yearMonth));
  const [monthPart, yearPart] = raw ? String(raw).split('.') : [null, null];
  const month = num(monthPart);
  const year  = num(yearPart);

  return {
    ID:          [vendor, year, month].filter((v) => v !== null).join('-') || cds.utils.uuid(),
    supplier_ID: vendor,
    year,
    month,
    monthLabel: monthShort(month),
    yearMonth:  (year === null || month === null)
      ? null
      : `${year}-${String(month).padStart(2, '0')}`,
    ppm:        num(pick(row, PPMC.ppm)),
    target:     500,
  };
}
function mapOpmRow(row) {
  const vendor = supplierIdFrom(row.vendor_number);

  const raw = clean(row.year_month);
  const [monthPart, yearPart] = raw ? String(raw).split('.') : [null, null];
  const month = num(monthPart);
  const year  = num(yearPart);

  const notifications   = num(row.notifications);
  const goodsReceiptQty = num(row.goods_receipt_qty);
  const opm = goodsReceiptQty
    ? Math.round((notifications / goodsReceiptQty) * 1000000)
    : null;

  return {
    ID:          [vendor, year, month].filter((v) => v !== null).join('-') || cds.utils.uuid(),
    supplier_ID: vendor,
    year,
    month,
    monthLabel:  monthShort(month),
    yearMonth:   dbx.yearMonth(year, month),
    opm,
  };
}

function mapOtdRow(row) {
  const sourceSystemId = clean(row.source_system_id);
  const vendorRaw      = clean(row.vendor);
  const hasBoth =
    sourceSystemId !== null && sourceSystemId !== undefined && sourceSystemId !== '' &&
    vendorRaw !== null && vendorRaw !== undefined && vendorRaw !== '';
  const vendor = supplierIdFrom(hasBoth ? `${sourceSystemId}/${vendorRaw}` : null);

  const raw = clean(row.year_month);
  const [monthPart, yearPart] = raw ? String(raw).split('.') : [null, null];
  const month = num(monthPart);
  const year  = num(yearPart);

  const totalLines  = num(row.total_lines);
  const onTimeLines = (num(row.early3) || 0)
    + (num(row.early2) || 0)
    + (num(row.early1) || 0)
    + (num(row.on_time) || 0)
    + (num(row.delay1) || 0);
  const otd = totalLines ? round(100 * onTimeLines / totalLines, 2) : null;

  return {
    ID:          [vendor, year, month].filter((v) => v !== null).join('-') || cds.utils.uuid(),
    supplier_ID: vendor,
    year,
    month,
    monthLabel:  monthShort(month),
    yearMonth:   dbx.yearMonth(year, month),
    otd,
  };
}

async function supplierIndex() {
  const rows = await dbx.query(SUPPLIER_SQL);

  const nameToIds = new Map();
  const idToName = new Map();
  const idToSegment = new Map();
  const idToPlant = new Map();
  const knownIds = new Set();

  for (const row of rows) {
    const id = supplierIdFrom(pick(row, SC.vendorNumber));
    if (!id) continue;
    knownIds.add(id);

    if (!idToSegment.has(id)) idToSegment.set(id, clean(pick(row, SC.segment)));
    if (!idToPlant.has(id)) idToPlant.set(id, clean(pick(row, SC.plant)));

    const name = clean(pick(row, SC.name));
    if (!name) continue;
    if (!idToName.has(id)) idToName.set(id, name);
    if (!nameToIds.has(name)) nameToIds.set(name, []);
    if (!nameToIds.get(name).includes(id)) nameToIds.get(name).push(id);
  }

  return { nameToIds, idToName, idToSegment, idToPlant, knownIds };
}

function resolveSuppliers(rows, index, mapper, vendorColumn = 'vendor_number') {
  const out = [];
  for (const row of rows) {
    const direct = vendorColumn ? supplierIdFrom(row[vendorColumn]) : null;
    if (direct) { out.push(mapper(row, { supplierId: direct })); continue; }

    const ids = index.nameToIds.get(clean(row.supplier_name));
    if (!ids || !ids.length) {
      out.push(mapper(row, {}));
      continue;
    }
    for (const id of ids) out.push(mapper(row, { supplierId: id }));
  }
  return out;
}

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
    if (!(ref in row)) return true;
    const cmp = COMPARE[op];
    return cmp ? cmp(row[ref], val) : true;
  }));
}

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

const AGGREGATE_FN = {
  sum:           (vals) => vals.reduce((s, v) => s + v, 0),
  average:       (vals) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null),
  avg:           (vals) => AGGREGATE_FN.average(vals),
  min:           (vals) => (vals.length ? Math.min(...vals) : null),
  max:           (vals) => (vals.length ? Math.max(...vals) : null),
  count:         (vals) => vals.length,
  countdistinct: (vals) => new Set(vals).size,
};

function applyAggregation(rows, SELECT) {
  const groupBy = SELECT?.groupBy;
  if (!groupBy || !groupBy.length) return null;

  const groupKeys = groupBy.map((g) => g.ref.join('_'));
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

// Collapses rows that share the same logical key (e.g. supplier name), keeping the
// first occurrence. Rows without a key are always kept — they cannot be judged duplicates.
function dedupeRows(rows, keyOf) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const raw = keyOf(row);
    const key = raw === null || raw === undefined ? '' : String(raw).trim().toLowerCase();
    if (!key) { out.push(row); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function failWith(req, err, where, subject) {
  const info = dbx.classifyError(err);
  const text = subject
    ? `Could not load ${subject}. ${info.message}`
    : info.message;

  LOG.error(`${where} failed [${info.code}] ${info.object || ''} - ${info.message}`);
  LOG.error(`${where} source error: ${info.detail}`);
  LOG.debug(`${where} stack:`, err);

  return req.error({ code: info.code, status: info.status, message: text });
}

function serveFromDatabricks(label, load, opts = {}) {
  return async function handler(req, next) {
    try {
      const all = dbx.dedupeIds(await load(req), opts.onDuplicate);

      const keyRef = req.data && req.data.ID;
      if (keyRef) {
        const one = all.find((r) => r.ID === keyRef);
        return one || next();
      }

      const { SELECT } = req.query;

      const navSupplierId = extractNavigationSupplierId(SELECT);
      let rows = all;
      if (navSupplierId) {
        const ids = opts.rollupByName
          ? await siblingSupplierIds(navSupplierId)
          : new Set([navSupplierId]);
        rows = all.filter((r) => ids.has(r.supplier_ID));
      }
      rows = applyFilter(rows, SELECT?.where);

      if (opts.dedupeBy) {
        const before = rows.length;
        rows = dedupeRows(rows, opts.dedupeBy);
        if (before !== rows.length) {
          LOG.debug(`${label} READ collapsed ${before - rows.length} duplicate row(s)`);
        }
      }

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
      return failWith(req, err, `${label} READ`, label);
    }
  };
}

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

async function loadOtdSummary() {
  const monthly = (await loadMonthlyOtd()).filter((r) => !r.plantName);
  const groups = otd.groupBy(monthly, (r) => r.supplier_ID);
  return [...groups.entries()].map(([id, rows]) => otd.summarise(rows, id));
}

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

module.exports = cds.service.impl(async function () {

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
    // One row per supplier name in the list; the object page still reads by ID.
    dedupeBy: (row) => row.name,
    onDuplicate: (id) => LOG.warn(
      `Duplicate ${SC.vendorNumber} "${id}" in ${TABLES.supplierList}. ` +
      'Suppliers.ID assumes it is unique — spend and OTD may attach to the wrong record.'
    ),
  }));

  this.on('READ', 'SpendData', serveFromDatabricks('SpendData', async () => {
    const [rows, index] = await Promise.all([
      dbx.query(await spendSql()),
      supplierIndex(),
    ]);

    const mapped = rows.map((row) => withSupplierMeta(mapSpendRow(row), index));
    const unkeyed = mapped.filter((r) => !r.supplier_ID).length;
    LOG.info(`SpendData: ${rows.length} aggregated row(s) from ${TABLES.spendByYear}` +
      (unkeyed ? `, ${unkeyed} without a vendor key` : ''));

    return mapped.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
  }, { rollupByName: true }));

  this.on('READ', 'PPMData', serveFromDatabricks('PPMData', async () => {
    const [rows, index] = await Promise.all([dbx.query(PPM_SQL), supplierIndex()]);
    LOG.info(`PPMData: fetched ${rows.length} raw row(s) from Databricks (${TABLES.ppmData})`);
    if (rows.length) LOG.info('PPMData: sample raw row(s)', rows.slice(0, 3));

    const mapped = rows.map((row) => withSupplierMeta(mapPpmRow(row), index));
    LOG.info(`PPMData: mapped ${mapped.length} row(s) to CDS schema`);
    if (mapped.length) LOG.info('PPMData: sample mapped row(s)', mapped.slice(0, 3));

    return mapped.sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || (a.month ?? 0) - (b.month ?? 0));
  }, { rollupByName: true }));
  this.on('READ', 'OPMData', serveFromDatabricks('OPMData', async () => {
    const [rows, index] = await Promise.all([dbx.query(await opmSql()), supplierIndex()]);
    return rows.map((row) => withSupplierMeta(mapOpmRow(row), index))
      .sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || (a.month ?? 0) - (b.month ?? 0));
  }, { rollupByName: true }));

  this.on('READ', 'OTDData', serveFromDatabricks('OTDData', async () => {
    const [rows, index] = await Promise.all([dbx.query(await otdSql()), supplierIndex()]);
    LOG.info(`OTDData: fetched ${rows.length} raw row(s) from Databricks (${TABLES.otdData})`);
    if (rows.length) LOG.info('OTDData: sample raw row(s)', rows.slice(0, 3));

    const mapped = rows.map((row) => withSupplierMeta(mapOtdRow(row), index))
      .sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || (a.month ?? 0) - (b.month ?? 0));

    const unkeyed = mapped.filter((r) => !r.supplier_ID).length;
    if (unkeyed) {
      LOG.warn(`OTDData: ${unkeyed} row(s) have no supplier key ` +
        '(missing "Source system ID" or "Vendor"); they will not attach to a supplier.');
    }
    return mapped;
  }, { rollupByName: true }));

  this.on('READ', 'DeliveryData',    serveFromDatabricks('DeliveryData', loadMonthlyOtd));
  this.on('READ', 'DeliveryBySite',  serveFromDatabricks('DeliveryBySite', loadSiteOtd));
  this.on('READ', 'OTDSummary',      serveFromDatabricks('OTDSummary', loadOtdSummary));
  this.on('READ', 'ComplianceItems', serveFromDatabricks('ComplianceItems', loadCompliance));

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

      const allSitesMonthly = myMonthly.filter((r) => !r.plantName);
      const supplier = suppliers.find((s) => s.ID === supplierID);

      return {
        supplierID,
        supplierName: supplier?.name ?? null,
        generatedAt: new Date().toISOString(),
        summary: otd.summarise(allSitesMonthly, supplierID),
        monthly: myMonthly,
        sites: mySites,
        compliance: myCompliance,
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
      return failWith(req, err, 'getDashboard', 'the dashboard');
    }
  });

  this.on('refreshCache', async (req) => {
    dbx.invalidate(req.data?.scope);
    return req.data?.scope
      ? `Cache entries matching "${req.data.scope}" dropped.`
      : 'Databricks cache cleared.';
  });

  this.on('getData', async (req) => {
    try {
      const rows = await dbx.query(SUPPLIER_SQL);
      return rows.map(mapSupplierRow);
    } catch (err) {
      return failWith(req, err, 'getData', 'supplier data');
    }
  });

  this.on('getSpendData', async (req) => {
    try {
      const [rows, index] = await Promise.all([
        dbx.query(await spendSql()),
        supplierIndex(),
      ]);
      return rows.map((row) => withSupplierName(mapSpendRow(row), index));
    } catch (err) {
      return failWith(req, err, 'getSpendData', 'spend data');
    }
  });
});

module.exports.applyFilter = applyFilter;
module.exports.applyOrderBy = applyOrderBy;
module.exports.applyAggregation = applyAggregation;
module.exports.extractNavigationSupplierId = extractNavigationSupplierId;

module.exports.mapPpmRow = mapPpmRow;
module.exports.mapSpendRow = mapSpendRow;
module.exports.mapSupplierRow = mapSupplierRow;
module.exports.PPM_SQL = PPM_SQL;
module.exports.mapOpmRow = mapOpmRow;
module.exports.mapOtdRow = mapOtdRow;
module.exports.opmSql = opmSql;
module.exports.otdSql = otdSql;
module.exports.spendSql = spendSql;