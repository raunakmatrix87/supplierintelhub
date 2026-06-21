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
annotate service.SpendData with @(
  Aggregation.ApplySupported : {
    $Type                  : 'Aggregation.ApplySupportedType',
    Transformations        : [ 'aggregate', 'groupby', 'filter' ],
    GroupableProperties    : [ date, yearMonth, year ],
    AggregatableProperties : [ { $Type:'Aggregation.AggregatablePropertyType', Property: amount } ]
  },
  Analytics.AggregatedProperty #totalSpend : {
    $Type                : 'Analytics.AggregatedPropertyType',
    Name                 : 'totalSpend',
    AggregatableProperty : amount,
    AggregationMethod    : 'sum',
    ![@Common.Label]     : 'Spend Amount (EUR)'
  },
  // date is the filterable field driven by the period buttons (hidden FilterBar)
  UI.SelectionFields : [ date ],
  UI.Chart : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'Spend Development',
    ChartType       : #Column,
    Dimensions      : [ date ],
    DynamicMeasures : [ ![@Analytics.AggregatedProperty#totalSpend] ],
    DimensionAttributes : [
      { $Type:'UI.ChartDimensionAttributeType', Dimension: date, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type:'UI.ChartMeasureAttributeType',
        DynamicMeasure: ![@Analytics.AggregatedProperty#totalSpend], Role: #Axis1 }
    ]
  }
);
