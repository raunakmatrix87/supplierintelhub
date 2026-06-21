sap.ui.define(
    [
        "sap/fe/core/PageController",
        "sap/ui/mdc/p13n/StateUtil"
    ],
    function (PageController, StateUtil) {
        "use strict";

        // Maps the segmented-button keys to MDC's built-in semantic date operators,
        // which are evaluated relative to "today" by the framework.
        var PERIOD_OPERATOR = {
            month:   "THISMONTH",
            quarter: "THISQUARTER",
            year:    "THISYEAR"
        };

        return PageController.extend("supplierintelhub.ext.view.SupplierObjectPage", {

            onInit: function () {
                PageController.prototype.onInit.apply(this, arguments);
                this._periodInitDone = false;
            },

            // Apply the default period ("This Year") once the filter bar is ready.
            onAfterRendering: function () {
                if (this._periodInitDone) {
                    return;
                }
                var oFilterBar = this._getSpendFilterBar();
                if (oFilterBar && oFilterBar.initialized) {
                    this._periodInitDone = true;
                    oFilterBar.initialized().then(function () {
                        this._applyPeriod("quarter");
                    }.bind(this));
                }
            },

            onSpendPeriodChange: function (oEvent) {
                this._applyPeriod(oEvent.getParameter("item").getKey());
            },

            _applyPeriod: function (sKey) {
                var oFilterBar = this._getSpendFilterBar();
                if (!oFilterBar) {
                    return;
                }
                var sOperator = PERIOD_OPERATOR[sKey];
                var aConditions = sOperator
                    ? [{ operator: sOperator, values: [] }]   // "All" -> [] clears the filter
                    : [];
                StateUtil.applyExternalState(oFilterBar, {
                    filter: { date: aConditions }
                });
            },

            _getSpendFilterBar: function () {
                var oApi = this.byId("spendFilterBar");
                if (!oApi) {
                    return null;
                }
                return oApi.getContent ? oApi.getContent() : oApi;
            }
        });
    }
);
