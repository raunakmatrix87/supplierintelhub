using suplier_intel_hub as db from '../db/schema';

// ─── Service Definition ───────────────────────────────────────────────────────

service SupplierService @(path: '/api/supplier') {

  @odata.draft.enabled
  entity Suppliers as projection on db.Suppliers {
    *,
    segment.name   as segmentName   : String @title: 'Segment',
    plant.name     as plantName     : String @title: 'Danfoss Plant',
    plant.location as plantLocation : String @title: 'Plant Location',
  }
  actions {
    action prepareForMeeting() returns String;
  };

  function getData() returns many cds.Map;
  function getSpendData() returns many cds.Map;

  /**
   * Everything the dashboard needs in a single round-trip: monthly OTD
   * (actuals + forecast), per-site OTD, the KPI roll-up and compliance.
   * The dashboard controller uses this instead of four separate reads.
   */
  function getDashboard(supplierID : String) returns cds.Map;

  /** Drops the Databricks result cache. Handy while tuning the views. */
  action refreshCache(scope : String) returns String;

  @readonly entity Segments as projection on db.Segments;
  @readonly entity Plants   as projection on db.Plants;

  entity QualityClaims      as projection on db.QualityClaims;
  entity SpendData          as projection on db.SpendData;
  entity Insights           as projection on db.Insights;
  entity Contacts           as projection on db.Contacts;
  entity PPMData            as projection on db.PPMData;
  entity PerformanceReviews as projection on db.PerformanceReviews;

  // Derived from Databricks at read time — never written through OData.
  // plantName is carried as a flat string (not plant.name) because the derived
  // rows are not guaranteed to resolve against the Plants master list.
  @readonly entity DeliveryData    as projection on db.DeliveryData;
  @readonly entity DeliveryBySite  as projection on db.DeliveryBySite;
  @readonly entity OTDSummary      as projection on db.OTDSummary;
  @readonly entity ComplianceItems as projection on db.ComplianceItems;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Analytics metadata for the dashboard charts
// ═══════════════════════════════════════════════════════════════════════════

annotate SupplierService.DeliveryData with @(
  Aggregation.ApplySupported : {
    $Type                  : 'Aggregation.ApplySupportedType',
    Transformations        : [ 'aggregate', 'groupby', 'filter', 'orderby' ],
    GroupableProperties    : [ yearMonth, monthLabel, year, month, plantName, isForecast ],
    AggregatableProperties : [
      { $Type: 'Aggregation.AggregatablePropertyType', Property: onTimePercent },
      { $Type: 'Aggregation.AggregatablePropertyType', Property: onTimePercentTolerant },
      { $Type: 'Aggregation.AggregatablePropertyType', Property: totalOrders },
      { $Type: 'Aggregation.AggregatablePropertyType', Property: onTimeOrders }
    ]
  },

  Analytics.AggregatedProperty #avgOtdStrict : {
    $Type                : 'Analytics.AggregatedPropertyType',
    Name                 : 'avgOtdStrict',
    AggregatableProperty : onTimePercent,
    AggregationMethod    : 'average',
    ![@Common.Label]     : 'OTD% (-3 -0)'
  },
  Analytics.AggregatedProperty #avgOtdTolerant : {
    $Type                : 'Analytics.AggregatedPropertyType',
    Name                 : 'avgOtdTolerant',
    AggregatableProperty : onTimePercentTolerant,
    AggregationMethod    : 'average',
    ![@Common.Label]     : 'OTD% (-5 +1)'
  }
);

annotate SupplierService.DeliveryData with @(
  UI.SelectionFields : [ yearMonth, plantName ],

  // "On Time Delivery" — monthly trend, both tolerance windows.
  UI.Chart #OtdTrend : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'On Time Delivery',
    Description     : 'Purchase order line items delivered on time to the required date and quantity, divided by total line items required.',
    ChartType       : #Column,
    Dimensions      : [ monthLabel ],
    DynamicMeasures : [
      ![@Analytics.AggregatedProperty#avgOtdStrict],
      ![@Analytics.AggregatedProperty#avgOtdTolerant]
    ],
    DimensionAttributes : [
      { $Type: 'UI.ChartDimensionAttributeType', Dimension: monthLabel, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type          : 'UI.ChartMeasureAttributeType',
        DynamicMeasure : ![@Analytics.AggregatedProperty#avgOtdStrict],
        Role           : #Axis1 },
      { $Type          : 'UI.ChartMeasureAttributeType',
        DynamicMeasure : ![@Analytics.AggregatedProperty#avgOtdTolerant],
        Role           : #Axis1 }
    ]
  },

  UI.LineItem #OtdMonths : [
    { $Type: 'UI.DataField', Value: yearMonth,             Label: 'Period' },
    { $Type: 'UI.DataField', Value: onTimePercent,         Label: 'OTD% (-3 -0)',
      Criticality: criticality },
    { $Type: 'UI.DataField', Value: onTimePercentTolerant, Label: 'OTD% (-5 +1)' },
    { $Type: 'UI.DataField', Value: onTimeOrders,          Label: 'On Time' },
    { $Type: 'UI.DataField', Value: totalOrders,           Label: 'Total' },
    { $Type: 'UI.DataField', Value: avgDelayDays,          Label: 'Avg Delay (Days)' }
  ],

  UI.DataPoint #OtdPercent : {
    $Type         : 'UI.DataPointType',
    Value         : onTimePercent,
    Title         : 'On Time Delivery',
    TargetValue   : targetPercent,
    Criticality   : criticality,
    Visualization : #Progress
  }
);

annotate SupplierService.DeliveryData with {
  onTimePercent         @Measures.Unit: '%';
  onTimePercentTolerant @Measures.Unit: '%';
  targetPercent         @Measures.Unit: '%';
};

// ─── OTD at Danfoss Sites ────────────────────────────────────────────────────

annotate SupplierService.DeliveryBySite with @(
  Aggregation.ApplySupported : {
    $Type                  : 'Aggregation.ApplySupportedType',
    Transformations        : [ 'aggregate', 'groupby', 'filter', 'orderby' ],
    GroupableProperties    : [ plantName, plantCode ],
    AggregatableProperties : [
      { $Type: 'Aggregation.AggregatablePropertyType', Property: onTimePercent },
      { $Type: 'Aggregation.AggregatablePropertyType', Property: totalOrders }
    ]
  },
  Analytics.AggregatedProperty #siteOtd : {
    $Type                : 'Analytics.AggregatedPropertyType',
    Name                 : 'siteOtd',
    AggregatableProperty : onTimePercent,
    AggregationMethod    : 'average',
    ![@Common.Label]     : 'On Time Delivery %'
  },

  UI.Chart #SiteOtd : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'On Time Delivery at Danfoss Sites',
    ChartType       : #Bar,
    Dimensions      : [ plantName ],
    DynamicMeasures : [ ![@Analytics.AggregatedProperty#siteOtd] ],
    DimensionAttributes : [
      { $Type: 'UI.ChartDimensionAttributeType', Dimension: plantName, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type          : 'UI.ChartMeasureAttributeType',
        DynamicMeasure : ![@Analytics.AggregatedProperty#siteOtd],
        Role           : #Axis1 }
    ]
  },

  UI.LineItem #Sites : [
    { $Type: 'UI.DataField', Value: plantName,     Label: 'Danfoss Site' },
    { $Type: 'UI.DataField', Value: onTimePercent, Label: 'On Time Delivery %',
      Criticality: criticality },
    { $Type: 'UI.DataField', Value: onTimeOrders,  Label: 'On Time' },
    { $Type: 'UI.DataField', Value: totalOrders,   Label: 'Total' }
  ]
);

annotate SupplierService.DeliveryBySite with {
  onTimePercent @Measures.Unit: '%';
  targetPercent @Measures.Unit: '%';
};

// ─── OTD KPI card ────────────────────────────────────────────────────────────

annotate SupplierService.OTDSummary with @(
  UI.DataPoint #Average : {
    $Type       : 'UI.DataPointType',
    Value       : averagePercent,
    Title       : 'On Time Delivery - Average Results',
    TargetValue : targetPercent,
    Criticality : criticality,
    TrendCalculation : {
      $Type                : 'UI.TrendCalculationType',
      ReferenceValue       : previousPercent,
      IsRelativeDifference : false,
      UpDifference         : 1.0,
      StrongUpDifference   : 5.0,
      DownDifference       : -1.0,
      StrongDownDifference : -5.0
    }
  }
);

annotate SupplierService.OTDSummary with {
  averagePercent @Measures.Unit: '%';
  latestPercent  @Measures.Unit: '%';
  targetPercent  @Measures.Unit: '%';
};

// ─── Overall Compliance card ─────────────────────────────────────────────────

annotate SupplierService.ComplianceItems with @(
  UI.LineItem #Compliance : [
    { $Type: 'UI.DataField', Value: standard, Label: 'Compliance Details' },
    { $Type: 'UI.DataField', Value: status,   Label: 'Status', Criticality: criticality },
    { $Type: 'UI.DataField', Value: validTo,  Label: 'Valid To' },
    { $Type: 'UI.DataField', Value: certificateNumber, Label: 'Certificate No.' }
  ],
  UI.PresentationVariant #Ordered : {
    $Type          : 'UI.PresentationVariantType',
    SortOrder      : [ { $Type: 'Common.SortOrderType', Property: sequence, Descending: false } ],
    Visualizations : [ '@UI.LineItem#Compliance' ]
  }
);

// SpendData aggregation + Spend Development chart stay where they were:
// app/supplierintelhub/annotations.cds
