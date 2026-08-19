
'use strict';

const {
  fq, TABLES, PO_LINE_COLUMNS: C, OTD,
} = require('./dbx-config');

const {
  clean, num, round, supplierIdFrom, slug, yearMonth, monthShort,
} = require('./dbx');

function deltaExpr() {
  if (C.deliveryDeltaDays) return `l.\`${C.deliveryDeltaDays}\``;
  return `DATEDIFF(l.\`${C.actualDate}\`, l.\`${C.requiredDate}\`)`;
}

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

function onTimeFlag(windowKey, alias) {
  const w = OTD.windows[windowKey];
  return `CASE
            WHEN l.\`${C.actualDate}\` IS NOT NULL
             AND ${deltaExpr()} BETWEEN ${w.earlyDays} AND ${w.lateDays}
             AND ${qtyPredicate()}
            THEN 1 ELSE 0
          END AS ${alias}`;
}

const optional = (col, alias) => (col ? `l.\`${col}\` AS ${alias}` : `CAST(NULL AS STRING) AS ${alias}`);

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

const GROUP_KEYS = 'vendor_number, supplier_name, segment';

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

function mapMonthlyRow(row, { isForecast = false, supplierId } = {}) {
  const supplierName = clean(row.supplier_name);
  const plant        = clean(row.plant_name);
  const year         = num(row.year);
  const month        = num(row.month);

  const strict   = round(row.otd_strict_pct, 2);
  const tolerant = round(row.otd_tolerant_pct, 2);
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

function criticalityOf(pct) {
  if (pct === null || pct === undefined) return 0;
  if (pct < OTD.critical) return 1;
  if (pct < OTD.target)   return 2;
  return 3;
}

const periodKey = (r) => (r.year ?? 0) * 100 + (r.month ?? 0);

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

function trailingWindow(rows, months = OTD.historyMonths) {
  const kept = [];
  for (const list of groupBy(rows, grainKey).values()) {
    const actuals = list.filter((r) => !r.isForecast).sort((a, b) => periodKey(a) - periodKey(b));
    const forecasts = list.filter((r) => r.isForecast).sort((a, b) => periodKey(a) - periodKey(b));
    kept.push(...actuals.slice(-months), ...forecasts);
  }
  return kept;
}

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
