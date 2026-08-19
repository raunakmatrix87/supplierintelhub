using SupplierService as service from '../../srv/cat-service';

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

annotate service.OTDData with @(
  Aggregation.ApplySupported : {
    $Type                  : 'Aggregation.ApplySupportedType',
    Transformations        : [ 'aggregate', 'groupby', 'filter', 'orderby' ],
    GroupableProperties    : [ yearMonth, monthLabel, year, month ],
    AggregatableProperties : [
      { $Type:'Aggregation.AggregatablePropertyType', Property: otd }
    ]
  },
  Analytics.AggregatedProperty #avgOtd : {
    $Type                : 'Analytics.AggregatedPropertyType',
    Name                 : 'avgOtd',
    AggregatableProperty : otd,
    AggregationMethod    : 'average',
    ![@Common.Label]     : 'On Time Delivery %'
  },

  UI.Chart #OtdTrend : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'On Time Delivery',
    Description     : 'The number of purchase order line items delivered on time to the required date and quantity, divided by the number of total purchase order line items required.',
    ChartType       : #Column,
    Dimensions      : [ yearMonth ],
    DynamicMeasures : [ ![@Analytics.AggregatedProperty#avgOtd] ],
    DimensionAttributes : [
      { $Type:'UI.ChartDimensionAttributeType', Dimension: yearMonth, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type:'UI.ChartMeasureAttributeType',
        DynamicMeasure: ![@Analytics.AggregatedProperty#avgOtd], Role: #Axis1 }
    ]
  },

  UI.Chart #OtdYoY : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'On Time Delivery - Year over Year',
    Description     : 'Year-over-year comparison',
    ChartType       : #Column,
    Dimensions      : [ year ],
    DynamicMeasures : [ ![@Analytics.AggregatedProperty#avgOtd] ],
    DimensionAttributes : [
      { $Type:'UI.ChartDimensionAttributeType', Dimension: year, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type:'UI.ChartMeasureAttributeType',
        DynamicMeasure: ![@Analytics.AggregatedProperty#avgOtd], Role: #Axis1 }
    ]
  },

  UI.Chart #OtdAverage : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'On Time Delivery - Average Results',
    ChartType       : #Line,
    Dimensions      : [ yearMonth ],
    DynamicMeasures : [ ![@Analytics.AggregatedProperty#avgOtd] ],
    DimensionAttributes : [
      { $Type:'UI.ChartDimensionAttributeType', Dimension: yearMonth, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type:'UI.ChartMeasureAttributeType',
        DynamicMeasure: ![@Analytics.AggregatedProperty#avgOtd], Role: #Axis1 }
    ]
  },

  UI.LineItem #OtdMonths : [
    { $Type:'UI.DataField', Value: yearMonth,  Label:'Period' },
    { $Type:'UI.DataField', Value: otd,        Label:'On Time Delivery %' }
  ]
);

annotate service.OTDData with {
  otd @Measures.Unit: '%';
};

annotate service.OPMData with @(
  Aggregation.ApplySupported : {
    $Type                  : 'Aggregation.ApplySupportedType',
    Transformations        : [ 'aggregate', 'groupby', 'filter', 'orderby' ],
    GroupableProperties    : [ yearMonth, monthLabel, year, month ],
    AggregatableProperties : [
      { $Type:'Aggregation.AggregatablePropertyType', Property: opm }
    ]
  },
  Analytics.AggregatedProperty #avgOpm : {
    $Type                : 'Analytics.AggregatedPropertyType',
    Name                 : 'avgOpm',
    AggregatableProperty : opm,
    AggregationMethod    : 'average',
    ![@Common.Label]     : 'OPM'
  },

  UI.Chart #OpmTrend : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'Occurrence Per Million',
    Description     : 'The rating gives evidence of product quality and rates number of claims issued by Danfoss based on definitions of Claims.',
    ChartType       : #Column,
    Dimensions      : [ yearMonth ],
    DynamicMeasures : [ ![@Analytics.AggregatedProperty#avgOpm] ],
    DimensionAttributes : [
      { $Type:'UI.ChartDimensionAttributeType', Dimension: yearMonth, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type:'UI.ChartMeasureAttributeType',
        DynamicMeasure: ![@Analytics.AggregatedProperty#avgOpm], Role: #Axis1 }
    ]
  },

  UI.Chart #OpmRolling : {
    $Type           : 'UI.ChartDefinitionType',
    Title           : 'Occurrence Per Million',
    Description     : 'Rolling 12 months',
    ChartType       : #Line,
    Dimensions      : [ yearMonth ],
    DynamicMeasures : [ ![@Analytics.AggregatedProperty#avgOpm] ],
    DimensionAttributes : [
      { $Type:'UI.ChartDimensionAttributeType', Dimension: yearMonth, Role: #Category }
    ],
    MeasureAttributes : [
      { $Type:'UI.ChartMeasureAttributeType',
        DynamicMeasure: ![@Analytics.AggregatedProperty#avgOpm], Role: #Axis1 }
    ]
  },

  UI.LineItem #OpmMonths : [
    { $Type:'UI.DataField', Value: yearMonth, Label:'Period' },
    { $Type:'UI.DataField', Value: opm,       Label:'OPM' }
  ]
);
