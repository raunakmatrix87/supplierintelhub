sap.ui.define(
    [
        "sap/fe/core/PageController",
        "sap/ui/mdc/p13n/StateUtil",
        "sap/ui/model/json/JSONModel",
        "sap/ui/model/Sorter"
    ],
    function (PageController, StateUtil, JSONModel, Sorter) {
        "use strict";

        var PERIOD_YEARS = {
            "3": 3,
            "5": 5,
            "all": null
        };
        var DEFAULT_PERIOD = "3";

        var OTD_TARGET = 95;
        var OTD_CRITICAL = 75;
        var OTD_FLAT_BAND = 1.0;

        var OTD_MAX_ROWS = 1000;

        return PageController.extend("supplierintelhub.ext.view.SupplierObjectPage", {

            onInit: function () {
                PageController.prototype.onInit.apply(this, arguments);
                this._periodInitDone = false;
                this._otdKpiPath = null;
                this.getView().setModel(new JSONModel(emptyOtdKpi()), "otdKpi");
            },

            onPageReady: function (mParameters) {
                if (PageController.prototype.onPageReady) {
                    PageController.prototype.onPageReady.apply(this, arguments);
                }
                this._refreshOtdKpi(
                    (mParameters && mParameters.context) || this.getView().getBindingContext()
                );
            },

            onAfterRendering: function () {
                this._refreshOtdKpi(this.getView().getBindingContext());

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
            },

            _refreshOtdKpi: function (oContext) {
                if (!oContext) {
                    return;
                }
                var sPath = oContext.getPath();
                if (this._otdKpiPath === sPath) {
                    return;
                }
                this._otdKpiPath = sPath;

                var oListBinding = oContext.getModel().bindList(
                    sPath + "/otdData",
                    undefined,
                    [new Sorter("year"), new Sorter("month")],
                    undefined,
                    { $select: "year,month,monthLabel,otd" }
                );

                oListBinding.requestContexts(0, OTD_MAX_ROWS).then(function (aContexts) {
                    if (this._otdKpiPath !== sPath || this.getView().isDestroyed()) {
                        return;
                    }
                    this._setOtdKpi(aContexts.map(function (oRowContext) {
                        return oRowContext.getObject();
                    }));
                }.bind(this)).catch(function () {
                    if (this._otdKpiPath === sPath && !this.getView().isDestroyed()) {
                        this.getView().getModel("otdKpi").setData(emptyOtdKpi());
                    }
                }.bind(this));
            },

            _setOtdKpi: function (aRows) {
                var oModel = this.getView().getModel("otdKpi");

                var aValid = (aRows || [])
                    .filter(function (oRow) {
                        return oRow && oRow.otd !== null && oRow.otd !== undefined && oRow.otd !== "";
                    })
                    .map(function (oRow) {
                        return {
                            period: oRow.monthLabel && oRow.year
                                ? oRow.monthLabel + " " + oRow.year
                                : null,
                            value: Number(oRow.otd)
                        };
                    })
                    .filter(function (oPoint) {
                        return isFinite(oPoint.value);
                    });

                if (!aValid.length) {
                    oModel.setData(emptyOtdKpi());
                    return;
                }

                var fSum = aValid.reduce(function (fAcc, oPoint) {
                    return fAcc + oPoint.value;
                }, 0);
                var fAverage = round1(fSum / aValid.length);

                var fLatest = aValid[aValid.length - 1].value;
                var fPrevious = aValid.length > 1 ? aValid[aValid.length - 2].value : null;
                var fDelta = fPrevious === null ? 0 : round1(fLatest - fPrevious);

                var sIndicator = "None";
                var sTrendText = "Stable";
                if (fDelta > OTD_FLAT_BAND) {
                    sIndicator = "Up";
                    sTrendText = "Trending Up";
                } else if (fDelta < -OTD_FLAT_BAND) {
                    sIndicator = "Down";
                    sTrendText = "Trending Down";
                }

                var sFrom = aValid[0].period;
                var sTo = aValid[aValid.length - 1].period;

                oModel.setData({
                    hasData: true,
                    average: fAverage,
                    averageText: fAverage.toFixed(1),
                    latest: fLatest,
                    previous: fPrevious,
                    delta: fDelta,
                    deltaText: fPrevious === null
                        ? "First reported period"
                        : (fDelta > 0 ? "+" : "") + fDelta.toFixed(1) + " pp vs. previous month",
                    indicator: sIndicator,
                    trendText: sTrendText,
                    valueColor: fAverage >= OTD_TARGET
                        ? "Good"
                        : (fAverage >= OTD_CRITICAL ? "Critical" : "Error"),
                    periodCount: aValid.length,
                    periodLabel: sFrom && sTo && sFrom !== sTo
                        ? sFrom + " – " + sTo
                        : (sTo || "")
                });
            }
        });

        function round1(fValue) {
            return Math.round(fValue * 10) / 10;
        }

        function emptyOtdKpi() {
            return {
                hasData: false,
                average: null,
                averageText: "",
                latest: null,
                previous: null,
                delta: 0,
                deltaText: "",
                indicator: "None",
                trendText: "",
                valueColor: "Neutral",
                periodCount: 0,
                periodLabel: ""
            };
        }
    }
);
