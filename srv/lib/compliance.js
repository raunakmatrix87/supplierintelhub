/**
 * Overall Compliance card.
 *
 * The dashboard lists a fixed set of standards (ISO 9001, IATF 16949,
 * Framework Agreement FWA, Code of Conduct) with a Compliant / Noncompliant
 * state each. Databricks may return them in any order, with any casing, and
 * may omit standards a supplier has never been assessed on — so the mapper
 * always emits one row per configured standard and fills gaps with 'Unknown'.
 */

'use strict';

const {
  fq, TABLES, COMPLIANCE_COLUMNS: C, COMPLIANCE_STANDARDS, COMPLIANCE_STATUS_MAP,
} = require('./dbx-config');

const { clean, supplierIdFrom } = require('./dbx');

const optional = (col, alias) =>
  col ? `c.\`${col}\` AS ${alias}` : `CAST(NULL AS STRING) AS ${alias}`;

function complianceSql() {
  return `
    SELECT
      ${optional(C.vendorNumber, 'vendor_number')},
      ${C.supplierName
        ? `TRIM(c.\`${C.supplierName}\`)`
        : 'CAST(NULL AS STRING)'}   AS supplier_name,
      TRIM(c.\`${C.standard}\`)     AS standard,
      c.\`${C.status}\`             AS status,
      ${optional(C.validFrom, 'valid_from')},
      ${optional(C.validTo, 'valid_to')},
      ${optional(C.certificateNo, 'certificate_number')},
      ${optional(C.plantName, 'plant_name')}
    FROM ${fq(TABLES.compliance)} c`;
}

// ─── Normalisation ──────────────────────────────────────────────────────────

/** 'ISO 9001' / 'iso-9001' / 'ISO9001' → 'iso9001' */
const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Resolve a raw standard string to a configured standard, or null. */
function matchStandard(raw) {
  const n = norm(raw);
  if (!n) return null;
  for (const std of COMPLIANCE_STANDARDS) {
    if (n === std.key) return std;
    if (n.includes(std.key) || std.key.includes(n)) return std;
    if ((std.aliases || []).some((a) => n === norm(a) || n.includes(norm(a)))) return std;
  }
  return null;
}

function normStatus(raw) {
  const n = String(raw ?? '').trim().toLowerCase();
  return COMPLIANCE_STATUS_MAP[n] || COMPLIANCE_STATUS_MAP[norm(n)] || 'Unknown';
}

const CRITICALITY = { Compliant: 3, Noncompliant: 1, Unknown: 0 };

// ─── Mapping ────────────────────────────────────────────────────────────────

/**
 * @param {any[]} rows raw Databricks rows
 * @param {Map<string,string[]>} [nameToIds]
 *        Fallback lookup, name → Suppliers.ID(s), used only for rows where the
 *        vendor-number column is absent or empty.
 * @returns {any[]} CDS ComplianceItems rows, one per supplier × standard
 */
function mapComplianceRows(rows, nameToIds) {
  /** @type {Map<string, Map<string, any>>} supplier_ID → standardKey → detail */
  const bySupplier = new Map();

  for (const row of rows) {
    const std = matchStandard(row.standard);
    if (!std) continue; // standard not shown on the dashboard

    // Vendor number is the key; name matching is only a fallback.
    const direct = supplierIdFrom(row.vendor_number);
    const ids = direct
      ? [direct]
      : (nameToIds?.get(clean(row.supplier_name)) || []);
    if (!ids.length) continue;

    const status = normStatus(row.status);
    const detail = {
      status,
      validFrom: clean(row.valid_from),
      validTo: clean(row.valid_to),
      certificateNumber: clean(row.certificate_number),
      plantName: clean(row.plant_name),
      rawStandard: clean(row.standard),
    };

    for (const id of ids) {
      if (!bySupplier.has(id)) bySupplier.set(id, new Map());
      const seen = bySupplier.get(id);

      // Keep the worst status when a supplier has several rows for one standard
      // (e.g. one per plant) — a single noncompliant site fails the card.
      const existing = seen.get(std.key);
      if (existing && CRITICALITY[existing.status] <= CRITICALITY[status]) continue;
      seen.set(std.key, detail);
    }
  }

  const out = [];
  for (const [supplierId, standards] of bySupplier) {
    for (const std of COMPLIANCE_STANDARDS) {
      const hit = standards.get(std.key) || { status: 'Unknown' };
      out.push({
        ID: `CMP-${supplierId}-${std.key}`,
        supplier_ID: supplierId,
        standardKey: std.key,
        standard: std.label,
        status: hit.status,
        validFrom: hit.validFrom ?? null,
        validTo: hit.validTo ?? null,
        certificateNumber: hit.certificateNumber ?? null,
        plantName: hit.plantName ?? null,
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
 * stays consistent with the new card.
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

module.exports = { complianceSql, mapComplianceRows, rollUp, matchStandard, normStatus };
