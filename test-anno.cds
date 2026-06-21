using SupplierService as service from './srv/cat-service';
annotate service.Suppliers with @(
  UI.LineItem : [
    { $Type: 'UI.DataField', Value: name, Label: 'Name' }
  ]
);
