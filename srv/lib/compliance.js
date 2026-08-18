/**
 * Overall Compliance card — two rows.
 *
 * Source: bs_db_dev.proc_silver.compliance — a WIDE table with one row per
 * company and one expiry-date column per certification. There is no status
 * column; the state is derived per row from the rules in COMPLIANCE_STANDARDS:
 *
 *   ISO 14001             date-only. iso14001expirydate null or past → Noncompliant.
 *   ISO 9001 / IATF 16949 Compliant if EITHER iso9001expirydate OR
 *                         iatf16949expirydate is still valid, OR waver = YES,
 *                         OR activityperformedatthislocation = 'Not relevant'.
 *                         Otherwise Noncompliant.
 *
 * The mapper always emits both rows, so a supplier with no certificate on file
 * still shows on the card as Noncompliant rather than silently dropping off it.
 */

'use strict';

const {
  fq, TABLES, COMPLIANCE_COLUMNS: C, COMPLIANCE_STANDARDS,
  COMPLIANCE_WAIVER_VALUES, COMPLIANCE_NOT_RELEVANT_VALUES,
  VENDOR_MASTER_COLUMNS: VM,
} = require('./dbx-config');

const { clean, supplierIdFrom } = require('./dbx');

const optional = (col, alias) =>
  col ? `c.\`${col}\` AS ${alias}` : `CAST(NULL AS STRING) AS ${alias}`;

/**
 * Normalise a join key. aribaid is numeric in one table and text in the other,
 * and a column typed DOUBLE stringifies as '9004722.0' — which matches nothing.
 * Trailing '.0' is therefore stripped; everything else is left alone so
 * alphanumeric keys survive untouched.
 */
const key = (expr) => `regexp_replace(TRIM(CAST(${expr} AS STRING)), '\\\\.0+$', '')`;

/** Every distinct expiry column any configured row needs, deduplicated. */
const dateColumnsInUse = () => [
  ...new Set(COMPLIANCE_STANDARDS.flatMap((std) => std.dateColumns || [])),
];

/**
 * One row per company × vendor number, carrying every expiry column in use
 * (aliased `exp_<column>`) plus the waiver and activity columns, so the mapper
 * never has to know the physical column names.
 *
 * The compliance table only knows aribaid, so d_vendormaster is joined in to
 * reach the SAP vendor number. The join is deliberately NOT deduplicated: one
 * Ariba supplier can map to several vendor numbers, and the certificate applies
 * to all of them. mapComplianceRows() groups by Suppliers.ID afterwards, so the
 * fan-out costs nothing in the result.
 */
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

// ─── Date handling ──────────────────────────────────────────────────────────

/**
 * Databricks hands DATE columns back as a JS Date, as 'YYYY-MM-DD', or — when
 * the column is typed as a string in the source — as 'M/D/YYYY'. All three are
 * accepted; anything else is treated as "no date", i.e. Noncompliant.
 *
 * @returns {{iso: string, time: number}|null} normalised date, or null
 */
function parseExpiry(raw) {
  const v = clean(raw);
  if (v === null || v === undefined || v === '') return null;

  if (v instanceof Date) {
    return Number.isFinite(v.getTime())
      ? build(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate())
      : null;
  }

  const s = String(v).trim();

  // 'YYYY-MM-DD' (optionally with a time part, which is discarded)
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return build(+m[1], +m[2], +m[3]);

  // 'M/D/YYYY' — the format the Databricks sample-data preview renders
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

/** Midnight UTC today — a certificate expiring today still counts as valid. */
const startOfToday = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

/**
 * The date rule, in one place.
 * @returns {{status:'Compliant'|'Noncompliant', validTo:string|null}}
 */
function statusFromExpiry(raw, today = startOfToday()) {
  const parsed = parseExpiry(raw);
  // null / unparseable → never certified → Noncompliant
  if (!parsed) return { status: 'Noncompliant', validTo: null };
  // lapsed → Noncompliant
  if (parsed.time < today) return { status: 'Noncompliant', validTo: parsed.iso };
  return { status: 'Compliant', validTo: parsed.iso };
}

// ─── The waiver / not-relevant escape hatches ───────────────────────────────

/** Lowercase and strip everything that isn't a letter or digit. */
const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const WAIVER = new Set(COMPLIANCE_WAIVER_VALUES.map(norm));
const NOT_RELEVANT = new Set(COMPLIANCE_NOT_RELEVANT_VALUES.map(norm));

const isWaived = (raw) => WAIVER.has(norm(raw));
const isNotRelevant = (raw) => NOT_RELEVANT.has(norm(raw));

/**
 * Evaluate one configured row against one source record.
 *
 * A live certificate always wins, and when a row watches several dates the
 * furthest-out valid one is reported — that is the date the supplier is
 * actually covered until. Only when no date qualifies do the waiver and
 * not-relevant escapes apply, and those report no date, because "Compliant
 * until 2024" next to an expired certificate reads as a bug.
 *
 * @returns {{status:string, validTo:string|null, basis:string}}
 */
function evaluateStandard(std, row, today = startOfToday()) {
  let best = null;    // furthest-out still-valid date
  let lapsed = null;  // furthest-out expired date, for context on failures

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

// ─── Key resolution ─────────────────────────────────────────────────────────

/** Accept both the old `nameToIds` Map and the full supplierIndex() object. */
const asIndex = (arg) =>
  (arg instanceof Map ? { nameToIds: arg, knownIds: null } : (arg || {}));

/**
 * Resolve a joined compliance row to Suppliers.ID(s).
 *
 * d_vendormaster gives two spellings of the same vendor — '01/1102524' and
 * '1102524' — and which one Suppliers.ID uses depends on how
 * fiori_mv_supplier_list populates SourceSystemVendorNumber. Rather than
 * hard-coding a guess, both are offered and the one the supplier list actually
 * knows wins. Only if neither is known does it fall back to the company name.
 */
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

  // No match anywhere — keep the first candidate so the gap stays visible in
  // the data rather than disappearing silently.
  return candidates.slice(0, 1);
}

// ─── Mapping ────────────────────────────────────────────────────────────────

/**
 * @param {any[]} rows raw Databricks rows from complianceSql()
 * @param {{nameToIds?:Map<string,string[]>, knownIds?:Set<string>}|Map} [index]
 *        supplierIndex() output. A bare Map is accepted as `nameToIds` for
 *        backwards compatibility.
 * @returns {any[]} CDS ComplianceItems rows, one per supplier × standard
 */
function mapComplianceRows(rows, index) {
  const today = startOfToday();

  /** @type {Map<string, Map<string, any>>} supplier_ID → standardKey → detail */
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

        // Keep the worst status when a supplier has several rows (e.g. one per
        // legal entity) — a single lapsed certificate fails the card.
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
        // supplier_ID *is* the vendor number; surfaced explicitly so the join
        // result is readable straight off the OData payload.
        vendorNumber: supplierId,
        aribaId: hit.aribaId ?? null,
        standardKey: std.key,
        standard: std.label,
        status: hit.status,
        // Why the row reads the way it does: Certificate | Waiver |
        // Not relevant | Expired | None. Not rendered on the card, but it makes
        // a surprising status explainable without re-querying Databricks.
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

/**
 * Roll the per-standard rows up to the Suppliers.complianceStatus enum
 * ('OK' | 'UpcomingRenew' | 'Expired'), so the existing header ObjectStatus
 * stays consistent with the card.
 */
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
