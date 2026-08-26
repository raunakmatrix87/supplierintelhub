'use strict';

const CATALOG = process.env.DATABRICKS_CATALOG || 'bs_db_dev';
const SCHEMA = process.env.DATABRICKS_SCHEMA || 'proc_silver';
const SCHEMA_Gold = process.env.DATABRICKS_SCHEMA_Gold || 'proc_gold';
const fq = (object) => `${CATALOG}.${SCHEMA}.\`${object}\``;
const fqg = (object) => `${CATALOG}.${SCHEMA_Gold}.\`${object}\``;

const PPM_CATALOG = process.env.DATABRICKS_PPM_CATALOG || 'bs_db_sql_bs_reporting';
const PPM_SCHEMA = process.env.DATABRICKS_PPM_SCHEMA || 'dbo';
const fqPpm = (object) => `${PPM_CATALOG}.${PPM_SCHEMA}.\`${object}\``;

const TABLES = {
  supplierList : 'fiori_mv_supplier_list',
  spendByYear  : 'fiori_transactional_2021_to_current_year',
  compliance   : 'compliance',
  vendorMaster : 'd_vendormaster',
  otdForecast  : 'fiori_mv_otd_forecast',
  ppmData      : 'q_ppm_opm2',
  otdData      : 'q_otd',};

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

// Source: fiori_transactional_2021_to_current_year (proc_gold).
// The table is at material/plant grain; spend is summed per vendor + year in SQL.
// supplierName is not carried on the fact table - it is filled from the supplier
// list at map time. Set it here only if a name column is ever added.
const SPEND_COLUMNS = {
  vendorNumber : 'sourcesystem_vendornumber',
  supplierName : null,
  year         : 'apd_year',
  amount       : 'total_spend',
};

// NOTE: the service does not read SPEND.periods - the 3/5/All toggle lives in
// app/.../ext/view/SupplierObjectPage.controller.js (PERIOD_YEARS/DEFAULT_PERIOD)
// and filters client-side. SpendData always returns every year. Kept here so the
// two stay documented together; change the controller to change the UI default.
const SPEND = {
  periods: [
    { key: '3',   label: 'Last 3 Years', years: 3 },
    { key: '5',   label: 'Last 5 Years', years: 5 },
    { key: 'all', label: 'All',          years: null },
  ],
  defaultPeriod: 'all',

  fallbackColumn: null,
  fallbackFormat: null,
};

const PPM_COLUMNS = {
  vendorNumber : 'Vendor',
  yearMonth    : 'Cal. year / month',
  ppm          : 'Total PPM Qty',
};

const OPM_COLUMNS = {
  vendorNumber    : 'Vendor',
  yearMonth       : 'Cal. year / month',
  notifications   : 'Total no. of Notifications',
  goodsReceiptQty : 'Actual Goods Receipt QTY',
};
const OTD_COLUMNS = {
  sourceSystemId : 'Source system ID',
  vendor         : 'Vendor',
  yearMonth      : 'Requested Year/Month',
  early3         : '3 days early (no of lines)',
  early2         : '2 days early (no of lines)',
  early1         : '1 day early (no of lines)',
  onTime         : 'On time (no of lines)',
  delay1         : '1 day delay (no of lines)',
  totalLines     : 'Total Lines',
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
  aribaId           : 'aribaid',
  supplierName      : 'onecompanyname',
  waiver            : 'waver',
  activityPerformed : 'activityperformedatthislocation',
};

const COMPLIANCE_WAIVER_VALUES = ['yes', 'y', 'true'];

const COMPLIANCE_NOT_RELEVANT_VALUES = ['not relevant', 'not revelant'];

const VENDOR_MASTER_COLUMNS = {
  aribaId            : 'aribaid',
  vendorNumber       : 'vendornumber',
  sourceVendorNumber : 'sourcesystem_vendornumber',
  vendorName         : 'vendorname',
};

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
  SCHEMA_Gold,
  fq,
  fqg,
  PPM_CATALOG,
  PPM_SCHEMA,
  fqPpm,
  TABLES,
  SUPPLIER_COLUMNS,
  SPEND_COLUMNS,
  SPEND,
  PPM_COLUMNS,
  OPM_COLUMNS,
  OTD_COLUMNS,
  PO_LINE_COLUMNS,
  COMPLIANCE_COLUMNS,
  COMPLIANCE_STANDARDS,
  COMPLIANCE_WAIVER_VALUES,
  COMPLIANCE_NOT_RELEVANT_VALUES,
  VENDOR_MASTER_COLUMNS,
  OTD,
  CACHE,
};