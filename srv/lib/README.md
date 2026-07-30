# Databricks → CDS mapping

The service holds no data. Every dashboard entity is a virtual projection built
per request from Databricks in `srv/lib/`.

```
Databricks (Unity Catalog)                CDS entity            Dashboard element
──────────────────────────────────────────────────────────────────────────────────
fiori_mv_supplier_list          ────────► Suppliers             list report / header
fiori_mv_spend_by_year          ────────► SpendData             Spend Development chart

fiori_mv_po_lines  ┐
  group by supplier, plant, month ──────► DeliveryData          On Time Delivery chart
  rolled up across plants         ──────► DeliveryData (all)    …and the KPI card
  group by supplier, plant        ──────► DeliveryBySite        OTD at Danfoss Sites
  summarised                      ──────► OTDSummary            "82.1% ↓ Trending Down"
fiori_mv_otd_forecast           ────────► DeliveryData          dotted forecast tail

fiori_mv_supplier_compliance    ────────► ComplianceItems       Overall Compliance card
```

## Before first run — edit one file

`SUPPLIER_COLUMNS` and `SPEND_COLUMNS` in **`dbx-config.js`** are confirmed
against the catalog. The two blocks still marked `VERIFY` — PO lines and
compliance — are assumed and need checking:

```sql
SHOW TABLES IN bs_db_dev.proc_silver LIKE 'fiori_*';
DESCRIBE TABLE bs_db_dev.proc_silver.fiori_mv_po_lines;
DESCRIBE TABLE bs_db_dev.proc_silver.fiori_mv_supplier_compliance;
```

If the PO line view already carries a signed day delta, set
`PO_LINE_COLUMNS.deliveryDeltaDays` to that column and the SQL will use it
instead of `DATEDIFF`. If it carries `SourceSystemVendorNumber` directly (it
should — check first), leave `PO_LINE_COLUMNS.vendorNumber` as is; otherwise
set it to `null` and the service falls back to joining on supplier name.
Same for `COMPLIANCE_COLUMNS.vendorNumber`.

## Supplier key

`Suppliers.ID` is `SourceSystemVendorNumber`, taken verbatim from
`fiori_mv_supplier_list` — one row per vendor, confirmed unique. Every child
dataset (spend, OTD, compliance) that carries the same column joins on it
directly; `resolveSuppliers()` in `cat-service.js` only falls back to matching
on supplier *name* for rows where the vendor-number column is missing. If two
supplier-list rows ever share a vendor number, the service logs a loud warning
rather than silently generating a fallback key — that would misattach spend
and OTD to the wrong record.

## Spend

`fiori_mv_spend_by_year` is one row per vendor per **year** — there is no
month or date column. `SpendData.year` is the chart dimension, and the object
page's period buttons ("Last 3 Years" / "Last 5 Years" / "All") apply a
numeric `year >= …` filter instead of a date-range filter. Change the period
options in `dbx-config.js → SPEND.periods` (keep
`SupplierObjectPage.controller.js`'s `PERIOD_YEARS` map in sync — it's plain
JS so it can't read the config at design time).

## How OTD is derived

Matching the definition on the dashboard — *line items delivered on time to the
required date and quantity, divided by total line items required* — a PO line
counts as on time when the signed delta `actual − required` falls inside the
tolerance window **and** the full quantity arrived.

Two windows are computed in one pass, so both chart series come from a single
warehouse round-trip:

| Legend          | Window        | Meaning                          |
|-----------------|---------------|----------------------------------|
| `OTD% (-3 -0)`  | `[-3, 0]`     | up to 3 days early, never late   |
| `OTD% (-5 +1)`  | `[-5, +1]`    | up to 5 days early, 1 day late   |

Change the windows, the quantity rule, the target and the history length in
`dbx-config.js → OTD`.

### Two grains, deliberately

`DeliveryData` contains rows at two grains:

* `plantName === null` — the all-sites roll-up. The trend chart and the KPI use
  this.
* `plantName === 'Danfoss Site 01'` — one site. Backs the site filter.

Roll-up percentages are recomputed from **summed line-item counts**, never
averaged from site percentages — averaging would over-weight low-volume sites
and drift away from the official figure.

## Caching

Each OData read would otherwise open its own warehouse session, and one
dashboard render issues several. `dbx.js` memoises per SQL string with a TTL and
de-duplicates concurrent identical queries.

| Variable                        | Default  | Purpose                     |
|---------------------------------|----------|-----------------------------|
| `DATABRICKS_CACHE`              | on       | set `false` to disable      |
| `DATABRICKS_CACHE_TTL_MS`       | `300000` | 5 minutes                   |
| `DATABRICKS_MAX_ROWS`           | `50000`  | fetch ceiling per query     |
| `DATABRICKS_CATALOG` / `_SCHEMA`| `bs_db_dev` / `proc_silver` | override without editing code |

`POST /api/supplier/refreshCache` drops it; the dashboard's Refresh button calls
this before re-reading.

## Tests

```bash
npm test
```

`test/mock-pipeline.test.js` covers the mappers, roll-up, forecast and
compliance normalisation. `test/dashboard.e2e.js` boots the real CAP service
with `dbx.query` stubbed and asserts the `getDashboard` payload. Neither needs
network access.
