using SupplierService as service from './srv/cat-service';
annotate service.Suppliers with @(
UI.HeaderInfo:{$Type:'UI.HeaderInfoType',TypeName:'Supplier',TypeNamePlural:'Suppliers',Title:{$Type:'UI.DataField',Value:name},Description:{$Type:'UI.DataField',Value:segmentName}},
UI.SelectionFields:[segmentName,plantName,responsible,complianceStatus],
UI.LineItem:[{$Type:'UI.DataField',Value:name,Label:'Name',![@UI.Importance]:#High},{$Type:'UI.DataField',Value:segment_ID,Label:'Segment',![@UI.Importance]:#High}],
UI.SelectionVariant #All:{$Type:'UI.SelectionVariantType',Text:'All Suppliers',SelectOptions:[]},
UI.SelectionVariant #Mine:{$Type:'UI.SelectionVariantType',Text:'My Suppliers',SelectOptions:[{$Type:'UI.SelectOptionType',PropertyName:responsible,Ranges:[{$Type:'UI.SelectionRangeType',Sign:#I,Option:#EQ,Low:'Sarah P.'}]}]}
);
