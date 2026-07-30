/**
 * ════════════════════════════════════════════════════════════════════════════
 *  DATABRICKS ↔ CDS MAPPING — SINGLE SOURCE OF TRUTH
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  This is the ONLY file you should need to edit when the Databricks side
 *  changes. Everything downstream (SQL builders, service handlers, the Fiori
 *  dashboard) reads from here.
 *
 *  SUPPLIER_COLUMNS and SPEND_COLUMNS are CONFIRMED against the catalog.
 *
 *  ⚠️  Still to verify — the two blocks marked "VERIFY" (PO lines, compliance):
 *
 *        SHOW TABLES IN bs_db_dev.proc_silver LIKE 'fiori_*';
 *        DESCRIBE TABLE bs_db_dev.proc_silver.fiori_mv_po_lines;
 *        DESCRIBE TABLE bs_db_dev.proc_silver.fiori_mv_supplier_compliance;
 *
 *      Then fix the string values. No other file needs touching.
 */

'use strict';

// ─── Catalog / schema ───────────────────────────────────────────────────────

const CATALOG = process.env.DATABRICKS_CATALOG || 'bs_db_dev';
const SCHEMA  = process.env.DATABRICKS_SCHEMA  || 'proc_silver';

/** Fully-qualified, back-tick quoted object name. */
const fq = (object) => `${CATALOG}.${SCHEMA}.\`${object}\``;

// ─── Source objects ─────────────────────────────────────────────────────────

const TABLES = {
  // Already in use and confirmed working.
  supplierList : 'fiori_mv_supplier_list',
  spendByYear  : 'fiori_mv_spend_by_year',

  // VERIFY ①  The raw purchase-order line-item view. OTD is DERIVED from this
  //           — one row per PO line, per scheduled delivery.
  poLines      : 'fiori_mv_po_lines',

  // VERIFY ②  Compliance / certification status. One row per supplier per
  //           standard (ISO 9001, IATF 16949, FWA, Code of Conduct).
  compliance   : 'fiori_mv_supplier_compliance',

  // Optional. If your pipeline already produces OTD forecast rows, name the
  // view here and set OTD.forecast.source = 'view'. Otherwise leave as-is.
  otdForecast  : 'fiori_mv_otd_forecast',
};

// ─── Column mapping: supplier list ──────────────────────────────────────────
//
// CONFIRMED against bs_db_dev.proc_silver.fiori_mv_supplier_list.
//
// SourceSystemVendorNumber is the business key and is unique per row, so it is
// used verbatim as Suppliers.ID. Everything else — including plant — is a plain
// attribute of the vendor.
//
const SUPPLIER_COLUMNS = {
  vendorNumber        : 'SourceSystemVendorNumber',   // ← key
  name                : 'name',
  segment             : 'segment',
  plant               : 'plant',
  responsible         : 'responsible',
  category            : 'category',
  subcategory         : 'subcategory',
  mainSupplies        : 'mainSupplies',
  score               : 'score',                      // double
  nextReview          : 'nextReview',                 // date
  complianceStatus    : 'complianceStatus',
  isTopSupplier       : 'isTopSupplier',              // boolean
  activeQualityClaims : 'activeQualityClaims',        // int
  currentPPM          : 'currentPPM',                 // double
  currentOTD          : 'currentOTD',                 // double

  // Present in the view but NOT read: a string blob of unknown format.
  // If it ever needs parsing, set SPEND.fallbackColumn below instead of
  // wiring it in here.
  spendData           : 'spendData',

  // Not in this view. Leave null — plantLocation resolves from the Plants
  // master list when a matching entry exists, otherwise stays empty.
  plantLocation       : null,
};

// ─── Column mapping: yearly spend ───────────────────────────────────────────
//
// CONFIRMED against bs_db_dev.proc_silver.fiori_mv_spend_by_year.
//
// Grain is one row per vendor per YEAR — there is no month or date column, so
// the Spend Development chart is keyed on `year`.
//
const SPEND_COLUMNS = {
  vendorNumber : 'SourceSystemVendorNumber',   // joins to the supplier key
  supplierName : 'supplier',
  year         : 'year',                       // int
  amount       : 'spend',                      // double
};

const SPEND = {
  /** Period options offered on the object page, in years. null = all history. */
  periods: [
    { key: '3',   label: 'Last 3 Years',  years: 3 },
    { key: '5',   label: 'Last 5 Years',  years: 5 },
    { key: 'all', label: 'All',           years: null },
  ],
  defaultPeriod: '3',

  /**
   * Optional fallback if the spend view is ever empty for a vendor: name the
   * supplier-list column holding serialised spend and set `format`.
   * Left off by design — the spend view is the source of truth.
   */
  fallbackColumn: null,
  fallbackFormat: null,   // 'json' | 'csv'
};

// ─── Column mapping: PO line-item view ──────────────────────────────────────
//
// VERIFY ①  Left-hand side = logical name used by the SQL builder.
//           Right-hand side = actual column name in `poLines`.
//
const PO_LINE_COLUMNS = {
  // Prefer the vendor number if the PO line view carries it — it joins to
  // Suppliers.ID directly and avoids all name-matching. Set `supplierName` to
  // null once this is confirmed present.
  vendorNumber    : 'SourceSystemVendorNumber',
  supplierName    : 'supplier_name',      // fallback join, on supplierList.name
  plantName       : 'plant',              // Danfoss site, e.g. 'Danfoss Site 01'
  plantCode       : 'plant_code',         // optional
  segment         : 'segment',

  poNumber        : 'po_number',
  poLineNumber    : 'po_line_number',

  requiredDate    : 'required_date',      // DATE — customer/plant required date
  actualDate      : 'actual_delivery_date', // DATE — goods receipt date

  requiredQty     : 'required_quantity',
  deliveredQty    : 'delivered_quantity',

  // OPTIONAL SHORTCUT: if the view already carries a signed day delta
  // (actual - required, negative = early), name it here and the SQL uses it
  // directly instead of DATEDIFF. Set to null to always compute from dates.
  deliveryDeltaDays : null,               // e.g. 'delivery_delta_days'
};

// ─── Column mapping: compliance view ────────────────────────────────────────
//
// VERIFY ②
//
const COMPLIANCE_COLUMNS = {
  // As above: vendor number preferred, name used only as a fallback.
  vendorNumber   : 'SourceSystemVendorNumber',
  supplierName   : 'supplier_name',
  standard       : 'standard',        // 'ISO 9001' | 'IATF 16949' | 'FWA' | ...
  status         : 'status',          // see STATUS_VALUES normalisation below
  validFrom      : 'valid_from',
  validTo        : 'valid_to',
  certificateNo  : 'certificate_number',
  plantName      : 'plant',           // optional; null-safe if absent
};

/**
 * Which compliance standards the dashboard shows, in display order, and the
 * label to render. Keys are matched case-insensitively and ignoring spaces
 * against COMPLIANCE_COLUMNS.standard, so 'iso9001' matches 'ISO 9001'.
 */
const COMPLIANCE_STANDARDS = [
  { key: 'iso9001',      label: 'ISO 9001',              sequence: 10 },
  { key: 'iatf16949',    label: 'IATF 16949',            sequence: 20 },
  { key: 'fwa',          label: 'Framework Agreement FWA', sequence: 30,
    aliases: ['frameworkagreement', 'frameworkagreementfwa'] },
  { key: 'codeofconduct', label: 'Code of Conduct',      sequence: 40,
    aliases: ['coc'] },
];

/**
 * Raw status strings from Databricks → canonical CDS values.
 * Anything unmatched falls back to 'Unknown'.
 */
const COMPLIANCE_STATUS_MAP = {
  compliant     : 'Compliant',
  yes           : 'Compliant',
  y             : 'Compliant',
  true          : 'Compliant',
  valid         : 'Compliant',
  active        : 'Compliant',
  certified     : 'Compliant',
  ok            : 'Compliant',

  noncompliant  : 'Noncompliant',
  'non-compliant': 'Noncompliant',
  no            : 'Noncompliant',
  n             : 'Noncompliant',
  false         : 'Noncompliant',
  invalid       : 'Noncompliant',
  expired       : 'Noncompliant',
  failed        : 'Noncompliant',
};

// ─── On-Time-Delivery business rules ────────────────────────────────────────

const OTD = {
  /**
   * The two tolerance windows charted in the dashboard. A PO line counts as
   * on-time when its signed day delta (actual − required) falls inside
   * [earlyDays, lateDays] AND the full quantity was delivered.
   *
   *   strict   → legend "OTD% (-3 -0)"  : may be up to 3 days early, never late
   *   tolerant → legend "OTD% (-5 +1)"  : up to 5 days early, 1 day late
   */
  windows: {
    strict:   { earlyDays: -3, lateDays: 0, label: 'OTD% (-3 -0)' },
    tolerant: { earlyDays: -5, lateDays: 1, label: 'OTD% (-5 +1)' },
  },

  /**
   * Quantity rule. 'exact'    → delivered >= required (full quantity)
   *                'tolerance'→ delivered >= required * (1 - qtyTolerance)
   *                'ignore'   → date only
   */
  quantityRule: 'exact',
  qtyTolerance: 0.0,

  /** Trailing months of actuals shown in the trend chart. */
  historyMonths: 3,

  /** KPI target line / traffic-light thresholds (percent). */
  target:  95,
  warning: 85,
  critical: 75,

  forecast: {
    /**
     * 'view'    → read pre-computed forecast rows from TABLES.otdForecast
     *             (chosen setting: Databricks provides the forecast)
     * 'compute' → least-squares projection over the actuals in the service
     * 'off'     → actuals only
     */
    source: 'view',
    /** Months projected forward when source is 'compute'. */
    months: 2,
    /** Column mapping for TABLES.otdForecast when source is 'view'. */
    columns: {
      vendorNumber  : 'SourceSystemVendorNumber',
      supplierName  : 'supplier_name',
      plantName     : 'plant',
      year          : 'year',
      month         : 'month',
      otdStrict     : 'otd_strict_pct',
      otdTolerant   : 'otd_tolerant_pct',
    },
  },

  /**
   * Trend direction thresholds, in percentage points, comparing the latest
   * actual month against the mean of the preceding months.
   */
  trend: { flatBand: 1.0 },
};

// ─── Caching ────────────────────────────────────────────────────────────────
//
// Every OData READ would otherwise open a fresh warehouse session. The
// dashboard alone issues 4+ requests, so results are memoised per SQL string.
//
const CACHE = {
  enabled : process.env.DATABRICKS_CACHE !== 'false',
  ttlMs   : Number(process.env.DATABRICKS_CACHE_TTL_MS || 5 * 60 * 1000),
  maxRows : Number(process.env.DATABRICKS_MAX_ROWS || 50000),
};

module.exports = {
  CATALOG,
  SCHEMA,
  fq,
  TABLES,
  SUPPLIER_COLUMNS,
  SPEND_COLUMNS,
  SPEND,
  PO_LINE_COLUMNS,
  COMPLIANCE_COLUMNS,
  COMPLIANCE_STANDARDS,
  COMPLIANCE_STATUS_MAP,
  OTD,
  CACHE,
};
