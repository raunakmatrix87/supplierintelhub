sap.ui.define(
    [
        "sap/fe/core/PageController",
        "sap/ui/mdc/p13n/StateUtil"
    ],
    function (PageController, StateUtil) {
        "use strict";

        // fiori_mv_spend_by_year has one row per vendor per YEAR — there is no
        // month or date column — so the period buttons filter the numeric `year`
        // field directly ("year >= currentYear - N + 1") instead of using MDC's
        // semantic date operators, which only apply to Date/DateTime fields.
        // Keep in sync with srv/lib/dbx-config.js → SPEND.periods.
        var PERIOD_YEARS = {
            "3": 3,
            "5": 5,
            "all": null
        };
        var DEFAULT_PERIOD = "3";

        return PageController.extend("supplierintelhub.ext.view.SupplierObjectPage", {

            onInit: function () {
                PageController.prototype.onInit.apply(this, arguments);
                this._periodInitDone = false;
            },

            // Apply the default period once the filter bar is ready.
            onAfterRendering: function () {
                if (this._periodInitDone) {
                    return;
                }
                var oFilterBar = this._getSpendFilterBar();
                if (oFilterBar && oFilterBar.initialized) {
                    this._periodInitDone = true;
                    oFilterBar.initialized().then(function () {
                        this._applyPeriod(DEFAULT_PERIOD);
                    }.bind(this));
                }
            },

            onSpendPeriodChange: function (oEvent) {
                this._applyPeriod(oEvent.getParameter("item").getKey());
            },

            /**
             * "Last N Years" → year >= (currentYear - N + 1), so N=3 in 2026
             * keeps 2024-2026. "All" clears the filter entirely.
             */
            _applyPeriod: function (sKey) {
                var oFilterBar = this._getSpendFilterBar();
                if (!oFilterBar) {
                    return;
                }
                var iSpanYears = PERIOD_YEARS[sKey];
                var aConditions = [];
                if (iSpanYears) {
                    var iMinYear = new Date().getFullYear() - iSpanYears + 1;
                    aConditions = [{ operator: "GE", values: [iMinYear] }];
                }
                StateUtil.applyExternalState(oFilterBar, {
                    filter: { year: aConditions }
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
