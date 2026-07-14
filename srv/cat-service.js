const cds = require('@sap/cds');
const { DBSQLClient } = require('@databricks/sql');

async function queryDatabricks(sqlText, options = {}) {
  const serverHostname = process.env.DATABRICKS_SERVER_HOSTNAME;
  const httpPath       = process.env.DATABRICKS_HTTP_PATH;
  const token          = process.env.DATABRICKS_TOKEN;

  if (!token || !serverHostname || !httpPath) {
    throw new Error(
      'Missing Databricks config. Check DATABRICKS_SERVER_HOSTNAME, ' +
      'DATABRICKS_HTTP_PATH, and DATABRICKS_TOKEN.'
    );
  }

  const client = new DBSQLClient();
  let session;

  try {
    await client.connect({
      token,
      host: serverHostname,
      path: httpPath,
    });

    session = await client.openSession();

    const operation = await session.executeStatement(sqlText, {
      runAsync: true,
      maxRows: options.maxRows ?? 10000,
    });

    const result = await operation.fetchAll();
    await operation.close();

    return result; // array of plain objects
  } finally {
    if (session) {
      try { await session.close(); } catch (e) { /* ignore */ }
    }
    try { await client.close(); } catch (e) { /* ignore */ }
  }
}

const SUPPLIER_SQL =
  'SELECT * FROM bs_db_dev.proc_silver.`fiori_mv_supplier_list`';

const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const num   = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const slug = (v) =>
  String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function makeId(row) {
  return 'DBX-' + [row.name, row.segment, row.plant].map(slug).filter(Boolean).join('-');
}

const SPEND_SQL =
  'SELECT * FROM bs_db_dev.proc_silver.`fiori_mv_spend_by_year`';

function makeSupplierId(row) {
  return 'DBX-' + [row.name, row.segment, row.plant].map(slug).filter(Boolean).join('-');
}

function mapSpendRow(row) {
  const year      = num(row.year);
  const yearMonth = clean(row.yearMonth)
    ?? (year != null && row.month != null
          ? `${year}-${String(row.month).padStart(2, '0')}`
          : null);

  return {
    ID:          slug(`${row.name}-${row.segment}-${row.plant}-${year}-${row.month ?? row.yearMonth ?? ''}`) || cds.utils.uuid(),
    supplier_ID: makeSupplierId(row),
    date:        clean(row.date),
    yearMonth,
    year,
    amount:      num(row.amount),
  };
}

function mapSupplierRow(row) {
  return {
    ID:               makeId(row),
    name:             clean(row.name),
    responsible:      clean(row.responsible),
    category:         clean(row.category),
    subcategory:      clean(row.subcategory),
    mainSupplies:     clean(row.mainSupplies),
    score:            num(row.score),
    nextReview:       clean(row.nextReview),     
    complianceStatus: clean(row.complianceStatus),
    isTopSupplier:    row.isTopSupplier ?? false,
    segmentName:      clean(row.segment),
    plantName:        clean(row.plant),
    plantLocation:    clean(row.plantLocation),
    activeQualityClaims: row.activeQualityClaims ?? null,
    currentPPM:          num(row.currentPPM),
    currentOTD:          num(row.currentOTD),
  };
}

module.exports = cds.service.impl(async function () {

  this.on('READ', 'Suppliers', async (req, next) => {
    try {
      const rows = await queryDatabricks(SUPPLIER_SQL);
      let data = rows.map(mapSupplierRow);

      const seen = Object.create(null);
      for (const s of data) {
        if (seen[s.ID] === undefined) { seen[s.ID] = 0; }
        else { s.ID = `${s.ID}-${++seen[s.ID]}`; }
      }

      const idRef = req.data && req.data.ID;
      if (idRef) {
        const one = data.find((s) => s.ID === idRef);
        return one || next();
      }

      const total = data.length;
      const { SELECT } = req.query;
      const skip = SELECT?.limit?.offset?.val ?? 0;
      const top  = SELECT?.limit?.rows?.val;
      let page = data.slice(skip, top != null ? skip + top : undefined);
      page.$count = total;

      console.log('>>> Suppliers READ  total=%d  skip=%d  top=%s  returned=%d',
        total, skip, String(top), page.length);
      console.log('>>> first row:', JSON.stringify(page[0]));
      return page;
    } catch (err) {
      console.error('Databricks Suppliers READ failed:', err);
      return req.error(502, `Failed to fetch suppliers from Databricks: ${err.message}`);
    }
  });

  this.on('READ', 'SpendData', async (req, next) => {
  try {
    const rows = await queryDatabricks(SPEND_SQL);
    let data = rows.map(mapSpendRow);

    // de-dupe IDs the same way Suppliers does
    const seen = Object.create(null);
    for (const s of data) {
      if (seen[s.ID] === undefined) seen[s.ID] = 0;
      else s.ID = `${s.ID}-${++seen[s.ID]}`;
    }

    const idRef = req.data && req.data.ID;
    if (idRef) {
      const one = data.find((s) => s.ID === idRef);
      return one || next();
    }

    const total = data.length;
    const { SELECT } = req.query;
    const skip = SELECT?.limit?.offset?.val ?? 0;
    const top  = SELECT?.limit?.rows?.val;
    let page = data.slice(skip, top != null ? skip + top : undefined);
    page.$count = total;
    return page;
  } catch (err) {
    console.error('Databricks SpendData READ failed:', err);
    return req.error(502, `Failed to fetch spend data from Databricks: ${err.message}`);
  }
});

  this.on('getData', async (req) => {
    try {
      const rows = await queryDatabricks(SUPPLIER_SQL);
      return rows.map(mapSupplierRow); // return mapped shape, not raw rows
    } catch (err) {
      console.error('Databricks getData failed:', err);
      return req.error(502, `Failed to fetch data from Databricks: ${err.message}`);
    }
  });

  this.on('getSpendData', async (req) => {
  try {
    const rows = await queryDatabricks(SPEND_SQL);
    const data = rows.map(mapSpendRow);
  //  await INSERT.into('suplier_intel_hub.SpendData').entries(data);
    return data;
  } catch (err) {
    console.error('Databricks getSpendData failed:', err);
    return req.error(502, `Failed to load spend data: ${err.message}`);
  }
});
});