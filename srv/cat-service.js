const cds = require('@sap/cds');
const { DBSQLClient } = require('@databricks/sql');

// ─── Databricks helper ────────────────────────────────────────────────────────

async function queryDatabricks(sqlText, options = {}) {
  const serverHostname = "adb-7405616267634237.17.azuredatabricks.net";
  const httpPath       = "sql/1.0/warehouses/1944c030f4d741cf";
  const token          = "dapi05d380362c8c70f4c52ec1c4e9265c14-2";

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
    // Always clean up, even on error
    if (session) {
      try { await session.close(); } catch (e) { /* ignore */ }
    }
    try { await client.close(); } catch (e) { /* ignore */ }
  }
}

// ─── Service implementation ───────────────────────────────────────────────────

module.exports = cds.service.impl(async function () {

  this.on('getData', async (req) => {
    try {
      // adjust catalog.schema.table to your actual Databricks object
      const sql = `
        SELECT *
        FROM bs_db_dev.proc_silver.d_spend_pmt_2025-curryear
        LIMIT 100
      `;

      const rows = await queryDatabricks('SELECT * FROM bs_db_dev.proc_silver.`fiori_mv_supplier_list` LIMIT 100');
      return rows; // matches: returns many cds.Map
    } catch (err) {
      console.error('Databricks getData failed:', err);
      return req.error(502, `Failed to fetch data from Databricks: ${err.message}`);
    }
  });

  // ... your other handlers (prepareForMeeting, etc.)
});