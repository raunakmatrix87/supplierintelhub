namespace suplier_intel_hub;

using { managed } from '@sap/cds/common';

// Human-readable string keys (data uses IDs like SUP-001, SEG-MEC, PLT-AR)
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

entity Suppliers : sid, managed {
  name               : String(200)        @title: 'Supplier Name'         @mandatory;
  segment            : Association to Segments;
  plant              : Association to Plants;
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
  // Virtual KPIs (computed in service)
  activeQualityClaims : Integer           @title: 'Active Quality Claims'  @Core.Computed;
  currentPPM          : Integer           @title: 'Current PPM'            @Core.Computed;
  currentOTD          : Decimal(5,2)      @title: 'On-Time Delivery %'    @Core.Computed;

  // Associations
  qualityClaims  : Composition of many QualityClaims  on qualityClaims.supplier = $self;
  spendData      : Composition of many SpendData      on spendData.supplier     = $self;
  deliveryData   : Composition of many DeliveryData   on deliveryData.supplier  = $self;
  ppmData        : Composition of many PPMData        on ppmData.supplier       = $self;
  insights       : Composition of many Insights       on insights.supplier      = $self;
  contacts       : Composition of many Contacts       on contacts.supplier      = $self;
  performanceReviews : Composition of many PerformanceReviews on performanceReviews.supplier = $self;
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

entity SpendData : sid {
  supplier : Association to Suppliers;
  year     : Integer  @title: 'Year';
  amount   : Decimal(15,2) @title: 'Spend Amount (EUR)';
}

// ─── On-Time Delivery (monthly) ─────────────────────────────────────────────

entity DeliveryData : sid {
  supplier       : Association to Suppliers;
  year           : Integer       @title: 'Year';
  month          : Integer       @title: 'Month';  // 1-12
  onTimePercent  : Decimal(5,2)  @title: 'On-Time Delivery %';
  totalOrders    : Integer       @title: 'Total Orders';
  onTimeOrders   : Integer       @title: 'On-Time Orders';
}

// ─── Parts Per Million (monthly defect rate) ────────────────────────────────

entity PPMData : sid {
  supplier   : Association to Suppliers;
  year       : Integer       @title: 'Year';
  month      : Integer       @title: 'Month';  // 1-12
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
