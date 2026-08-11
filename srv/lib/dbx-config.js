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
  compliance   : 'fiori_mv_supplier_compliance',
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

const COMPLIANCE_COLUMNS = {
  vendorNumber  : 'SourceSystemVendorNumber',
  supplierName  : 'supplier_name',
  standard      : 'standard',
  status        : 'status',
  validFrom     : 'valid_from',
  validTo       : 'valid_to',
  certificateNo : 'certificate_number',
  plantName     : 'plant',
};

const COMPLIANCE_STANDARDS = [
  { key: 'iso9001',   label: 'ISO 9001',   sequence: 10 },
  { key: 'iatf16949', label: 'IATF 16949', sequence: 20 },
  {
    key      : 'fwa',
    label    : 'Framework Agreement FWA',
    sequence : 30,
    aliases  : ['frameworkagreement', 'frameworkagreementfwa'],
  },
  {
    key      : 'codeofconduct',
    label    : 'Code of Conduct',
    sequence : 40,
    aliases  : ['coc'],
  },
];

const COMPLIANCE_STATUS_MAP = {
  compliant       : 'Compliant',
  yes             : 'Compliant',
  y               : 'Compliant',
  true            : 'Compliant',
  valid           : 'Compliant',
  active          : 'Compliant',
  certified       : 'Compliant',
  ok              : 'Compliant',

  noncompliant    : 'Noncompliant',
  'non-compliant' : 'Noncompliant',
  no              : 'Noncompliant',
  n               : 'Noncompliant',
  false           : 'Noncompliant',
  invalid         : 'Noncompliant',
  expired         : 'Noncompliant',
  failed          : 'Noncompliant',
};

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
  COMPLIANCE_STATUS_MAP,
  OTD,
  CACHE,
};