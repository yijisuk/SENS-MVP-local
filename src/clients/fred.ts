import axios from "axios";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import type { FredObservation, FredSeries, FredChartResult } from "../types/index.js";

const FRED_BASE = "https://api.stlouisfed.org/fred";
const QUICKCHART_URL = "https://quickchart.io/chart";

export const FRED_SERIES: Record<string, { title: string; units: string }> = {
  FEDFUNDS:    { title: "Federal Funds Rate",               units: "%" },
  DGS2:        { title: "2-Year Treasury Yield",             units: "%" },
  DGS10:       { title: "10-Year Treasury Yield",            units: "%" },
  DGS30:       { title: "30-Year Treasury Yield",            units: "%" },
  T10Y2Y:      { title: "10Y−2Y Treasury Spread",           units: "%" },
  T10YIE:      { title: "10-Year Breakeven Inflation",       units: "%" },
  CPIAUCSL:    { title: "CPI (All Urban Consumers)",         units: "Index" },
  CPILFESL:    { title: "Core CPI (Less Food & Energy)",     units: "Index" },
  PCEPI:       { title: "PCE Price Index",                   units: "Index" },
  UNRATE:      { title: "Unemployment Rate",                 units: "%" },
  PAYEMS:      { title: "Total Nonfarm Payrolls",            units: "Thousands" },
  ICSA:        { title: "Initial Jobless Claims",            units: "Claims" },
  GDP:         { title: "Gross Domestic Product",            units: "Billions $" },
  INDPRO:      { title: "Industrial Production Index",       units: "Index" },
  DEXUSEU:     { title: "USD/EUR Exchange Rate",             units: "USD per EUR" },
  DEXJPUS:     { title: "JPY/USD Exchange Rate",             units: "JPY per USD" },
  DTWEXBGS:    { title: "Trade-Weighted Dollar Index",       units: "Index" },
  GOLDAMGBD228NLBM: { title: "Gold Price (London Fix)", units: "USD/oz" },
  DCOILWTICO:  { title: "WTI Crude Oil",                     units: "USD/barrel" },
  BAMLH0A0HYM2: { title: "HY OAS Spread",                  units: "%" },
  BAMLC0A0CM:   { title: "IG Corporate Spread",             units: "%" },
};

const YIELD_CURVE_SERIES = [
  { id: "DGS1MO", label: "1M" }, { id: "DGS3MO", label: "3M" },
  { id: "DGS6MO", label: "6M" }, { id: "DGS1",   label: "1Y" },
  { id: "DGS2",   label: "2Y" }, { id: "DGS5",   label: "5Y" },
  { id: "DGS10",  label: "10Y" }, { id: "DGS20",  label: "20Y" },
  { id: "DGS30",  label: "30Y" },
];

// ─── Color Palette for Multi-Series Charts ───

const CHART_COLORS = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#d97706", // amber
  "#7c3aed", // violet
  "#0891b2", // cyan
];

// ─── Duration Label Helper ───

/**
 * Convert a months value to a human-readable duration label.
 * Examples: 1 → "1M", 6 → "6M", 12 → "1Y", 24 → "2Y", 60 → "5Y"
 *
 * Falls back to inferring from observation date range if months is not provided.
 */
function durationLabel(months?: number, observations?: FredObservation[]): string {
  if (months !== undefined) {
    if (months < 12) return `${months}M`;
    if (months % 12 === 0) return `${months / 12}Y`;
    return `${months}M`;
  }

  // Infer from observation date range
  if (observations && observations.length >= 2) {
    const first = new Date(observations[0].date);
    const last = new Date(observations[observations.length - 1].date);
    const diffMonths = Math.round(
      (last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
    );
    if (diffMonths <= 1) return "1M";
    if (diffMonths <= 3) return "3M";
    if (diffMonths <= 6) return "6M";
    if (diffMonths <= 12) return "1Y";
    if (diffMonths <= 24) return "2Y";
    if (diffMonths <= 60) return "5Y";
    return `${Math.round(diffMonths / 12)}Y`;
  }

  return "";
}

/**
 * Build a chart title with time horizon.
 * e.g. "Federal Funds Rate (1Y)" or "2-Year Treasury Yield (6M)"
 */
function chartTitleWithDuration(baseTitle: string, duration: string): string {
  return duration ? `${baseTitle} (${duration})` : baseTitle;
}

// ─── Scale Analysis ───

/**
 * Determine whether multiple series have significantly different scales,
 * warranting separate Y-axes.
 *
 * Two series are considered "different scale" if:
 *   - Their value ranges differ by more than 5x, OR
 *   - Their units are fundamentally different (e.g. "%" vs "Index")
 */
function needsMultipleAxes(seriesList: FredSeries[]): boolean {
  if (seriesList.length < 2) return false;

  // Check units first — different units almost always need separate axes
  const uniqueUnits = new Set(seriesList.map((s) => s.units));
  if (uniqueUnits.size > 1) return true;

  // Check value ranges — if max/min ratio > 5x, use separate axes
  const ranges = seriesList.map((s) => {
    const values = s.observations.map((o) => o.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, max, mid: (min + max) / 2, range: max - min };
  });

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i];
      const b = ranges[j];
      // Compare midpoints — if one is 5x+ larger, separate axes
      const ratio = Math.max(
        Math.abs(a.mid) / Math.max(Math.abs(b.mid), 0.001),
        Math.abs(b.mid) / Math.max(Math.abs(a.mid), 0.001)
      );
      if (ratio > 5) return true;
    }
  }

  return false;
}

/**
 * Group series into axis clusters based on scale similarity.
 * Returns an array of axis assignments (0-indexed) for each series.
 *
 * Strategy: cluster by units first, then split within same-unit groups
 * if value ranges differ by >5x.
 */
function assignAxes(seriesList: FredSeries[]): number[] {
  if (seriesList.length <= 1) return [0];

  const unitGroups = new Map<string, number[]>();
  for (let i = 0; i < seriesList.length; i++) {
    const unit = seriesList[i].units;
    if (!unitGroups.has(unit)) unitGroups.set(unit, []);
    unitGroups.get(unit)!.push(i);
  }

  const assignments = new Array<number>(seriesList.length).fill(0);
  let axisIndex = 0;

  for (const [, indices] of unitGroups) {
    if (indices.length === 1) {
      assignments[indices[0]] = axisIndex;
      axisIndex++;
      continue;
    }

    // Within same-unit group, check if scales differ significantly
    const mids = indices.map((i) => {
      const values = seriesList[i].observations.map((o) => o.value);
      return (Math.min(...values) + Math.max(...values)) / 2;
    });

    // Simple two-cluster split: sort by midpoint, split where ratio > 5x
    const sorted = indices
      .map((idx, j) => ({ idx, mid: mids[j] }))
      .sort((a, b) => a.mid - b.mid);

    let currentAxis = axisIndex;
    assignments[sorted[0].idx] = currentAxis;

    for (let k = 1; k < sorted.length; k++) {
      const ratio = Math.abs(sorted[k].mid) / Math.max(Math.abs(sorted[k - 1].mid), 0.001);
      if (ratio > 5) {
        currentAxis = axisIndex + 1;
      }
      assignments[sorted[k].idx] = currentAxis;
    }

    axisIndex = currentAxis + 1;
  }

  // Normalize to 0-indexed contiguous
  const uniqueAxes = [...new Set(assignments)].sort((a, b) => a - b);
  const axisMap = new Map(uniqueAxes.map((a, i) => [a, i]));
  return assignments.map((a) => axisMap.get(a)!);
}

// ─── Public API ───

export async function fetchFredSeries(
  seriesId: string,
  months: number = 12
): Promise<FredSeries | null> {
  const meta = FRED_SERIES[seriesId];
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - months);

  try {
    const response = await axios.get(`${FRED_BASE}/series/observations`, {
      params: {
        series_id: seriesId,
        api_key: config.FRED_API_KEY,
        file_type: "json",
        observation_start: start.toISOString().split("T")[0],
        observation_end: end.toISOString().split("T")[0],
        sort_order: "asc",
      },
    });

    const observations: FredObservation[] = (response.data.observations ?? [])
      .filter((o: any) => o.value !== ".")
      .map((o: any) => ({ date: o.date, value: parseFloat(o.value) }));

    if (observations.length === 0) return null;

    return {
      id: seriesId,
      title: meta?.title ?? seriesId,
      units: meta?.units ?? "",
      frequency: response.data.observations?.[0]?.frequency ?? "unknown",
      observations,
    };
  } catch (err) {
    logger.error("fred", `Failed to fetch ${seriesId}: ${err}`);
    return null;
  }
}

export async function fetchLatestValue(
  seriesId: string
): Promise<{ date: string; value: number } | null> {
  try {
    const response = await axios.get(`${FRED_BASE}/series/observations`, {
      params: {
        series_id: seriesId, api_key: config.FRED_API_KEY,
        file_type: "json", sort_order: "desc", limit: 1,
      },
    });
    const obs = response.data.observations?.[0];
    if (!obs || obs.value === ".") return null;
    return { date: obs.date, value: parseFloat(obs.value) };
  } catch (err) {
    logger.error("fred", `Failed to fetch latest ${seriesId}: ${err}`);
    return null;
  }
}

/**
 * Render a single-series chart with time horizon label.
 */
export async function renderChart(
  series: FredSeries,
  options?: { width?: number; height?: number; color?: string; months?: number }
): Promise<FredChartResult | null> {
  const { width = 800, height = 400, color = "#2563eb", months } = options ?? {};
  const obs = downsample(series.observations, 200);

  const duration = durationLabel(months, series.observations);
  const titleWithDuration = chartTitleWithDuration(series.title, duration);

  const chartConfig = {
    type: "line",
    data: {
      labels: obs.map((o) => o.date),
      datasets: [{
        label: `${titleWithDuration} (${series.units})`,
        data: obs.map((o) => o.value),
        borderColor: color, backgroundColor: color + "20",
        fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3,
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: titleWithDuration,
          font: { size: 16, weight: "bold" },
        },
        legend: { display: false },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } },
        y: { title: { display: true, text: series.units } },
      },
    },
  };

  try {
    const response = await axios.post(QUICKCHART_URL, {
      chart: chartConfig, width, height, format: "png", backgroundColor: "#ffffff",
    }, { responseType: "arraybuffer", timeout: 10_000 });

    return {
      buffer: Buffer.from(response.data),
      title: titleWithDuration,
      seriesId: series.id,
    };
  } catch (err) {
    logger.error("fred", `Chart render failed for ${series.id}: ${err}`);
    return null;
  }
}

/**
 * Render a multi-series chart with automatic dual/multi Y-axis support.
 *
 * When series have significantly different value scales (e.g. CPI Index ~300
 * vs Unemployment Rate ~4%), each group gets its own Y-axis so both are
 * readable without one being flattened to a near-zero line.
 *
 * Axis assignment is automatic:
 *   - Different units → separate axes
 *   - Same units but midpoint ratio > 5x → separate axes
 *   - Otherwise → shared axis
 *
 * Supports up to 6 series (limited by color palette). Left Y-axis for the
 * first group, right Y-axis for the second, additional axes stacked on right.
 */
export async function renderMultiSeriesChart(
  seriesList: FredSeries[],
  options?: { width?: number; height?: number; months?: number; title?: string }
): Promise<FredChartResult | null> {
  if (seriesList.length === 0) return null;

  // Single series → delegate to renderChart
  if (seriesList.length === 1) {
    return renderChart(seriesList[0], {
      width: options?.width,
      height: options?.height,
      months: options?.months,
    });
  }

  const { width = 900, height = 450, months } = options ?? {};
  const duration = durationLabel(months, seriesList[0].observations);
  const useMultiAxis = needsMultipleAxes(seriesList);
  const axisAssignments = useMultiAxis ? assignAxes(seriesList) : seriesList.map(() => 0);
  const numAxes = new Set(axisAssignments).size;

  logger.info(
    "fred",
    `Multi-series chart: ${seriesList.length} series, ${numAxes} axes, ` +
    `multiAxis=${useMultiAxis}`
  );

  // ── Align dates across all series ──
  // Use the series with the most observations as the date backbone
  const primarySeries = seriesList.reduce((a, b) =>
    a.observations.length >= b.observations.length ? a : b
  );
  const dateLabels = downsample(primarySeries.observations, 200).map((o) => o.date);

  // Build datasets
  const datasets = seriesList.map((series, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const obs = downsample(series.observations, 200);

    // Map observations to the shared date labels (nearest-date matching)
    const obsMap = new Map(obs.map((o) => [o.date, o.value]));
    const data = dateLabels.map((date) => {
      if (obsMap.has(date)) return obsMap.get(date)!;
      // Find nearest date
      const target = new Date(date).getTime();
      let closest: FredObservation | null = null;
      let minDiff = Infinity;
      for (const o of obs) {
        const diff = Math.abs(new Date(o.date).getTime() - target);
        if (diff < minDiff) { minDiff = diff; closest = o; }
      }
      return closest?.value ?? null;
    });

    const axisId = axisAssignments[i] === 0 ? "y" : `y${axisAssignments[i]}`;

    return {
      label: series.title,
      data,
      borderColor: color,
      backgroundColor: color + "20",
      fill: false,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
      yAxisID: axisId,
    };
  });

  // Build Y-axis scales
  const scales: Record<string, any> = {
    x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } },
  };

  // Group series by axis for labeling
  const axisGroups = new Map<number, FredSeries[]>();
  for (let i = 0; i < seriesList.length; i++) {
    const axisIdx = axisAssignments[i];
    if (!axisGroups.has(axisIdx)) axisGroups.set(axisIdx, []);
    axisGroups.get(axisIdx)!.push(seriesList[i]);
  }

  for (const [axisIdx, group] of axisGroups) {
    const axisId = axisIdx === 0 ? "y" : `y${axisIdx}`;
    const position = axisIdx === 0 ? "left" : "right";
    const color = CHART_COLORS[seriesList.indexOf(group[0]) % CHART_COLORS.length];

    // Build axis label from unique units in this group
    const units = [...new Set(group.map((s) => s.units))].join(" / ");

    scales[axisId] = {
      type: "linear",
      position,
      display: true,
      title: {
        display: true,
        text: units,
        color,
        font: { weight: "bold" },
      },
      ticks: { color },
      grid: {
        drawOnChartArea: axisIdx === 0, // only draw gridlines for the primary axis
      },
    };
  }

  // Build chart title
  const seriesTitles = seriesList.map((s) => s.title);
  const chartTitle = options?.title
    ? (duration ? `${options.title} (${duration})` : options.title)
    : (duration
        ? `${seriesTitles.join(" vs ")} (${duration})`
        : seriesTitles.join(" vs "));

  const chartConfig = {
    type: "line",
    data: { labels: dateLabels, datasets },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: chartTitle,
          font: { size: 14, weight: "bold" },
        },
        legend: {
          display: true,
          position: "bottom" as const,
          labels: { usePointStyle: true, boxWidth: 8 },
        },
      },
      scales,
    },
  };

  try {
    const response = await axios.post(QUICKCHART_URL, {
      chart: chartConfig, width, height, format: "png", backgroundColor: "#ffffff",
    }, { responseType: "arraybuffer", timeout: 10_000 });

    const combinedId = seriesList.map((s) => s.id).join("+");
    return {
      buffer: Buffer.from(response.data),
      title: chartTitle,
      seriesId: combinedId,
    };
  } catch (err) {
    logger.error("fred", `Multi-series chart render failed: ${err}`);
    return null;
  }
}

export async function renderYieldCurve(): Promise<FredChartResult | null> {
  logger.info("fred", "Building yield curve snapshot");

  const fetches = await Promise.allSettled(
    YIELD_CURVE_SERIES.map((s) => fetchLatestValue(s.id))
  );

  const labels: string[] = [];
  const values: number[] = [];

  for (let i = 0; i < YIELD_CURVE_SERIES.length; i++) {
    const result = fetches[i];
    if (result.status === "fulfilled" && result.value) {
      labels.push(YIELD_CURVE_SERIES[i].label);
      values.push(result.value.value);
    }
  }

  if (values.length < 3) return null;

  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "US Treasury Yield Curve",
        data: values,
        borderColor: "#dc2626", backgroundColor: "#dc262620",
        fill: true, borderWidth: 3, pointRadius: 5,
        pointBackgroundColor: "#dc2626", tension: 0.3,
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: `US Treasury Yield Curve (${new Date().toLocaleDateString()})`,
          font: { size: 16, weight: "bold" },
        },
        legend: { display: false },
      },
      scales: {
        x: { title: { display: true, text: "Maturity" } },
        y: { title: { display: true, text: "Yield (%)" } },
      },
    },
  };

  try {
    const response = await axios.post(QUICKCHART_URL, {
      chart: chartConfig, width: 800, height: 400, format: "png", backgroundColor: "#ffffff",
    }, { responseType: "arraybuffer", timeout: 10_000 });

    return {
      buffer: Buffer.from(response.data),
      title: `US Treasury Yield Curve (${new Date().toLocaleDateString()})`,
      seriesId: "YIELD_CURVE",
    };
  } catch (err) {
    logger.error("fred", `Yield curve render failed: ${err}`);
    return null;
  }
}

function downsample(obs: FredObservation[], maxPoints: number): FredObservation[] {
  if (obs.length <= maxPoints) return obs;
  const step = Math.ceil(obs.length / maxPoints);
  const result: FredObservation[] = [];
  for (let i = 0; i < obs.length; i += step) result.push(obs[i]);
  if (result[result.length - 1] !== obs[obs.length - 1]) result.push(obs[obs.length - 1]);
  return result;
}
