sap.ui.define(
    [
        "sap/fe/core/PageController",
        "sap/ui/mdc/p13n/StateUtil",
        "sap/ui/model/json/JSONModel",
        "sap/ui/model/Sorter",
        "sap/base/Log"
    ],
    function (PageController, StateUtil, JSONModel, Sorter, Log) {
        "use strict";

        var PERIOD_YEARS = {
            "3": 3,
            "5": 5,
            "all": null
        };
        var DEFAULT_PERIOD = "all";

        var LOG_COMPONENT = "supplierintelhub.ext.view.SupplierObjectPage";

        var OTD_TARGET = 95;
        var OTD_CRITICAL = 75;
        var OTD_FLAT_BAND = 1.0;

        var OTD_MAX_ROWS = 1000;

        return PageController.extend("supplierintelhub.ext.view.SupplierObjectPage", {

            onInit: function () {
                PageController.prototype.onInit.apply(this, arguments);
                this._periodInitDone = false;
                this._latestSpendYear = null;
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

                    // Keep the toggle and the applied filter from drifting apart.
                    var oToggle = this.byId("spendPeriod");
                    if (oToggle && oToggle.setSelectedKey) {
                        oToggle.setSelectedKey(DEFAULT_PERIOD);
                    }

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
                    return Promise.resolve();
                }

                return this._resolveMinYear(sKey).then(function (iMinYear) {
                    return StateUtil.retrieveExternalState(oFilterBar).then(function (oState) {
                        var aExisting = (oState && oState.filter && oState.filter.year) || [];
                        var aConditions = [];
                        var bAlreadySet = false;

                        // applyExternalState applies a DELTA, it does not replace.
                        // An empty array means "nothing to add", not "clear the field",
                        // so every stale condition has to be sent back with
                        // filtered:false or it survives - which is what left "All"
                        // stuck on the previously selected range.
                        aExisting.forEach(function (oCondition) {
                            var bIsTarget = iMinYear !== null
                                && oCondition.operator === "GE"
                                && Number(oCondition.values && oCondition.values[0]) === iMinYear;

                            if (bIsTarget) {
                                bAlreadySet = true;
                            } else {
                                aConditions.push({
                                    operator: oCondition.operator,
                                    values: oCondition.values,
                                    filtered: false
                                });
                            }
                        });

                        if (iMinYear !== null && !bAlreadySet) {
                            aConditions.push({ operator: "GE", values: [iMinYear] });
                        }

                        if (!aConditions.length) {
                            return undefined;
                        }
                        return StateUtil.applyExternalState(oFilterBar, {
                            filter: { year: aConditions }
                        });
                    });
                }).catch(function (oError) {
                    Log.error("Could not apply spend period '" + sKey + "'", oError, LOG_COMPONENT);
                });
            },

            // null = no lower bound ("All").
            _resolveMinYear: function (sKey) {
                var iSpanYears = PERIOD_YEARS[sKey];
                if (!iSpanYears) {
                    return Promise.resolve(null);
                }
                return this._getLatestSpendYear().then(function (iLatestYear) {
                    return iLatestYear - iSpanYears + 1;
                });
            },

            // Anchored on the newest year that actually has spend, so a year with
            // no data loaded yet does not silently shorten the window.
            _getLatestSpendYear: function () {
                var oContext = this.getView().getBindingContext();
                var sPath = oContext && oContext.getPath();
                if (!sPath) {
                    return Promise.resolve(new Date().getFullYear());
                }
                if (this._latestSpendYear && this._latestSpendYear.path === sPath) {
                    return this._latestSpendYear.promise;
                }

                var pLatest = oContext.getModel()
                    .bindList(
                        sPath + "/spendData",
                        undefined,
                        [new Sorter("year", true)],
                        undefined,
                        { $select: "year" }
                    )
                    .requestContexts(0, 1)
                    .then(function (aContexts) {
                        var oRow = aContexts.length ? aContexts[0].getObject() : null;
                        var iYear = oRow ? Number(oRow.year) : NaN;
                        return isFinite(iYear) && iYear ? iYear : new Date().getFullYear();
                    })
                    .catch(function (oError) {
                        Log.error("Could not read latest spend year", oError, LOG_COMPONENT);
                        return new Date().getFullYear();
                    });

                this._latestSpendYear = { path: sPath, promise: pLatest };
                return pLatest;
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

                var aValid = consolidateByPeriod(aRows);

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

        // A consolidated supplier carries several vendor numbers, so a single month can
        // arrive as several rows. Averaging them per period first is what keeps
        // "latest vs. previous" comparing two months rather than two vendor numbers.
        function consolidateByPeriod(aRows) {
            var mByPeriod = Object.create(null);
            var aPeriods = [];

            (aRows || []).forEach(function (oRow) {
                if (!oRow || oRow.otd === null || oRow.otd === undefined || oRow.otd === "") {
                    return;
                }
                var fValue = Number(oRow.otd);
                if (!isFinite(fValue)) {
                    return;
                }

                var sKey = oRow.year + "-" + oRow.month;
                var oEntry = mByPeriod[sKey];
                if (!oEntry) {
                    oEntry = {
                        period: oRow.monthLabel && oRow.year
                            ? oRow.monthLabel + " " + oRow.year
                            : null,
                        sum: 0,
                        count: 0
                    };
                    mByPeriod[sKey] = oEntry;
                    aPeriods.push(oEntry);
                }
                oEntry.sum += fValue;
                oEntry.count += 1;
            });

            return aPeriods.map(function (oEntry) {
                return { period: oEntry.period, value: oEntry.sum / oEntry.count };
            });
        }

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
