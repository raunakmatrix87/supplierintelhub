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

            /**
             * Navigate to the Supplier object page when a table row is pressed.
             */
            onRowPress: function (oEvent) {
                var oContext = oEvent.getParameter("bindingContext")
                    || (oEvent.getSource() && oEvent.getSource().getBindingContext());
                if (oContext) {
                    this.routing.navigate(oContext);
                }
            },

            /**
             * "All Suppliers" / "My Suppliers" segmented toggle.
             * Applies an application-level filter on the macros table binding so it
             * coexists with FilterBar conditions and table personalization.
             */
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

            /**
             * Resolves the OData V4 list binding of the macros:Table building block.
             */
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
