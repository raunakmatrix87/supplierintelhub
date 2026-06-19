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

  @readonly entity Segments          as projection on db.Segments;
  @readonly entity Plants            as projection on db.Plants;

  entity QualityClaims      as projection on db.QualityClaims;
  entity SpendData          as projection on db.SpendData;
  entity DeliveryData       as projection on db.DeliveryData;
  entity PPMData            as projection on db.PPMData;
  entity Insights           as projection on db.Insights;
  entity Contacts           as projection on db.Contacts;
  entity PerformanceReviews as projection on db.PerformanceReviews;
}
