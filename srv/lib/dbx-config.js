'use strict';

const CATALOG = process.env.DATABRICKS_CATALOG || 'bs_db_dev';
const SCHEMA = process.env.DATABRICKS_SCHEMA || 'proc_silver';
const fq = (object) => `${CATALOG}.${SCHEMA}.\`${object}\``;

// PPM lives in the SQL-Server-backed reporting catalog, not proc_silver, so it
// needs its own catalog/schema pair. These carry defaults for the same reason
// CATALOG/SCHEMA do — without them fqPpm() silently produced
// "undefined.undefined.`q_ppm_opm2`" and every PPM read failed with a 502,
// which the charts render as an empty "No data" plot.
const PPM_CATALOG = process.env.DATABRICKS_PPM_CATALOG || 'bs_db_sql_bs_reporting';
const PPM_SCHEMA = process.env.DATABRICKS_PPM_SCHEMA || 'dbo';
const fqPpm = (object) => `${PPM_CATALOG}.${PPM_SCHEMA}.\`${object}\``;

const TABLES = {
  supplierList : 'fiori_mv_supplier_list',
  spendByYear  : 'fiori_mv_spend_by_year',
  poLines      : 'fiori_mv_po_lines',
  // Wide table: one row per company, one expiry-date column per standard.
  compliance   : 'compliance',
  // Vendor master — the only place aribaid and the SAP vendor number meet.
  vendorMaster : 'd_vendormaster',
  otdForecast  : 'fiori_mv_otd_forecast',
  ppmData      : 'q_ppm_opm2',
};

const SUPPLIER_COLUMNS = {
  vendorNumber        : 'SourceSystemVendorNumber',
  name                : 'name',
  segment             : 'segment',
  plant               : 'plant',
  responsible         : 'responsible',
  category            : 'category',
  subcategory         : 'subcategory',
  mainSupplies        : 'mainSupplies',
  score               : 'score',
  nextReview          : 'nextReview',
  complianceStatus    : 'complianceStatus',
  isTopSupplier       : 'isTopSupplier',
  activeQualityClaims : 'activeQualityClaims',
  currentPPM          : 'currentPPM',
  currentOTD          : 'currentOTD',
  spendData           : 'spendData',
  plantLocation       : null,
};

const SPEND_COLUMNS = {
  vendorNumber : 'SourceSystemVendorNumber',
  supplierName : 'supplier',
  year         : 'year',
  amount       : 'spend',
};

const SPEND = {
  periods: [
    { key: '3',   label: 'Last 3 Years', years: 3 },
    { key: '5',   label: 'Last 5 Years', years: 5 },
    { key: 'all', label: 'All',          years: null },
  ],
  defaultPeriod: '3',

  fallbackColumn: null,
  fallbackFormat: null,
};

const PPM_COLUMNS = {
  vendorNumber : 'Vendor',
  yearMonth    : 'Cal. year / month',
  ppm          : 'Total PPM Qty',
};

const PO_LINE_COLUMNS = {
  vendorNumber      : 'SourceSystemVendorNumber',
  supplierName      : 'supplier_name',
  plantName         : 'plant',
  plantCode         : 'plant_code',
  segment           : 'segment',
  poNumber          : 'po_number',
  poLineNumber      : 'po_line_number',
  requiredDate      : 'required_date',
  actualDate        : 'actual_delivery_date',
  requiredQty       : 'required_quantity',
  deliveredQty      : 'delivered_quantity',
  deliveryDeltaDays : null,
};

// bs_db_dev.proc_silver.compliance is a WIDE table: one row per company, with
// a separate expiry-date column per certification. There is no status column —
// the state is derived from the date (see COMPLIANCE_STANDARDS below).
//
// It carries `aribaid`, NOT the SAP vendor number that Suppliers.ID is built
// from, so it is joined to the vendor master to get there (see below).
const COMPLIANCE_COLUMNS = {
  aribaId           : 'aribaid',
  supplierName      : 'onecompanyname',
  // Escape hatches for the combined ISO 9001 / IATF row. `waver` is spelt that
  // way in the source table — not a typo here.
  waiver            : 'waver',
  activityPerformed : 'activityperformedatthislocation',
};

/** Values of `waver` that count as a granted waiver. Compared case-insensitively. */
const COMPLIANCE_WAIVER_VALUES = ['yes', 'y', 'true'];

/**
 * Values of `activityperformedatthislocation` that make a certificate moot.
 * Punctuation and spacing are stripped before comparing, and both the correct
 * and the transposed spelling are accepted because the source data uses
 * 'Not Revelant'.
 */
const COMPLIANCE_NOT_RELEVANT_VALUES = ['not relevant', 'not revelant'];

// d_vendormaster is the bridge: aribaid (9004722) ↔ vendornumber (1102524)
// ↔ sourcesystem_vendornumber ('01/1102524'). Suppliers.ID is the
// SourceSystemVendorNumber of fiori_mv_supplier_list, so the join carries both
// candidate keys and the resolver picks whichever one the supplier list knows.
const VENDOR_MASTER_COLUMNS = {
  aribaId            : 'aribaid',
  vendorNumber       : 'vendornumber',
  sourceVendorNumber : 'sourcesystem_vendornumber',
  vendorName         : 'vendorname',
};

/**
 * The two rows of the Overall Compliance card, in display order.
 *
 *   dateColumns      expiry columns to consider. ANY one of them still valid
 *                    (>= today) makes the row Compliant.
 *   allowWaiver      `waver` = YES also makes it Compliant.
 *   allowNotRelevant `activityperformedatthislocation` = 'Not relevant' also
 *                    makes it Compliant.
 *
 * With none of the above satisfied the row is Noncompliant — which is also what
 * a missing (null) date yields, since a certificate that was never captured is
 * not evidence of anything.
 *
 * Row 1 is deliberately date-only: an ISO 14001 certificate is either live or
 * it is not, and no waiver overrides that. Row 2 is the combined business rule.
 */
const COMPLIANCE_STANDARDS = [
  {
    key              : 'iso14001',
    label            : 'ISO 14001',
    sequence         : 10,
    dateColumns      : ['iso14001expirydate'],
    allowWaiver      : false,
    allowNotRelevant : false,
  },
  {
    key              : 'iso9001iatf',
    label            : 'ISO 9001 / IATF 16949',
    sequence         : 20,
    dateColumns      : ['iso9001expirydate', 'iatf16949expirydate'],
    allowWaiver      : true,
    allowNotRelevant : true,
  },
];


const OTD = {
  windows: {
    strict   : { earlyDays: -3, lateDays: 0, label: 'OTD% (-3 -0)' },
    tolerant : { earlyDays: -5, lateDays: 1, label: 'OTD% (-5 +1)' },
  },

  quantityRule : 'exact',
  qtyTolerance : 0.0,

  historyMonths: 3,

  target   : 95,
  warning  : 85,
  critical : 75,

  forecast: {
    source  : 'view',
    months  : 2,
    columns : {
      vendorNumber : 'SourceSystemVendorNumber',
      supplierName : 'supplier_name',
      plantName    : 'plant',
      year         : 'year',
      month        : 'month',
      otdStrict    : 'otd_strict_pct',
      otdTolerant  : 'otd_tolerant_pct',
    },
  },

  trend: { flatBand: 1.0 },
};

const CACHE = {
  enabled : process.env.DATABRICKS_CACHE !== 'false',
  ttlMs   : Number(process.env.DATABRICKS_CACHE_TTL_MS || 5 * 60 * 1000),
  maxRows : Number(process.env.DATABRICKS_MAX_ROWS || 50000),
};

module.exports = {
  CATALOG,
  SCHEMA,
  fq,
  PPM_CATALOG,
  PPM_SCHEMA,
  fqPpm,
  TABLES,
  SUPPLIER_COLUMNS,
  SPEND_COLUMNS,
  SPEND,
  PPM_COLUMNS,
  PO_LINE_COLUMNS,
  COMPLIANCE_COLUMNS,
  COMPLIANCE_STANDARDS,
  COMPLIANCE_WAIVER_VALUES,
  COMPLIANCE_NOT_RELEVANT_VALUES,
  VENDOR_MASTER_COLUMNS,
  OTD,
  CACHE,
};