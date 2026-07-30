/**
 * On-Time Delivery — derived from the raw purchase-order line-item view.
 *
 * DEFINITION (matches the dashboard subtitle):
 *   "The number of purchase order line items delivered on time to the required
 *    date and quantity divided by the number of total purchase order line
 *    items required."
 *
 * So OTD% = on_time_lines / total_lines * 100, where a line is on time when
 *   (a) actual_delivery_date − required_date  ∈  [earlyDays, lateDays]  and
 *   (b) delivered_quantity satisfies OTD.quantityRule.
 *
 * Two tolerance windows are computed in a single pass so the trend chart can
 * show both series without a second warehouse round-trip:
 *   strict   [-3, 0]  → "OTD% (-3 -0)"
 *   tolerant [-5, +1] → "OTD% (-5 +1)"
 *
 * Three result sets are produced from the same base CTE:
 *   1. monthlyOtdSql()  → supplier × year-month           (trend chart)
 *   2. siteOtdSql()     → supplier × plant                (Danfoss sites bar)
 *   3. forecastSql()    → pre-computed forecast rows       (dotted line)
 */

'use strict';

const {
  fq, TABLES, PO_LINE_COLUMNS: C, OTD,
} = require('./dbx-config');

const {
  clean, num, round, supplierIdFrom, slug, yearMonth, monthShort,
} = require('./dbx');

// ─── SQL fragment builders ──────────────────────────────────────────────────

/**
 * Signed delivery delta in days: negative = early, positive = late.
 * Uses the pre-computed column when dbx-config declares one.
 */
function deltaExpr() {
  if (C.deliveryDeltaDays) return `l.\`${C.deliveryDeltaDays}\``;
  return `DATEDIFF(l.\`${C.actualDate}\`, l.\`${C.requiredDate}\`)`;
}

/** Quantity-completeness predicate per OTD.quantityRule. */
function qtyPredicate() {
  const delivered = `COALESCE(l.\`${C.deliveredQty}\`, 0)`;
  const required  = `COALESCE(l.\`${C.requiredQty}\`, 0)`;

  switch (OTD.quantityRule) {
    case 'ignore':
      return 'TRUE';
    case 'tolerance':
      return `${delivered} >= ${required} * ${1 - OTD.qtyTolerance}`;
    case 'exact':
    default:
      return `${delivered} >= ${required}`;
  }
}

/** `CASE WHEN <in window> AND <qty ok> THEN 1 ELSE 0 END AS alias` */
function onTimeFlag(windowKey, alias) {
  const w = OTD.windows[windowKey];
  return `CASE
            WHEN l.\`${C.actualDate}\` IS NOT NULL
             AND ${deltaExpr()} BETWEEN ${w.earlyDays} AND ${w.lateDays}
             AND ${qtyPredicate()}
            THEN 1 ELSE 0
          END AS ${alias}`;
}

/** Optional column — emitted as NULL when not mapped, so SELECT stays valid. */
const optional = (col, alias) => (col ? `l.\`${col}\` AS ${alias}` : `CAST(NULL AS STRING) AS ${alias}`);

/**
 * Base CTE: one row per PO line, decorated with period, site and both on-time
 * flags. Everything else aggregates over this.
 */
function baseCte() {
  return `
    WITH lines AS (
      SELECT
        ${optional(C.vendorNumber, 'vendor_number')},
        ${C.supplierName ? `TRIM(l.\`${C.supplierName}\`)` : 'CAST(NULL AS STRING)'} AS supplier_name,
        TRIM(l.\`${C.plantName}\`)                         AS plant_name,
        ${optional(C.plantCode, 'plant_code')},
        ${optional(C.segment, 'segment')},
        YEAR(l.\`${C.requiredDate}\`)                      AS year,
        MONTH(l.\`${C.requiredDate}\`)                     AS month,
        l.\`${C.requiredDate}\`                            AS required_date,
        l.\`${C.actualDate}\`                              AS actual_date,
        ${deltaExpr()}                                     AS delta_days,
        ${onTimeFlag('strict',   'on_time_strict')},
        ${onTimeFlag('tolerant', 'on_time_tolerant')}
      FROM ${fq(TABLES.poLines)} l
      WHERE l.\`${C.requiredDate}\` IS NOT NULL
    )`;
}

const PCT = (flag) => `ROUND(100.0 * SUM(${flag}) / NULLIF(COUNT(*), 0), 2)`;

// Identity columns carried through every aggregation. vendor_number leads so
// the result joins straight onto Suppliers.ID with no name matching.
const GROUP_KEYS = 'vendor_number, supplier_name, segment';

/** Vendor × year-month aggregation for the trend chart. */
function monthlyOtdSql() {
  return `${baseCte()}
    SELECT
      ${GROUP_KEYS},
      plant_name,
      year,
      month,
      COUNT(*)                          AS total_lines,
      SUM(on_time_strict)               AS on_time_lines_strict,
      SUM(on_time_tolerant)             AS on_time_lines_tolerant,
      ${PCT('on_time_strict')}          AS otd_strict_pct,
      ${PCT('on_time_tolerant')}        AS otd_tolerant_pct,
      ROUND(AVG(delta_days), 2)         AS avg_delta_days
    FROM lines
    GROUP BY ${GROUP_KEYS}, plant_name, year, month
    ORDER BY vendor_number, year, month`;
}

/** Vendor × plant aggregation for the "OTD at Danfoss Sites" bar chart. */
function siteOtdSql() {
  return `${baseCte()}
    SELECT
      ${GROUP_KEYS},
      plant_name,
      plant_code,
      MIN(year)                         AS from_year,
      MIN(month)                        AS from_month,
      MAX(year)                         AS to_year,
      MAX(month)                        AS to_month,
      COUNT(*)                          AS total_lines,
      SUM(on_time_strict)               AS on_time_lines_strict,
      SUM(on_time_tolerant)             AS on_time_lines_tolerant,
      ${PCT('on_time_strict')}          AS otd_strict_pct,
      ${PCT('on_time_tolerant')}        AS otd_tolerant_pct
    FROM lines
    GROUP BY ${GROUP_KEYS}, plant_name, plant_code
    ORDER BY vendor_number, otd_strict_pct DESC`;
}

/** Pre-computed forecast rows (OTD.forecast.source === 'view'). */
function forecastSql() {
  const F = OTD.forecast.columns;
  return `
    SELECT
      ${F.vendorNumber
        ? `f.\`${F.vendorNumber}\``
        : 'CAST(NULL AS STRING)'}    AS vendor_number,
      ${F.supplierName
        ? `TRIM(f.\`${F.supplierName}\`)`
        : 'CAST(NULL AS STRING)'}    AS supplier_name,
      TRIM(f.\`${F.plantName}\`)    AS plant_name,
      f.\`${F.year}\`               AS year,
      f.\`${F.month}\`              AS month,
      f.\`${F.otdStrict}\`          AS otd_strict_pct,
      f.\`${F.otdTolerant}\`        AS otd_tolerant_pct
    FROM ${fq(TABLES.otdForecast)} f
    ORDER BY vendor_number, year, month`;
}

// ─── Row mappers (Databricks row → CDS DeliveryData / DeliveryBySite) ───────

/**
 * @param {any} row  raw aggregated Databricks row
 * @param {{isForecast?:boolean, supplierId?:string}} [opts]
 *        supplierId — resolved Suppliers.ID. Passed in rather than derived
 *        here, because one Databricks supplier NAME can correspond to several
 *        Suppliers records (the CDS key is name + segment + plant).
 */
function mapMonthlyRow(row, { isForecast = false, supplierId } = {}) {
  const supplierName = clean(row.supplier_name);
  const plant        = clean(row.plant_name);
  const year         = num(row.year);
  const month        = num(row.month);

  const strict   = round(row.otd_strict_pct, 2);
  const tolerant = round(row.otd_tolerant_pct, 2);
  // supplierId is resolved by the caller (vendor number, or name fallback).
  const sid      = supplierId || supplierIdFrom(row.vendor_number) || slug(supplierName);

  return {
    ID: [
      'OTD',
      isForecast ? 'FC' : 'AC',
      sid,
      slug(plant) || 'all',
      year,
      String(month).padStart(2, '0'),
    ].join('-'),

    supplier_ID: sid,
    plant_ID:    plant ? `PLT-${slug(plant)}` : null,
    plantName:   plant,

    year,
    month,
    yearMonth:  yearMonth(year, month),
    monthLabel: monthShort(month),

    // Primary series — the one the KPI and traffic light use.
    onTimePercent:         strict,
    onTimePercentTolerant: tolerant,

    totalOrders:          num(row.total_lines),
    onTimeOrders:         num(row.on_time_lines_strict),
    onTimeOrdersTolerant: num(row.on_time_lines_tolerant),
    avgDelayDays:         round(row.avg_delta_days, 2),

    targetPercent: OTD.target,
    isForecast,
    criticality:  criticalityOf(strict),
  };
}

function mapSiteRow(row, { supplierId } = {}) {
  const supplierName = clean(row.supplier_name);
  const plant        = clean(row.plant_name);
  const strict       = round(row.otd_strict_pct, 2);
  const sid          = supplierId || supplierIdFrom(row.vendor_number) || slug(supplierName);

  return {
    ID: ['OTDSITE', sid, slug(plant)].join('-'),
    supplier_ID: sid,
    plant_ID:    plant ? `PLT-${slug(plant)}` : null,
    plantName:   plant,
    plantCode:   clean(row.plant_code),

    onTimePercent:         strict,
    onTimePercentTolerant: round(row.otd_tolerant_pct, 2),

    totalOrders:  num(row.total_lines),
    onTimeOrders: num(row.on_time_lines_strict),

    fromPeriod: yearMonth(num(row.from_year), num(row.from_month)),
    toPeriod:   yearMonth(num(row.to_year), num(row.to_month)),

    targetPercent: OTD.target,
    criticality:   criticalityOf(strict),
  };
}

/** UI.Criticality: 1 = Negative, 2 = Critical, 3 = Positive, 0 = Neutral. */
function criticalityOf(pct) {
  if (pct === null || pct === undefined) return 0;
  if (pct < OTD.critical) return 1;
  if (pct < OTD.target)   return 2;
  return 3;
}

// ─── Post-processing: trailing window, forecast, KPI ────────────────────────

const periodKey = (r) => (r.year ?? 0) * 100 + (r.month ?? 0);

/** Rows are grouped per supplier AND per site; plantName === null = all sites. */
const grainKey = (r) => `${r.supplier_ID}::${r.plantName ?? ''}`;

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/**
 * Collapse per-site monthly rows into one all-sites row per supplier × month.
 *
 * Percentages are recomputed from the summed line-item counts, NOT averaged —
 * averaging site percentages would over-weight low-volume sites and is the
 * classic way an OTD figure drifts away from the official number.
 *
 * The result (plantName === null) is what the trend chart and the KPI use;
 * the per-site rows remain available for the site filter.
 */
function rollUpSites(rows) {
  const out = [];

  for (const list of groupBy(rows, (r) => `${r.supplier_ID}::${periodKey(r)}`).values()) {
    const first = list[0];
    if (list.length === 1 && !first.plantName) { out.push(first); continue; }

    const sum = (f) => list.reduce((s, r) => s + (r[f] || 0), 0);
    const total = sum('totalOrders');

    const pct = (onTime) => (total ? round(100 * onTime / total, 2) : null);
    const meanOf = (f) => {
      const vals = list.map((r) => r[f]).filter((v) => v !== null && v !== undefined);
      return vals.length ? round(vals.reduce((s, v) => s + v, 0) / vals.length, 2) : null;
    };

    const strict = total ? pct(sum('onTimeOrders')) : meanOf('onTimePercent');

    out.push({
      ...first,
      ID: ['OTD', first.isForecast ? 'FC' : 'AC', first.supplier_ID, 'all',
        first.year, String(first.month).padStart(2, '0')].join('-'),
      plant_ID: null,
      plantName: null,
      onTimePercent: strict,
      onTimePercentTolerant: total
        ? pct(sum('onTimeOrdersTolerant'))
        : meanOf('onTimePercentTolerant'),
      totalOrders: total || null,
      onTimeOrders: total ? sum('onTimeOrders') : null,
      onTimeOrdersTolerant: total ? sum('onTimeOrdersTolerant') : null,
      avgDelayDays: meanOf('avgDelayDays'),
      criticality: criticalityOf(strict),
    });
  }

  return out;
}

/**
 * Keep only the last `months` actual periods per supplier × site (dashboard
 * subtitle reads "Last 3 Months"). Forecast rows are always kept.
 */
function trailingWindow(rows, months = OTD.historyMonths) {
  const kept = [];
  for (const list of groupBy(rows, grainKey).values()) {
    const actuals = list.filter((r) => !r.isForecast).sort((a, b) => periodKey(a) - periodKey(b));
    const forecasts = list.filter((r) => r.isForecast).sort((a, b) => periodKey(a) - periodKey(b));
    kept.push(...actuals.slice(-months), ...forecasts);
  }
  return kept;
}

/**
 * Least-squares projection, used only when OTD.forecast.source === 'compute'.
 * Produces `months` synthetic rows continuing the actual series.
 */
function computeForecast(actuals, months = OTD.forecast.months) {
  const sorted = [...actuals].sort((a, b) => periodKey(a) - periodKey(b));
  if (sorted.length < 2) return [];

  const fit = (field) => {
    const pts = sorted
      .map((r, i) => [i, r[field]])
      .filter(([, y]) => y !== null && y !== undefined);
    if (pts.length < 2) return null;

    const n = pts.length;
    const sx = pts.reduce((s, [x]) => s + x, 0);
    const sy = pts.reduce((s, [, y]) => s + y, 0);
    const sxy = pts.reduce((s, [x, y]) => s + x * y, 0);
    const sxx = pts.reduce((s, [x]) => s + x * x, 0);
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;

    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    return (x) => intercept + slope * x;
  };

  const fStrict   = fit('onTimePercent');
  const fTolerant = fit('onTimePercentTolerant');
  if (!fStrict) return [];

  const last = sorted[sorted.length - 1];
  const out = [];

  for (let k = 1; k <= months; k++) {
    let month = (last.month ?? 1) + k;
    let year  = last.year ?? new Date().getFullYear();
    while (month > 12) { month -= 12; year += 1; }

    const bound = (v) => (v === null ? null : Math.max(0, Math.min(100, round(v, 2))));

    out.push({
      ...last,
      ID: ['OTD', 'FC', last.supplier_ID, year, String(month).padStart(2, '0')].join('-'),
      year,
      month,
      yearMonth: yearMonth(year, month),
      monthLabel: monthShort(month),
      onTimePercent:         bound(fStrict(sorted.length - 1 + k)),
      onTimePercentTolerant: fTolerant ? bound(fTolerant(sorted.length - 1 + k)) : null,
      totalOrders: null,
      onTimeOrders: null,
      onTimeOrdersTolerant: null,
      avgDelayDays: null,
      isForecast: true,
    });
  }
  return out;
}

/**
 * KPI card: "82.1% ↓ Trending Down" over the actual window.
 * Average is line-weighted where counts exist, plain mean otherwise.
 */
function summarise(rows, supplierId) {
  const actuals = rows
    .filter((r) => !r.isForecast && r.onTimePercent !== null)
    .sort((a, b) => periodKey(a) - periodKey(b));

  if (!actuals.length) {
    return {
      ID: `OTDSUM-${supplierId || 'ALL'}`,
      supplier_ID: supplierId || null,
      averagePercent: null, latestPercent: null, previousPercent: null,
      deltaPercent: null, trend: 'Flat', trendDirection: 0,
      periodCount: 0, fromPeriod: null, toPeriod: null,
      targetPercent: OTD.target, criticality: 0,
    };
  }

  const haveCounts = actuals.every((r) => r.totalOrders);
  let average;
  if (haveCounts) {
    const on = actuals.reduce((s, r) => s + (r.onTimeOrders || 0), 0);
    const tot = actuals.reduce((s, r) => s + (r.totalOrders || 0), 0);
    average = tot ? round(100 * on / tot, 1) : null;
  } else {
    average = round(actuals.reduce((s, r) => s + r.onTimePercent, 0) / actuals.length, 1);
  }

  const latest = actuals[actuals.length - 1];
  const earlier = actuals.slice(0, -1);
  const baseline = earlier.length
    ? earlier.reduce((s, r) => s + r.onTimePercent, 0) / earlier.length
    : latest.onTimePercent;

  const delta = round(latest.onTimePercent - baseline, 2);
  let trend = 'Flat', direction = 0;
  if (delta > OTD.trend.flatBand)      { trend = 'Up';   direction = 1; }
  else if (delta < -OTD.trend.flatBand) { trend = 'Down'; direction = -1; }

  return {
    ID: `OTDSUM-${supplierId || 'ALL'}`,
    supplier_ID: supplierId || null,
    averagePercent:  average,
    latestPercent:   round(latest.onTimePercent, 2),
    previousPercent: earlier.length ? round(earlier[earlier.length - 1].onTimePercent, 2) : null,
    deltaPercent:    delta,
    trend,
    trendDirection:  direction,
    periodCount:     actuals.length,
    fromPeriod:      actuals[0].yearMonth,
    toPeriod:        latest.yearMonth,
    targetPercent:   OTD.target,
    // A falling KPI is "Critical" even while still above target.
    criticality: direction < 0 && average < OTD.target ? 2 : criticalityOf(average),
  };
}

module.exports = {
  monthlyOtdSql,
  siteOtdSql,
  forecastSql,
  mapMonthlyRow,
  mapSiteRow,
  rollUpSites,
  computeForecast,
  trailingWindow,
  summarise,
  criticalityOf,
  periodKey,
  grainKey,
  groupBy,
};
