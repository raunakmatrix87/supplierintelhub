sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"supplierintelhub/test/integration/pages/SuppliersMain"
], function (JourneyRunner, SuppliersMain) {
    'use strict';

    var runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('supplierintelhub') + '/test/flp.html#app-preview',
        pages: {
			onTheSuppliersMain: SuppliersMain
        },
        async: true
    });

    return runner;
});

