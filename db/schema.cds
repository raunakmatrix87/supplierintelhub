namespace suplier_intel_hub;

using { managed } from '@sap/cds/common';

aspect sid { key ID : String(40); }

entity Segments : sid {
  name : String(100) @title: 'Segment';
}

entity Plants : sid {
  name     : String(100) @title: 'Plant';
  location : String(100) @title: 'Location';
}

entity Suppliers : sid, managed {
  vendorNumber       : String(40)         @title: 'Vendor Number';
  name               : String(200)        @title: 'Supplier Name'         @mandatory;
  segment            : Association to Segments;
  plant              : Association to Plants;
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
  activeQualityClaims : Integer           @title: 'Active Quality Claims'  @Core.Computed;
  currentPPM          : Decimal(9,2)      @title: 'Current PPM'            @Core.Computed;
  currentOTD          : Decimal(5,2)      @title: 'On-Time Delivery %'    @Core.Computed;
  qualityClaims  : Composition of many QualityClaims  on qualityClaims.supplier = $self;
  spendData      : Composition of many SpendData      on spendData.supplier     = $self;
  deliveryData   : Composition of many DeliveryData   on deliveryData.supplier  = $self;
  ppmData        : Composition of many PPMData        on ppmData.supplier       = $self;
  insights       : Composition of many Insights       on insights.supplier      = $self;
  contacts       : Composition of many Contacts       on contacts.supplier      = $self;
  performanceReviews : Composition of many PerformanceReviews on performanceReviews.supplier = $self;
  deliveryBySite  : Composition of many DeliveryBySite  on deliveryBySite.supplier  = $self;
  complianceItems : Composition of many ComplianceItems on complianceItems.supplier = $self;
  otdSummary      : Composition of many OTDSummary      on otdSummary.supplier      = $self;
  opmData         : Composition of many OPMData         on opmData.supplier        = $self; 
  otdData         : Composition of many OTDData         on otdData.supplier        = $self;
}

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

entity SpendData : sid {
  supplier     : Association to Suppliers;
  vendorNumber : String(40)     @title: 'Vendor Number';
  supplierName : String(200)    @title: 'Supplier';
  year         : Integer        @title: 'Year';
  yearLabel    : String(4)      @title: 'Year';
  amount       : Decimal(15,2)  @title: 'Spend Amount (EUR)';
}

entity DeliveryData : sid {
  supplier       : Association to Suppliers;
  plant          : Association to Plants;
  plantName      : String(100)   @title: 'Danfoss Site';

  year           : Integer       @title: 'Year';
  month          : Integer       @title: 'Month';
  yearMonth      : String(7)     @title: 'Period';
  monthLabel     : String(12)    @title: 'Month';
  onTimePercent         : Decimal(5,2) @title: 'On-Time Delivery %';
  onTimePercentTolerant : Decimal(5,2) @title: 'OTD % (-5 +1)';

  totalOrders          : Integer      @title: 'Total Line Items';
  onTimeOrders         : Integer      @title: 'On-Time Line Items';
  onTimeOrdersTolerant : Integer      @title: 'On-Time Line Items (-5 +1)';
  avgDelayDays         : Decimal(6,2) @title: 'Avg Delay (Days)';

  targetPercent  : Decimal(5,2)  @title: 'Target %';
  isForecast     : Boolean       @title: 'Forecast'  default false;
  criticality    : Integer       @title: 'Criticality';
}

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
  trendDirection  : Integer       @title: 'Trend Direction';
  periodCount     : Integer       @title: 'Periods';
  fromPeriod      : String(7)     @title: 'From Period';
  toPeriod        : String(7)     @title: 'To Period';
  targetPercent   : Decimal(5,2)  @title: 'Target %';
  criticality     : Integer       @title: 'Criticality';
}

entity ComplianceItems : sid {
  supplier          : Association to Suppliers;
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
  basis             : String(20)  @title: 'Basis';
  validFrom         : Date        @title: 'Valid From';
  validTo           : Date        @title: 'Valid To';
  certificateNumber : String(100) @title: 'Certificate No.';
  plantName         : String(100) @title: 'Plant';
  sequence          : Integer     @title: 'Sequence';
  criticality       : Integer     @title: 'Criticality';
}

entity PPMData : sid {
  supplier   : Association to Suppliers;
  year       : Integer       @title: 'Year';
  month      : Integer       @title: 'Month';
  monthLabel : String(12)    @title: 'Month';
  yearMonth  : String(7)     @title: 'Period';
  ppm        : Integer       @title: 'PPM';
  target     : Integer       @title: 'Target PPM' default 500;
}

entity OPMData : sid {
  supplier   : Association to Suppliers;
  year       : Integer       @title: 'Year';
  month      : Integer       @title: 'Month';
  monthLabel : String(12)    @title: 'Month';
  opm        : Integer       @title: 'OPM';
}

entity OTDData : sid {
  supplier   : Association to Suppliers;
  year       : Integer       @title: 'Year';
  month      : Integer       @title: 'Month';
  monthLabel : String(12)    @title: 'Month';
  yearMonth  : String(7)     @title: 'Period';
  otd        : Decimal(5,2)  @title: 'OTD %';
}

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

entity Contacts : sid {
  supplier  : Association to Suppliers;
  name      : String(100) @title: 'Name';
  role      : String(100) @title: 'Role';
  email     : String(200) @title: 'Email';
  phone     : String(50)  @title: 'Phone';
  isPrimary : Boolean     @title: 'Primary Contact' default false;
}

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