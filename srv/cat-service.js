
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

// supplierIndex() runs on every read, so data-quality findings would otherwise be
// repeated on every request. Each distinct finding is reported once per process.
const reported = new Set();
function reportOnce(key, message) {
  if (reported.has(key)) return;
  reported.add(key);
  LOG.warn(message);
}

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

const { clean, num, round, slug, supplierIdFrom, monthShort, pick } = dbx;

// One supplier name can arrive spelled differently across its vendor numbers:
// trailing blanks, double spaces, mixed case. Every place that groups by name goes
// through this key, so the list collapses and the charts consolidate on exactly the
// same set of rows - otherwise a name looks merged in the list while its charts
// still show only the first vendor number.
function nameKey(name) {
  const value = clean(name);
  if (value === null || value === undefined || value === '') return null;

  // Separator- and case-insensitive, the same rule dbx already uses for column
  // names, so "Digi-Key", "Digi Key" and "DIGIKEY" are recognised as one supplier.
  // Legal forms are deliberately NOT stripped: "Danfoss A/S" and "Danfoss GmbH"
  // are different companies and merging them would hide a real supplier.
  const squashed = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  // A name written entirely outside the latin alphabet still needs a key.
  return squashed || String(value).replace(/\s+/g, ' ').trim().toLowerCase() || null;
}

// The spelling shown in the UI: the one used by most of the supplier's vendor
// numbers, and among equals the one the source lists first.
function preferredSpelling(spellings) {
  let best = null;
  let bestCount = 0;
  for (const [spelling, count] of spellings) {
    if (count > bestCount) { best = spelling; bestCount = count; }
  }
  return best;
}

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
  // Kept as a single combined label so segment and plant can still be grouped,
  // filtered or drilled into without needing two dimensions.
  if (rec.segmentPlant === undefined || rec.segmentPlant === null) {
    const parts = [rec.segmentName, rec.plantName].filter(Boolean);
    rec.segmentPlant = parts.length ? parts.join(' / ') : null;
  }
  return rec;
}

async function siblingSupplierIds(supplierId) {
  const group = await supplierGroupOf(supplierId);
  const ids = group && group.vendorIds.length ? group.vendorIds : null;
  return new Set(ids || [supplierId]);
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

// The single source of truth for "what is a supplier", built in two phases so
// nothing can go missing between them:
//
//   PHASE 1  one entry per vendor number - the complete set. Every source row lands
//            in an entry, including rows with no vendor number and no name, so this
//            phase can only ever preserve, never drop.
//   PHASE 2  entries whose supplier name matches are merged into one entity. Only
//            this phase reduces the count, and only by merging - never by dropping.
//
// The list, the object page and the charts all read the result from here.
async function supplierIndex() {
  const rows = await dbx.query(SUPPLIER_SQL);

  // ---- PHASE 1: one entry per vendor number --------------------------------
  const entries = [];
  const byKey = new Map();
  const namesPerVendor = new Map();

  rows.forEach((row, position) => {
    const vendorId = supplierIdFrom(pick(row, SC.vendorNumber));
    const name = clean(pick(row, SC.name));
    const key = nameKey(name);

    // Keyed by vendor number AND name. Repeating a vendor number with the same name
    // is the same entry, so its figures are read once. Repeating it with a DIFFERENT
    // name means two suppliers sharing a number - vendor numbers are only unique
    // within a source system - and each gets its own entry so neither is hidden.
    // A row with no vendor number cannot be identified at all and stands alone.
    const entryKey = vendorId ? `${vendorId}::${key ?? ''}` : `row:${position}`;

    let entry = byKey.get(entryKey);
    if (!entry) {
      entry = { key: entryKey, vendorId, nameKey: key, rows: [], names: new Map() };
      byKey.set(entryKey, entry);
      entries.push(entry);
    }
    entry.rows.push(row);
    if (name) entry.names.set(name, (entry.names.get(name) || 0) + 1);

    if (vendorId && key) {
      if (!namesPerVendor.has(vendorId)) namesPerVendor.set(vendorId, new Set());
      namesPerVendor.get(vendorId).add(key);
    }
  });

  // A row carrying a vendor number but no name belongs to that vendor's supplier
  // whenever the vendor has exactly one; only a genuinely ambiguous row stays apart.
  for (const entry of [...entries]) {
    if (entry.nameKey || !entry.vendorId) continue;
    const names = namesPerVendor.get(entry.vendorId);
    if (!names || names.size !== 1) continue;
    const target = byKey.get(`${entry.vendorId}::${[...names][0]}`);
    if (!target) continue;
    target.rows.push(...entry.rows);
    entries.splice(entries.indexOf(entry), 1);
    byKey.delete(entry.key);
  }

  // ---- PHASE 2: merge entries that carry the same supplier name ------------
  const groups = [];
  const byName = new Map();
  const vendorToGroup = new Map();
  const idToGroup = new Map();

  for (const entry of entries) {
    const name = preferredSpelling(entry.names);
    const key = nameKey(name);

    // No name means nothing to match on, so the entry stays a supplier of its own.
    const groupKey = key || `unnamed:${entry.key}`;

    let group = byName.get(groupKey);
    if (!group) {
      group = { key: groupKey, name, spellings: new Map(), entries: [], vendorIds: [], rows: [], id: null };
      byName.set(groupKey, group);
      groups.push(group);
    }
    group.entries.push(entry);
    group.rows.push(...entry.rows);
    if (entry.vendorId && !group.vendorIds.includes(entry.vendorId)) {
      group.vendorIds.push(entry.vendorId);
    }
    for (const [spelling, count] of entry.names) {
      group.spellings.set(spelling, (group.spellings.get(spelling) || 0) + count);
    }
  }

  for (const group of groups) {
    group.name = preferredSpelling(group.spellings) || group.name || null;

    // The supplier NAME is the key: one supplier name, one row, one stable id, so a
    // supplier keeps the same URL even when a vendor number is added or retired.
    // Suppliers.ID is String(40); leave room for a disambiguating suffix.
    // A supplier the source left unnamed falls back to its vendor number - it still
    // needs a key, and its name is the only thing that cannot supply one.
    let id = cap(slug(group.name) || group.vendorIds[0], 36)
      || `supplier-${groups.indexOf(group) + 1}`;
    if (idToGroup.has(id)) {
      let n = 2;
      while (idToGroup.has(`${id}~${n}`)) n += 1;
      // Two different names can slug to the same key only once capped to 36
      // characters. Suffixing keeps both suppliers reachable instead of hiding one.
      reportOnce(`shared-key:${id}:${group.key}`,
        `Supplier key "${id}" is claimed by more than one supplier name in ` +
        `${TABLES.supplierList}; "${group.name}" is served as "${id}~${n}" ` +
        'so it is not hidden behind the other.');
      id = `${id}~${n}`;
    }
    group.id = id;
    idToGroup.set(id, group);
    for (const vendorId of group.vendorIds) {
      if (!vendorToGroup.has(vendorId)) vendorToGroup.set(vendorId, group);
    }
  }

  // The invariant: every vendor number that came out of the source is inside
  // exactly one supplier. If this ever fails, the list is hiding something.
  const sourceVendors = new Set(
    rows.map((r) => supplierIdFrom(pick(r, SC.vendorNumber))).filter(Boolean));
  const groupedVendors = new Set(groups.flatMap((g) => g.vendorIds));
  if (sourceVendors.size !== groupedVendors.size) {
    const lost = [...sourceVendors].filter((v) => !groupedVendors.has(v));
    LOG.error(`${lost.length} vendor number(s) did not reach the supplier list: ` +
      `${lost.slice(0, 20).join(', ')}${lost.length > 20 ? ', …' : ''}`);
  }

  // Kept for the child readers, which are all keyed by vendor number.
  const nameToIds = new Map();
  const idToName = new Map();
  const idToSegment = new Map();
  const idToPlant = new Map();
  const knownIds = new Set();

  for (const group of groups) {
    const key = nameKey(group.name);
    if (key && group.vendorIds.length) nameToIds.set(key, group.vendorIds);
    for (const entry of group.entries) {
      if (!entry.vendorId) continue;
      knownIds.add(entry.vendorId);
      idToName.set(entry.vendorId, group.name);
      const first = entry.rows[0];
      idToSegment.set(entry.vendorId, clean(pick(first, SC.segment)));
      idToPlant.set(entry.vendorId, clean(pick(first, SC.plant)));
    }
  }

  return {
    rows, entries, groups, idToGroup, vendorToGroup,
    nameToIds, idToName, idToSegment, idToPlant, knownIds,
  };
}

// Every vendor number that belongs to the same supplier as `supplierId`, which may
// itself be a group id or any one of the vendor numbers inside a group. This is what
// makes an object page chart cover the whole supplier instead of one vendor number.
async function supplierGroupOf(supplierId) {
  const index = await supplierIndex();
  return index.idToGroup.get(supplierId) || index.vendorToGroup.get(supplierId) || null;
}

function resolveSuppliers(rows, index, mapper, vendorColumn = 'vendor_number') {
  const out = [];
  for (const row of rows) {
    const direct = vendorColumn ? supplierIdFrom(row[vendorColumn]) : null;
    if (direct) { out.push(mapper(row, { supplierId: direct })); continue; }

    const ids = index.nameToIds.get(nameKey(row.supplier_name));
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

// `listFields` names the properties a consolidated row may hold as a comma-joined
// set ("Mechanical, Electronics"). A filter on one of those matches when any member
// matches, so filtering by segment or plant still finds a supplier that spans several.
function applyFilter(rows, where, listFields) {
  const comparisons = extractComparisons(where);
  if (!comparisons.length) return rows;

  return rows.filter((row) => comparisons.every(({ ref, op, val }) => {
    if (!(ref in row)) return true;
    const cmp = COMPARE[op];
    if (!cmp) return true;

    const value = row[ref];
    if (listFields && listFields.has(ref) && typeof value === 'string' && value.includes(',')) {
      return value.split(',').some((part) => cmp(part.trim(), val));
    }
    return cmp(value, val);
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

// Collapses rows that share the same logical key, keeping the first occurrence.
// `merge` folds each later duplicate into the row that survives, so a collapsed
// row can still describe everything the duplicates covered.
// Rows without a key are always kept - they cannot be judged duplicates.
function dedupeRows(rows, keyOf, merge) {
  const kept = new Map();
  const out = [];
  for (const row of rows) {
    const raw = keyOf(row);
    const key = raw === null || raw === undefined ? '' : String(raw).trim().toLowerCase();
    if (!key) { out.push(row); continue; }
    const first = kept.get(key);
    if (first) { if (merge) merge(first, row); continue; }
    kept.set(key, row);
    out.push(row);
  }
  return out;
}

// A supplier name can span several vendor numbers, one per segment/plant. The list
// shows one row per name, so the labels of every vendor number behind that name are
// folded into a single value and the counts are added up.
// Worst status wins for a consolidated supplier, so an expired certificate on one
// vendor number cannot hide behind an OK on another.
const COMPLIANCE_RANK = { Expired: 3, UpcomingRenew: 2, OK: 1 };

function cap(value, max) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// The distinct set of everything the group's vendor numbers carry, in source order.
function joinLabels(values, max) {
  const parts = [];
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    for (const piece of String(value).split(',')) {
      const trimmed = piece.trim();
      if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
    }
  }
  return parts.length ? cap(parts.join(', '), max) : null;
}

const numbersIn = (values) =>
  values.map(Number).filter((v) => Number.isFinite(v));

function sumOf(values) {
  const nums = numbersIn(values.filter((v) => v !== null && v !== undefined && v !== ''));
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

function avgOf(values, digits) {
  const nums = numbersIn(values.filter((v) => v !== null && v !== undefined && v !== ''));
  return nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length, digits) : null;
}

function earliestOf(values) {
  const dates = values.filter((v) => v !== null && v !== undefined && v !== '').sort();
  return dates.length ? dates[0] : null;
}

function worstStatus(values) {
  return values.filter(Boolean)
    .sort((a, b) => (COMPLIANCE_RANK[b] || 0) - (COMPLIANCE_RANK[a] || 0))[0] ?? null;
}

// PHASE 1 row: one vendor number. The source can list the same vendor number more
// than once (a row per plant, say). Its labels are unioned, but its figures are read
// once - they describe the vendor number, not the row, so repeating a row must not
// repeat its claims.
function mapVendorEntry(entry) {
  const records = entry.rows.map(mapSupplierRow);
  const first = records[0];
  const valuesOf = (field) => records.map((rec) => rec[field]);

  return {
    ...first,
    segmentName:   joinLabels(valuesOf('segmentName'), 100),
    plantName:     joinLabels(valuesOf('plantName'), 100),
    plantLocation: joinLabels(valuesOf('plantLocation'), 100),
    responsible:   joinLabels(valuesOf('responsible'), 100),
    category:      joinLabels(valuesOf('category'), 100),
    subcategory:   joinLabels(valuesOf('subcategory'), 100),
    mainSupplies:  joinLabels(valuesOf('mainSupplies'), 500),
    complianceStatus: worstStatus(valuesOf('complianceStatus')),
    isTopSupplier: records.some((rec) => rec.isTopSupplier === true),
    nextReview:    earliestOf(valuesOf('nextReview')),
  };
}

// PHASE 2 row: one supplier. The vendor numbers merged under this name are folded
// together - labels become the distinct set, counts add up, rates average, the
// compliance status is the worst of them and the next review is the soonest.
function mapSupplierGroup(group) {
  const records = group.entries.map(mapVendorEntry);
  const first = records[0];
  const valuesOf = (field) => records.map((rec) => rec[field]);

  const merged = {
    ...first,
    ID:           group.id,
    // Every row shows something in the Name column; a supplier the source list
    // left unnamed falls back to its vendor number rather than rendering blank.
    name:         group.name || first.name || first.vendorNumber || null,
    vendorNumber: group.vendorIds[0] ?? first.vendorNumber,

    // What was merged, so the list can be checked against the source at a glance.
    vendorNumbers: cap(group.vendorIds.join(', '), 500) || null,
    vendorCount:   group.entries.length,

    segmentName:   joinLabels(valuesOf('segmentName'), 100),
    plantName:     joinLabels(valuesOf('plantName'), 100),
    plantLocation: joinLabels(valuesOf('plantLocation'), 100),
    responsible:   joinLabels(valuesOf('responsible'), 100),
    category:      joinLabels(valuesOf('category'), 100),
    subcategory:   joinLabels(valuesOf('subcategory'), 100),
    mainSupplies:  joinLabels(valuesOf('mainSupplies'), 500),

    complianceStatus:    worstStatus(valuesOf('complianceStatus')),
    isTopSupplier:       records.some((rec) => rec.isTopSupplier === true),
    nextReview:          earliestOf(valuesOf('nextReview')),
    score:               avgOf(valuesOf('score'), 1),
    activeQualityClaims: sumOf(valuesOf('activeQualityClaims')),
    currentPPM:          avgOf(valuesOf('currentPPM'), 2),
    currentOTD:          avgOf(valuesOf('currentOTD'), 2),
  };
  merged.segmentText = merged.segmentName;
  merged.plantText   = merged.plantName;

  if (group.vendorIds.length > 1) {
    LOG.debug(`Supplier "${merged.name}" = ${group.vendorIds.join(', ')}`);
  }
  return merged;
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
        const one = all.find((r) => r.ID === keyRef)
          || (opts.resolveKey ? await opts.resolveKey(keyRef, all) : null);
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
      rows = applyFilter(rows, SELECT?.where, opts.listFields);

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
    const index = await supplierIndex();

    // The list is keyed by supplier name, so a group the source left unnamed has no
    // key a person could recognise - only a vendor number. Those are not listed.
    // They still exist in the index, so a direct link to one of their vendor numbers
    // resolves and their spend/OTD rows keep attaching; they are hidden, not dropped.
    const named = index.groups.filter((g) => clean(g.name));
    const rows = named.map(mapSupplierGroup);

    LOG.info(`Suppliers: ${index.rows.length} source row(s) from ${TABLES.supplierList} ` +
      `-> ${index.entries.length} vendor number(s) -> ${named.length} named supplier(s) ` +
      'after merging vendor numbers that share a name.');

    const consolidated = index.groups.filter((g) => g.vendorIds.length > 1);
    if (consolidated.length) {
      LOG.info(`${consolidated.length} supplier(s) consolidated from several vendor ` +
        'numbers (set CDS_LOG_LEVELS_supplier-service=debug to list them).');
      for (const g of consolidated) {
        LOG.debug(`  "${g.name}" = ${g.vendorIds.join(', ')}`);
      }
    }

    // Names that differ only by case, accents or punctuation are treated as one
    // supplier. Reporting them makes that call auditable instead of invisible.
    for (const g of index.groups) {
      if (g.spellings.size > 1) {
        reportOnce(`spellings:${g.key}`,
          `Combined as one supplier under "${g.name}": ` +
          `${[...g.spellings.keys()].map((n) => `"${n}"`).join(', ')}. ` +
          'If these are different companies, they need distinct names in ' +
          `${TABLES.supplierList}.`);
      }
    }

    // Keyed by name, so the table reads in name order unless the UI sorts it itself.
    rows.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));

    const hidden = index.groups.length - named.length;
    if (hidden) {
      reportOnce('unnamed-suppliers',
        `${hidden} supplier(s) have no ${SC.name} in ${TABLES.supplierList} and are ` +
        'not listed. Give them a name in the source view to make them visible.');
    }
    return rows;
  }, {
    // segmentName and friends can hold the joined set of everything the supplier's
    // vendor numbers carry, so the filter bar has to match inside that set.
    listFields: new Set([
      'segmentName', 'plantName', 'segmentText', 'plantText',
      'plantLocation', 'responsible', 'category', 'subcategory',
    ]),
    // A bookmark to a vendor number that is now shown under its supplier's group id
    // still opens the right supplier instead of 404ing.
    resolveKey: async (keyRef, rows) => {
      const group = await supplierGroupOf(keyRef);
      return group ? rows.find((r) => r.ID === group.id) || null : null;
    },
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
  // Rolled up by name like the metric tables: a consolidated supplier shows the
  // compliance of every vendor number behind that name, with the identical
  // standard/validity pairs its siblings share collapsed into one row.
  this.on('READ', 'ComplianceItems', serveFromDatabricks('ComplianceItems', loadCompliance, {
    rollupByName: true,
    dedupeBy: (row) => [row.standardKey, row.status, row.validTo].join('|'),
  }));

  this.on('getDashboard', async (req) => {
    const supplierID = req.data?.supplierID || null;
    try {
      const [monthly, sites, complianceItems, group] = await Promise.all([
        loadMonthlyOtd(),
        loadSiteOtd(),
        loadCompliance(),
        supplierID ? supplierGroupOf(supplierID) : null,
      ]);

      // Every vendor number behind the supplier, so the dashboard reports the whole
      // supplier rather than whichever vendor number the id happened to name.
      const ids = supplierID
        ? new Set(group && group.vendorIds.length ? group.vendorIds : [supplierID])
        : null;
      const forSupplier = (rows) => (ids ? rows.filter((r) => ids.has(r.supplier_ID)) : rows);

      const myMonthly = forSupplier(monthly)
        .sort((a, b) => otd.periodKey(a) - otd.periodKey(b));
      const mySites = forSupplier(sites)
        .sort((a, b) => (b.onTimePercent ?? -1) - (a.onTimePercent ?? -1));
      const myCompliance = forSupplier(complianceItems)
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

      const allSitesMonthly = myMonthly.filter((r) => !r.plantName);

      return {
        supplierID,
        supplierName: group?.name ?? null,
        vendorNumbers: group ? group.vendorIds : [],
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

module.exports.dedupeRows = dedupeRows;
module.exports.mapSupplierGroup = mapSupplierGroup;
module.exports.mapVendorEntry = mapVendorEntry;
module.exports.supplierIndex = supplierIndex;
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