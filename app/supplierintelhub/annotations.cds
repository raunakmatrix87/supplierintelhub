using SupplierService as service from '../../srv/cat-service';

// ─── Suppliers: List Report + Object Page header ─────────────────────────────
annotate service.Suppliers with @(
  UI.HeaderInfo : { $Type:'UI.HeaderInfoType', TypeName:'Supplier', TypeNamePlural:'Suppliers',
    Title:{$Type:'UI.DataField',Value:name}, Description:{$Type:'UI.DataField',Value:segmentName} },
  UI.SelectionFields : [ segmentName, plantName, responsible, complianceStatus ],
  UI.LineItem : [
    {$Type:'UI.DataField',Value:name,Label:'Name',![@UI.Importance]:#High},
    {$Type:'UI.DataField',Value:segmentName,Label:'Segment',![@UI.Importance]:#High},
    {$Type:'UI.DataField',Value:plantName,Label:'Danfoss Plant',![@UI.Importance]:#High},
    {$Type:'UI.DataField',Value:responsible,Label:'Supplier Responsible',![@UI.Importance]:#High}
  ],
  UI.SelectionVariant #All : { $Type:'UI.SelectionVariantType', Text:'All Suppliers', SelectOptions:[] },
  UI.SelectionVariant #Mine : { $Type:'UI.SelectionVariantType', Text:'My Suppliers',
    SelectOptions:[{$Type:'UI.SelectOptionType',PropertyName:responsible,
      Ranges:[{$Type:'UI.SelectionRangeType',Sign:#I,Option:#EQ,Low:'Sarah P.'}]}] }
);

// ─── SpendData: aggregation + Spend Development column chart ──────────────────
//
// fiori_mv_spend_by_year is one row per vendor per YEAR — there is no date or
// month column, so `year` is both the filter field and the chart dimension.
// The object page's period buttons (Last 3 / 5 / All Years) apply a numeric
// "year >= " condition on this field instead of the old semantic-date filter.
annotate service.SpendData with @(
  Aggregation.ApplySupported : {
    $Type                  : 'Aggregation.ApplySupportedType',
    Transformations        : [ 'aggregate', 'groupby', 'filter' ],
    GroupableProperties    : [ year ],
    AggregatableProperties : [ { $Type:'Aggregation.AggregatablePropertyType', Property: amount } ]
  },
  Analytics.AggregatedProperty #totalSpend : {
    $Type                : 'Analytics.AggregatedPropertyType',
    Name                 : 'totalSpend',
    AggregatableProperty : amount,
    AggregationMethod    : 'sum',
    ![@Common.Label]     : 'Spend Amount (EUR)'
  },
  // year is the filterable field driven by the period buttons (hidden FilterBar)
  UI.SelectionFields : [ year ],
  UI.Chart : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'Spend Development',
    ChartType       : #Column,
    Dimensions      : [ year ],
    DynamicMeasures : [ ![@Analytics.AggregatedProperty#totalSpend] ],
    DimensionAttributes : [
      { $Type:'UI.ChartDimensionAttributeType', Dimension: year, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type:'UI.ChartMeasureAttributeType',
        DynamicMeasure: ![@Analytics.AggregatedProperty#totalSpend], Role: #Axis1 }
    ]
  }
);

// ─── PPMData: aggregation + two Parts Per Million column charts ───────────────
//
// q_ppm_opm2 is one row per vendor per MONTH. Both charts read the same rows
// and differ only in the grouping dimension:
//
//   #PpmTrend — average PPM per calendar month ('YYYY-MM'), the running trend
//   #PpmYoY   — average PPM per year, the year-over-year comparison
//
// Averaging is deliberate: PPM is a rate (defective parts per million), so
// summing monthly values across a year would produce a meaningless number.
// The READ handler returns rows already ordered by year/month, and the
// in-memory grouping in cat-service.js preserves that order, so both charts
// come out chronological without an explicit PresentationVariant.
annotate service.PPMData with @(
  Aggregation.ApplySupported : {
    $Type                  : 'Aggregation.ApplySupportedType',
    Transformations        : [ 'aggregate', 'groupby', 'filter', 'orderby' ],
    GroupableProperties    : [ yearMonth, monthLabel, year, month ],
    AggregatableProperties : [
      { $Type:'Aggregation.AggregatablePropertyType', Property: ppm },
      { $Type:'Aggregation.AggregatablePropertyType', Property: target }
    ]
  },
  Analytics.AggregatedProperty #avgPpm : {
    $Type                : 'Analytics.AggregatedPropertyType',
    Name                 : 'avgPpm',
    AggregatableProperty : ppm,
    AggregationMethod    : 'average',
    ![@Common.Label]     : 'PPM'
  },

  // "Parts Per Million" — monthly trend.
  UI.Chart #PpmTrend : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'Parts Per Million',
    Description     : 'Evidence of product quality — rates the quantity of nonconforming parts on production lines and/or at customer locations.',
    ChartType       : #Column,
    Dimensions      : [ yearMonth ],
    DynamicMeasures : [ ![@Analytics.AggregatedProperty#avgPpm] ],
    DimensionAttributes : [
      { $Type:'UI.ChartDimensionAttributeType', Dimension: yearMonth, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type:'UI.ChartMeasureAttributeType',
        DynamicMeasure: ![@Analytics.AggregatedProperty#avgPpm], Role: #Axis1 }
    ]
  },

  // "Parts Per Million - Year over Year" — same measure, grouped by year.
  UI.Chart #PpmYoY : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'Parts Per Million - Year over Year',
    Description     : 'Year-over-year comparison',
    ChartType       : #Column,
    Dimensions      : [ year ],
    DynamicMeasures : [ ![@Analytics.AggregatedProperty#avgPpm] ],
    DimensionAttributes : [
      { $Type:'UI.ChartDimensionAttributeType', Dimension: year, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type:'UI.ChartMeasureAttributeType',
        DynamicMeasure: ![@Analytics.AggregatedProperty#avgPpm], Role: #Axis1 }
    ]
  }
);
