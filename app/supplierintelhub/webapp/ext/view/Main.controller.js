sap.ui.define(
    [
        "sap/fe/core/PageController",
        "sap/ui/model/Filter",
        "sap/ui/model/FilterOperator",
        "sap/ui/model/FilterType"
    ],
    function (PageController, Filter, FilterOperator, FilterType) {
        "use strict";

        return PageController.extend("supplierintelhub.ext.view.Main", {

            onRowPress: function (oEvent) {
                var oContext = oEvent.getParameter("bindingContext")
                    || (oEvent.getSource() && oEvent.getSource().getBindingContext());
                if (oContext) {
                    this.routing.navigate(oContext);
                }
            },

            onSupplierScopeChange: function (oEvent) {
                var sKey = oEvent.getParameter("item").getKey();
                var oBinding = this._getSuppliersBinding();
                if (!oBinding) {
                    return;
                }
                var aFilters = (sKey === "mine")
                    ? [new Filter("responsible", FilterOperator.EQ, "Sarah P.")]
                    : [];
                oBinding.filter(aFilters, FilterType.Application);
            },

            _getSuppliersBinding: function () {
                var oTableAPI = this.byId("suppliersTable");
                if (!oTableAPI) {
                    return null;
                }
                var oTable = oTableAPI.getContent ? oTableAPI.getContent() : oTableAPI;
                if (oTable && oTable.getRowBinding) {
                    return oTable.getRowBinding();
                }
                return oTable && oTable.getBinding ? oTable.getBinding("items") : null;
            }
        });
    }
);
