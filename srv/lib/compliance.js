
'use strict';

const {
  fq, TABLES, COMPLIANCE_COLUMNS: C, COMPLIANCE_STANDARDS,
  COMPLIANCE_WAIVER_VALUES, COMPLIANCE_NOT_RELEVANT_VALUES,
  VENDOR_MASTER_COLUMNS: VM,
} = require('./dbx-config');

const { clean, supplierIdFrom } = require('./dbx');

const optional = (col, alias) =>
  col ? `c.\`${col}\` AS ${alias}` : `CAST(NULL AS STRING) AS ${alias}`;

const key = (expr) => `regexp_replace(TRIM(CAST(${expr} AS STRING)), '\\\\.0+$', '')`;

const dateColumnsInUse = () => [
  ...new Set(COMPLIANCE_STANDARDS.flatMap((std) => std.dateColumns || [])),
];

function complianceSql() {
  const dates = dateColumnsInUse()
    .map((col) => `      ${optional(col, `exp_${col}`)}`)
    .join(',\n');

  return `
    SELECT
      ${key(`c.\`${C.aribaId}\``)}          AS ariba_id,
      ${key(`vm.\`${VM.sourceVendorNumber}\``)} AS source_vendor_number,
      ${key(`vm.\`${VM.vendorNumber}\``)}       AS vendor_number,
      ${C.supplierName
        ? `TRIM(c.\`${C.supplierName}\`)`
        : 'CAST(NULL AS STRING)'}   AS supplier_name,
      ${optional(C.waiver, 'waiver')},
      ${optional(C.activityPerformed, 'activity_performed')},
${dates}
    FROM ${fq(TABLES.compliance)} c
    LEFT JOIN ${fq(TABLES.vendorMaster)} vm
      ON ${key(`c.\`${C.aribaId}\``)} = ${key(`vm.\`${VM.aribaId}\``)}
     AND ${key(`c.\`${C.aribaId}\``)} <> ''`;
}


function parseExpiry(raw) {
  const v = clean(raw);
  if (v === null || v === undefined || v === '') return null;

  if (v instanceof Date) {
    return Number.isFinite(v.getTime())
      ? build(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate())
      : null;
  }

  const s = String(v).trim();

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return build(+m[1], +m[2], +m[3]);

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return build(+m[3], +m[1], +m[2]);

  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return build(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function build(year, month, day) {
  const time = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(time)) return null;
  return {
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time,
  };
}

const startOfToday = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

function statusFromExpiry(raw, today = startOfToday()) {
  const parsed = parseExpiry(raw);
  if (!parsed) return { status: 'Noncompliant', validTo: null };
  if (parsed.time < today) return { status: 'Noncompliant', validTo: parsed.iso };
  return { status: 'Compliant', validTo: parsed.iso };
}


const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const WAIVER = new Set(COMPLIANCE_WAIVER_VALUES.map(norm));
const NOT_RELEVANT = new Set(COMPLIANCE_NOT_RELEVANT_VALUES.map(norm));

const isWaived = (raw) => WAIVER.has(norm(raw));
const isNotRelevant = (raw) => NOT_RELEVANT.has(norm(raw));

function evaluateStandard(std, row, today = startOfToday()) {
  let best = null;
  let lapsed = null;

  for (const col of std.dateColumns || []) {
    const result = statusFromExpiry(row[`exp_${col}`], today);
    if (result.status === 'Compliant') {
      if (!best || result.validTo > best.validTo) best = result;
    } else if (result.validTo && (!lapsed || result.validTo > lapsed.validTo)) {
      lapsed = result;
    }
  }

  if (best) return { status: 'Compliant', validTo: best.validTo, basis: 'Certificate' };
  if (std.allowWaiver && isWaived(row.waiver)) {
    return { status: 'Compliant', validTo: null, basis: 'Waiver' };
  }
  if (std.allowNotRelevant && isNotRelevant(row.activity_performed)) {
    return { status: 'Compliant', validTo: null, basis: 'Not relevant' };
  }

  return {
    status: 'Noncompliant',
    validTo: lapsed ? lapsed.validTo : null,
    basis: lapsed ? 'Expired' : 'None',
  };
}

const CRITICALITY = { Compliant: 3, Noncompliant: 1, Unknown: 0 };


const asIndex = (arg) =>
  (arg instanceof Map ? { nameToIds: arg, knownIds: null } : (arg || {}));

function supplierIdsFor(row, index) {
  const { nameToIds, knownIds } = asIndex(index);

  const candidates = [];
  for (const raw of [row.source_vendor_number, row.vendor_number]) {
    const id = supplierIdFrom(raw);
    if (id && !candidates.includes(id)) candidates.push(id);
  }

  if (knownIds && knownIds.size) {
    const known = candidates.filter((id) => knownIds.has(id));
    if (known.length) return known;
  }

  const byName = nameToIds?.get(clean(row.supplier_name));
  if (byName && byName.length) return byName;

  return candidates.slice(0, 1);
}


function mapComplianceRows(rows, index) {
  const today = startOfToday();

  const bySupplier = new Map();

  for (const row of rows) {
    const ids = supplierIdsFor(row, index);
    if (!ids.length) continue;

    for (const id of ids) {
      if (!id) continue;
      if (!bySupplier.has(id)) bySupplier.set(id, new Map());
      const seen = bySupplier.get(id);

      for (const std of COMPLIANCE_STANDARDS) {
        const detail = evaluateStandard(std, row, today);
        detail.aribaId = clean(row.ariba_id) || null;

        const existing = seen.get(std.key);
        if (existing && CRITICALITY[existing.status] <= CRITICALITY[detail.status]) continue;
        seen.set(std.key, detail);
      }
    }
  }

  const out = [];
  for (const [supplierId, standards] of bySupplier) {
    for (const std of COMPLIANCE_STANDARDS) {
      const hit = standards.get(std.key)
        || { status: 'Noncompliant', validTo: null, basis: 'None' };
      out.push({
        ID: `CMP-${supplierId}-${std.key}`,
        supplier_ID: supplierId,
        vendorNumber: supplierId,
        aribaId: hit.aribaId ?? null,
        standardKey: std.key,
        standard: std.label,
        status: hit.status,
        basis: hit.basis ?? null,
        validFrom: null,
        validTo: hit.validTo ?? null,
        certificateNumber: null,
        plantName: null,
        sequence: std.sequence,
        criticality: CRITICALITY[hit.status],
      });
    }
  }
  return out;
}

function rollUp(items, { renewWindowDays = 90 } = {}) {
  if (!items.length) return 'OK';
  if (items.some((i) => i.status === 'Noncompliant')) return 'Expired';

  const soon = Date.now() + renewWindowDays * 86400000;
  const expiringSoon = items.some((i) => {
    if (!i.validTo) return false;
    const t = Date.parse(i.validTo);
    return Number.isFinite(t) && t <= soon;
  });

  return expiringSoon ? 'UpcomingRenew' : 'OK';
}

module.exports = {
  complianceSql,
  mapComplianceRows,
  rollUp,
  statusFromExpiry,
  evaluateStandard,
  parseExpiry,
  supplierIdsFor,
};
