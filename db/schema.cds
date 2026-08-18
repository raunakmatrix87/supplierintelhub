namespace suplier_intel_hub;

using { managed } from '@sap/cds/common';

// Human-readable string keys.
// For Suppliers, ID holds the Databricks business key SourceSystemVendorNumber
// verbatim. Reference data (Segments, Plants) uses IDs like SEG-MEC, PLT-AR.
aspect sid { key ID : String(40); }

// ─── Reference / Master Data ────────────────────────────────────────────────

entity Segments : sid {
  name : String(100) @title: 'Segment';
}

entity Plants : sid {
  name     : String(100) @title: 'Plant';
  location : String(100) @title: 'Location';
}

// ─── Core Supplier ──────────────────────────────────────────────────────────

// ID = SourceSystemVendorNumber (unique per row in fiori_mv_supplier_list).
// vendorNumber repeats the key as a displayable field.
entity Suppliers : sid, managed {
  vendorNumber       : String(40)         @title: 'Vendor Number';
  name               : String(200)        @title: 'Supplier Name'         @mandatory;
  segment            : Association to Segments;
  plant              : Association to Plants;
  // Databricks delivers segment and plant as plain strings, not as keys into
  // the master lists, so they are carried flat as well.
  segmentText        : String(100)        @title: 'Segment';
  plantText          : String(100)        @title: 'Danfoss Plant';
  responsible        : String(100)        @title: 'Supplier Responsible';
  category           : String(100)        @title: 'Category';
  subcategory        : String(100)        @title: 'Subcategory';
  mainSupplies       : String(500)        @title: 'Main Supplies';
  score              : Decimal(3,1)       @title: 'Score';
  nextReview         : Date               @title: 'Next Review';
  complianceStatus   : String(30)         @title: 'Compliance Status'
    @assert.range enum {
      OK            = 'OK';
      UpcomingRenew = 'UpcomingRenew';
      Expired       = 'Expired';
    };
  isTopSupplier      : Boolean            @title: 'Top Supplier'          default false;
  // KPIs delivered ready-made by fiori_mv_supplier_list.
  // currentPPM and currentOTD are `double` in Databricks, hence Decimal here.
  activeQualityClaims : Integer           @title: 'Active Quality Claims'  @Core.Computed;
  currentPPM          : Decimal(9,2)      @title: 'Current PPM'            @Core.Computed;
  currentOTD          : Decimal(5,2)      @title: 'On-Time Delivery %'    @Core.Computed;

  // Associations
  qualityClaims  : Composition of many QualityClaims  on qualityClaims.supplier = $self;
  spendData      : Composition of many SpendData      on spendData.supplier     = $self;
  deliveryData   : Composition of many DeliveryData   on deliveryData.supplier  = $self;
  ppmData        : Composition of many PPMData        on ppmData.supplier       = $self;
  insights       : Composition of many Insights       on insights.supplier      = $self;
  contacts       : Composition of many Contacts       on contacts.supplier      = $self;
  performanceReviews : Composition of many PerformanceReviews on performanceReviews.supplier = $self;

  // Dashboard datasets (all derived from Databricks at read time)
  deliveryBySite  : Composition of many DeliveryBySite  on deliveryBySite.supplier  = $self;
  complianceItems : Composition of many ComplianceItems on complianceItems.supplier = $self;
  otdSummary      : Composition of many OTDSummary      on otdSummary.supplier      = $self;
}

// ─── Quality Claims ─────────────────────────────────────────────────────────

entity QualityClaims : sid, managed {
  supplier    : Association to Suppliers;
  claimNumber : String(50)   @title: 'Claim Number';
  status      : String(30)   @title: 'Status'
    @assert.range enum {
      Active   = 'Active';
      Resolved = 'Resolved';
      Pending  = 'Pending';
    };
  severity    : String(20)   @title: 'Severity'
    @assert.range enum {
      High   = 'High';
      Medium = 'Medium';
      Low    = 'Low';
    };
  description : String(500)  @title: 'Description';
  reportedAt  : Date         @title: 'Reported Date';
  resolvedAt  : Date         @title: 'Resolved Date';
  amount      : Decimal(15,2) @title: 'Claim Amount (EUR)';
}

// ─── Spend Data (yearly) ────────────────────────────────────────────────────
//
// Maps fiori_mv_spend_by_year one-to-one. The grain is one row per vendor per
// YEAR — the source has no month or date column, so `year` is the chart
// dimension. (An earlier draft assumed a monthly `date`; that was wrong.)
//
entity SpendData : sid {
  supplier     : Association to Suppliers;
  vendorNumber : String(40)     @title: 'Vendor Number';
  supplierName : String(200)    @title: 'Supplier';
  year         : Integer        @title: 'Year';          // chart dimension
  yearLabel    : String(4)      @title: 'Year';          // string axis label
  amount       : Decimal(15,2)  @title: 'Spend Amount (EUR)';
}

// ─── On-Time Delivery (monthly) ─────────────────────────────────────────────
//
// Derived in the service from the Databricks PO line-item view:
//   OTD% = on-time line items / total required line items
// Two tolerance windows are carried so the trend chart can plot both series
// without a second warehouse round-trip.
//
entity DeliveryData : sid {
  supplier       : Association to Suppliers;
  plant          : Association to Plants;
  plantName      : String(100)   @title: 'Danfoss Site';

  year           : Integer       @title: 'Year';
  month          : Integer       @title: 'Month';  // 1-12
  yearMonth      : String(7)     @title: 'Period';        // '2025-07' — chart dimension
  monthLabel     : String(12)    @title: 'Month';         // 'Jul'     — chart axis label

  // Primary series, legend "OTD% (-3 -0)": up to 3 days early, never late.
  onTimePercent         : Decimal(5,2) @title: 'On-Time Delivery %';
  // Secondary series, legend "OTD% (-5 +1)": up to 5 days early, 1 day late.
  onTimePercentTolerant : Decimal(5,2) @title: 'OTD % (-5 +1)';

  totalOrders          : Integer      @title: 'Total Line Items';
  onTimeOrders         : Integer      @title: 'On-Time Line Items';
  onTimeOrdersTolerant : Integer      @title: 'On-Time Line Items (-5 +1)';
  avgDelayDays         : Decimal(6,2) @title: 'Avg Delay (Days)';

  targetPercent  : Decimal(5,2)  @title: 'Target %';
  // Forecast periods render as the dotted continuation of the line.
  isForecast     : Boolean       @title: 'Forecast'  default false;
  criticality    : Integer       @title: 'Criticality';   // 0 none 1 neg 2 crit 3 pos
}

// ─── On-Time Delivery per Danfoss site ──────────────────────────────────────
//
// Feeds the "On Time Delivery at Danfoss Sites" horizontal bar chart.
//
entity DeliveryBySite : sid {
  supplier       : Association to Suppliers;
  plant          : Association to Plants;
  plantName      : String(100)   @title: 'Danfoss Site';
  plantCode      : String(40)    @title: 'Plant Code';

  onTimePercent         : Decimal(5,2) @title: 'On-Time Delivery %';
  onTimePercentTolerant : Decimal(5,2) @title: 'OTD % (-5 +1)';

  totalOrders    : Integer       @title: 'Total Line Items';
  onTimeOrders   : Integer       @title: 'On-Time Line Items';

  fromPeriod     : String(7)     @title: 'From Period';
  toPeriod       : String(7)     @title: 'To Period';
  targetPercent  : Decimal(5,2)  @title: 'Target %';
  criticality    : Integer       @title: 'Criticality';
}

// ─── On-Time Delivery KPI roll-up ───────────────────────────────────────────
//
// Feeds the "On Time Delivery - Average Results" card: the big 82.1% number
// plus the trend arrow and "Trending Down" text.
//
entity OTDSummary : sid {
  supplier        : Association to Suppliers;
  averagePercent  : Decimal(5,1)  @title: 'Average OTD %';
  latestPercent   : Decimal(5,2)  @title: 'Latest Month %';
  previousPercent : Decimal(5,2)  @title: 'Previous Month %';
  deltaPercent    : Decimal(6,2)  @title: 'Change (pp)';
  trend           : String(10)    @title: 'Trend'
    @assert.range enum {
      Up   = 'Up';
      Down = 'Down';
      Flat = 'Flat';
    };
  trendDirection  : Integer       @title: 'Trend Direction';   // 1 / 0 / -1
  periodCount     : Integer       @title: 'Periods';
  fromPeriod      : String(7)     @title: 'From Period';
  toPeriod        : String(7)     @title: 'To Period';
  targetPercent   : Decimal(5,2)  @title: 'Target %';
  criticality     : Integer       @title: 'Criticality';
}

// ─── Overall Compliance ─────────────────────────────────────────────────────
//
// Two rows per supplier: 'ISO 14001' (date-only) and 'ISO 9001 / IATF 16949'
// (either date, or a waiver, or activity marked Not relevant). The service
// always emits both, so a supplier with nothing on file shows as 'Noncompliant'
// rather than silently dropping off the card. The rules live in
// COMPLIANCE_STANDARDS — see srv/lib/dbx-config.js and srv/lib/compliance.js.
//
entity ComplianceItems : sid {
  supplier          : Association to Suppliers;
  // Both ends of the key chain, kept on the row so a broken join is visible in
  // the payload: aribaId is what the compliance table carries, vendorNumber is
  // what it resolved to via d_vendormaster (and equals supplier_ID).
  aribaId           : String(40)  @title: 'Ariba ID';
  vendorNumber      : String(40)  @title: 'Vendor Number';
  standardKey       : String(40)  @title: 'Standard Key';
  standard          : String(100) @title: 'Standard';
  status            : String(20)  @title: 'Status'
    @assert.range enum {
      Compliant    = 'Compliant';
      Noncompliant = 'Noncompliant';
      Unknown      = 'Unknown';
    };
  // Why the status reads the way it does: Certificate | Waiver | Not relevant |
  // Expired | None. Diagnostic only — not rendered on the card.
  basis             : String(20)  @title: 'Basis';
  validFrom         : Date        @title: 'Valid From';
  validTo           : Date        @title: 'Valid To';
  certificateNumber : String(100) @title: 'Certificate No.';
  plantName         : String(100) @title: 'Plant';
  sequence          : Integer     @title: 'Sequence';
  criticality       : Integer     @title: 'Criticality';
}

// ─── Parts Per Million (monthly defect rate) ────────────────────────────────
//
// Maps q_ppm_opm2 one-to-one. `Cal. year / month`
// arrives as 'mm.yyyy' (e.g. '04.2026'); it is split into numeric year/month
// plus a short calendar label ('Apr') for chart axes — mirroring the
// year/month + monthLabel pair already used on DeliveryData.
//
entity PPMData : sid {
  supplier   : Association to Suppliers;
  year       : Integer       @title: 'Year';
  month      : Integer       @title: 'Month';  // 1-12
  monthLabel : String(12)    @title: 'Month';  // 'Apr' — chart axis label
  // 'YYYY-MM'. The monthly chart groups on this rather than monthLabel so the
  // same month in two different years stays two columns instead of averaging
  // into one.
  yearMonth  : String(7)     @title: 'Period';
  ppm        : Integer       @title: 'PPM';
  target     : Integer       @title: 'Target PPM' default 500;
}

// ─── AI-Generated Insights ──────────────────────────────────────────────────

entity Insights : sid, managed {
  supplier    : Association to Suppliers;
  type        : String(50)   @title: 'Insight Type'
    @assert.range enum {
      PPMAlert        = 'PPMAlert';
      OTDAlert        = 'OTDAlert';
      SpendAnomaly    = 'SpendAnomaly';
      ComplianceAlert = 'ComplianceAlert';
      PositiveTrend   = 'PositiveTrend';
    };
  title       : String(200)  @title: 'Title';
  urgency     : String(30)   @title: 'Urgency'
    @assert.range enum {
      ImmediateAction   = 'ImmediateAction';
      RequiresAttention = 'RequiresAttention';
      Informational     = 'Informational';
    };
  description : String(1000) @title: 'Description';
  value       : Decimal(15,2) @title: 'Current Value';
  target      : Decimal(15,2) @title: 'Target Value';
  unit        : String(20)   @title: 'Unit';
  isActive    : Boolean      @title: 'Active' default true;
}

// ─── Contacts ───────────────────────────────────────────────────────────────

entity Contacts : sid {
  supplier  : Association to Suppliers;
  name      : String(100) @title: 'Name';
  role      : String(100) @title: 'Role';
  email     : String(200) @title: 'Email';
  phone     : String(50)  @title: 'Phone';
  isPrimary : Boolean     @title: 'Primary Contact' default false;
}

// ─── Performance Reviews ────────────────────────────────────────────────────

entity PerformanceReviews : sid, managed {
  supplier    : Association to Suppliers;
  reviewDate  : Date         @title: 'Review Date';
  reviewer    : String(100)  @title: 'Reviewer';
  overallScore: Decimal(3,1) @title: 'Overall Score';
  qualityScore: Decimal(3,1) @title: 'Quality Score';
  delivScore  : Decimal(3,1) @title: 'Delivery Score';
  serviceScore: Decimal(3,1) @title: 'Service Score';
  notes       : String(1000) @title: 'Notes';
  status      : String(30)   @title: 'Status'
    @assert.range enum {
      Draft     = 'Draft';
      Submitted = 'Submitted';
      Approved  = 'Approved';
    };
}