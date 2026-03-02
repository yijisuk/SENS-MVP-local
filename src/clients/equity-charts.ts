import axios from "axios";
import { logger } from "../utils/logger.js";
import type {
  FmpIncomeStatement,
  FmpBalanceSheet,
  FmpCashFlowStatement,
  FmpFinRatios,
  FmpFinancialData,
  FredChartResult,
} from "../types/index.js";
import type {
  FmpIncomeStatementYoY,
  FmpBalanceSheetYoY,
  FmpCashFlowStatementYoY,
} from "./fmp.js";

const QUICKCHART_URL = "https://quickchart.io/chart";

const COLORS = {
  blue: "#2563eb",
  red: "#dc2626",
  green: "#16a34a",
  amber: "#d97706",
  violet: "#7c3aed",
  cyan: "#0891b2",
  gray: "#6b7280",
  orange: "#ea580c",
};

// ─── Helpers ───

function fmtLabel(date: string): string {
  const d = new Date(date);
  const q = Math.ceil((d.getMonth() + 1) / 3);
  return `Q${q}'${d.getFullYear().toString().slice(2)}`;
}

function fmtBillions(n: number): string {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  return n.toFixed(0);
}

/**
 * Map a YoY growth rate (decimal, e.g. 0.15 = 15%) to a color on a
 * green→red gradient.  Greener = higher growth; redder = decline.
 */
function growthColor(rate: number): string {
  const pct = rate * 100;
  if (pct >= 30) return "#166534";
  if (pct >= 15) return "#16a34a";
  if (pct >= 5) return "#4ade80";
  if (pct >= 0) return "#86efac";
  if (pct >= -5) return "#fca5a5";
  if (pct >= -15) return "#ef4444";
  if (pct >= -30) return "#dc2626";
  return "#991b1b";
}

// ─── FIX 1: Added  version: "4"  to both render helpers ───
// QuickChart defaults to Chart.js v2 which uses scales.xAxes / yAxes arrays.
// Our configs use v3+ object-key syntax (scales.x, scales.y, scales.y2),
// which v2 rejects with a 400.

async function renderQuickChart(
  chartConfig: Record<string, unknown>,
  width: number = 800,
  height: number = 400,
): Promise<Buffer | null> {
  try {
    const response = await axios.post(
      QUICKCHART_URL,
      {
        chart: chartConfig,
        width,
        height,
        format: "png",
        backgroundColor: "#ffffff",
        version: "4",               // ← FIX: force Chart.js v4
      },
      { responseType: "arraybuffer", timeout: 10_000 },
    );
    return Buffer.from(response.data);
  } catch (err) {
    logger.error("equity-charts", `Chart render failed: ${err}`);
    return null;
  }
}

/**
 * Render via QuickChart using a JavaScript-string config so we can embed
 * callback functions (formatters, conditional anchors, etc.).
 */
async function renderQuickChartJs(
  chartConfigJs: string,
  width: number = 800,
  height: number = 400,
): Promise<Buffer | null> {
  try {
    const response = await axios.post(
      QUICKCHART_URL,
      {
        chart: chartConfigJs,
        width,
        height,
        format: "png",
        backgroundColor: "#ffffff",
        version: "4",               // ← FIX: force Chart.js v4
      },
      { responseType: "arraybuffer", timeout: 10_000 },
    );
    return Buffer.from(response.data);
  } catch (err) {
    logger.error("equity-charts", `Chart render (JS) failed: ${err}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  Income Statement Charts
// ═══════════════════════════════════════════════════════════════

export async function renderRevenueAndNetIncome(
  statements: FmpIncomeStatement[],
  yoyData?: FmpIncomeStatementYoY[],
): Promise<FredChartResult | null> {
  if (statements.length < 2) return null;
  const sorted = [...statements].reverse();
  const labels = sorted.map((s) => fmtLabel(s.date));

  const datasets: Record<string, unknown>[] = [
    {
      label: "Revenue",
      data: sorted.map((s) => s.revenue),
      backgroundColor: COLORS.blue + "CC",
      borderColor: COLORS.blue,
      borderWidth: 1,
      yAxisID: "y",
      order: 2,
    },
    {
      label: "Net Income",
      data: sorted.map((s) => s.netIncome),
      backgroundColor: COLORS.green + "CC",
      borderColor: COLORS.green,
      borderWidth: 1,
      yAxisID: "y",
      order: 2,
    },
  ];

  const scales: Record<string, unknown> = {
    x: { ticks: { maxRotation: 0 } },
    y: {
      type: "linear",
      position: "left",
      title: { display: true, text: "USD" },
      // NOTE: ticks.callback with arrow fns are silently stripped by
      // JSON.stringify.  Use renderQuickChartJs (JS-string config) if
      // you need formatted tick labels.  Omitting the callback still
      // renders valid charts — QuickChart will just show raw numbers.
    },
  };

  // Overlay: Revenue YoY % growth line on secondary axis
  if (yoyData && yoyData.length > 0) {
    const yoyMap = new Map(yoyData.map((y) => [fmtLabel(y.date), y.revenueYoY * 100]));
    const revenueYoY = labels.map((l) => yoyMap.get(l) ?? null);

    datasets.push({
      label: "Revenue YoY %",
      data: revenueYoY,
      type: "line",
      borderColor: COLORS.orange,
      backgroundColor: COLORS.orange + "20",
      borderWidth: 2,
      pointRadius: 4,
      pointBackgroundColor: COLORS.orange,
      fill: false,
      tension: 0.3,
      yAxisID: "y2",
      order: 1,
    });

    scales["y2"] = {
      type: "linear",
      position: "right",
      title: { display: true, text: "YoY %", color: COLORS.orange, font: { weight: "bold" } },
      ticks: { color: COLORS.orange },
      grid: { drawOnChartArea: false },
    };
  }

  const chartConfig = {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: "Revenue & Net Income (Trailing 8Q)", font: { size: 14, weight: "bold" } },
        legend: { display: true, position: "bottom" },
      },
      scales,
    },
  };

  const buffer = await renderQuickChart(chartConfig);
  if (!buffer) return null;
  return { buffer, title: "Revenue & Net Income (Trailing 8Q)", seriesId: "revenue-net-income" };
}

// ─── FIX 2: Compute margins from raw values when ratios are 0 ───

export async function renderMarginTrends(
  statements: FmpIncomeStatement[],
): Promise<FredChartResult | null> {
  if (statements.length < 2) return null;
  const sorted = [...statements].reverse();
  const labels = sorted.map((s) => fmtLabel(s.date));

  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Gross Margin",
          data: sorted.map((s) => {
            // Use the ratio if it's non-zero; otherwise compute it
            if (s.grossProfitRatio && s.grossProfitRatio !== 0) {
              return s.grossProfitRatio * 100;
            }
            return s.revenue !== 0 ? (s.grossProfit / s.revenue) * 100 : 0;
          }),
          borderColor: COLORS.blue,
          backgroundColor: COLORS.blue + "20",
          fill: false,
          borderWidth: 2,
          pointRadius: 4,
          tension: 0.3,
        },
        {
          label: "Operating Margin",
          data: sorted.map((s) => {
            if (s.operatingIncomeRatio && s.operatingIncomeRatio !== 0) {
              return s.operatingIncomeRatio * 100;
            }
            return s.revenue !== 0 ? (s.operatingIncome / s.revenue) * 100 : 0;
          }),
          borderColor: COLORS.amber,
          backgroundColor: COLORS.amber + "20",
          fill: false,
          borderWidth: 2,
          pointRadius: 4,
          tension: 0.3,
        },
        {
          label: "Net Margin",
          data: sorted.map((s) => {
            if (s.netIncomeRatio && s.netIncomeRatio !== 0) {
              return s.netIncomeRatio * 100;
            }
            return s.revenue !== 0 ? (s.netIncome / s.revenue) * 100 : 0;
          }),
          borderColor: COLORS.green,
          backgroundColor: COLORS.green + "20",
          fill: false,
          borderWidth: 2,
          pointRadius: 4,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: "Margin Trends (Trailing 8Q)", font: { size: 14, weight: "bold" } },
        legend: { display: true, position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
      },
      scales: {
        x: { ticks: { maxRotation: 0 } },
        y: { title: { display: true, text: "%" } },
      },
    },
  };

  const buffer = await renderQuickChart(chartConfig);
  if (!buffer) return null;
  return { buffer, title: "Margin Trends (Trailing 8Q)", seriesId: "margin-trends" };
}

// ═══════════════════════════════════════════════════════════════
//  Balance Sheet Charts
// ═══════════════════════════════════════════════════════════════

export async function renderLeverageAndLiquidity(
  balanceSheets: FmpBalanceSheet[],
  keyMetrics: FmpFinRatios[],
): Promise<FredChartResult | null> {
  if (balanceSheets.length < 2) return null;
  const sorted = [...balanceSheets].reverse();
  const metricsSorted = [...keyMetrics].reverse();
  const labels = sorted.map((s) => fmtLabel(s.date));

  const debtToEquity = sorted.map((s, i) => {
    const ttm = metricsSorted[i]?.debtToEquityRatio;
    if (ttm) return ttm;
    return s.totalStockholdersEquity !== 0
      ? s.totalDebt / s.totalStockholdersEquity
      : 0;
  });

  const currentRatio = sorted.map((s, i) => {
    const ttm = metricsSorted[i]?.currentRatio;
    if (ttm) return ttm;
    return s.totalCurrentLiabilities !== 0
      ? s.totalCurrentAssets / s.totalCurrentLiabilities
      : 0;
  });

  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Debt/Equity",
          data: debtToEquity,
          borderColor: COLORS.red,
          backgroundColor: COLORS.red + "20",
          fill: false,
          borderWidth: 2,
          pointRadius: 4,
          tension: 0.3,
          yAxisID: "y",
        },
        {
          label: "Current Ratio",
          data: currentRatio,
          borderColor: COLORS.blue,
          backgroundColor: COLORS.blue + "20",
          fill: false,
          borderWidth: 2,
          pointRadius: 4,
          tension: 0.3,
          yAxisID: "y2",
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: "Leverage & Liquidity (Trailing 8Q)", font: { size: 14, weight: "bold" } },
        legend: { display: true, position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
      },
      scales: {
        x: { ticks: { maxRotation: 0 } },
        y: {
          type: "linear",
          position: "left",
          title: { display: true, text: "D/E Ratio", color: COLORS.red, font: { weight: "bold" } },
          ticks: { color: COLORS.red },
          grid: { drawOnChartArea: true },
        },
        y2: {
          type: "linear",
          position: "right",
          title: { display: true, text: "Current Ratio", color: COLORS.blue, font: { weight: "bold" } },
          ticks: { color: COLORS.blue },
          grid: { drawOnChartArea: false },
        },
      },
    },
  };

  const buffer = await renderQuickChart(chartConfig);
  if (!buffer) return null;
  return { buffer, title: "Leverage & Liquidity (Trailing 8Q)", seriesId: "leverage-liquidity" };
}

// ═══════════════════════════════════════════════════════════════
//  Cash Flow Charts
// ═══════════════════════════════════════════════════════════════

export async function renderCashFlowBreakdown(
  statements: FmpCashFlowStatement[],
  yoyData?: FmpCashFlowStatementYoY[],
): Promise<FredChartResult | null> {
  if (statements.length < 2) return null;
  const sorted = [...statements].reverse();
  const labels = sorted.map((s) => fmtLabel(s.date));

  const datasets: Record<string, unknown>[] = [
    {
      label: "Operating CF",
      data: sorted.map((s) => s.operatingCashFlow),
      backgroundColor: COLORS.blue + "CC",
      borderColor: COLORS.blue,
      borderWidth: 1,
      yAxisID: "y",
      order: 2,
    },
    {
      label: "Capex",
      data: sorted.map((s) => s.capitalExpenditure),
      backgroundColor: COLORS.red + "CC",
      borderColor: COLORS.red,
      borderWidth: 1,
      yAxisID: "y",
      order: 2,
    },
    {
      label: "Free Cash Flow",
      data: sorted.map((s) => s.freeCashFlow),
      backgroundColor: COLORS.green + "CC",
      borderColor: COLORS.green,
      borderWidth: 1,
      yAxisID: "y",
      order: 2,
    },
  ];

  const scales: Record<string, unknown> = {
    x: { ticks: { maxRotation: 0 } },
    y: {
      type: "linear",
      position: "left",
      title: { display: true, text: "USD" },
    },
  };

  // Overlay: FCF YoY % growth line on secondary axis
  if (yoyData && yoyData.length > 0) {
    const yoyMap = new Map(yoyData.map((y) => [fmtLabel(y.date), y.freeCashFlowYoY * 100]));
    const fcfYoY = labels.map((l) => yoyMap.get(l) ?? null);

    datasets.push({
      label: "FCF YoY %",
      data: fcfYoY,
      type: "line",
      borderColor: COLORS.violet,
      backgroundColor: COLORS.violet + "20",
      borderWidth: 2,
      pointRadius: 4,
      pointBackgroundColor: COLORS.violet,
      fill: false,
      tension: 0.3,
      yAxisID: "y2",
      order: 1,
    });

    scales["y2"] = {
      type: "linear",
      position: "right",
      title: { display: true, text: "YoY %", color: COLORS.violet, font: { weight: "bold" } },
      ticks: { color: COLORS.violet },
      grid: { drawOnChartArea: false },
    };
  }

  const chartConfig = {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: "Cash Flow Breakdown (Trailing 8Q)", font: { size: 14, weight: "bold" } },
        legend: { display: true, position: "bottom" },
      },
      scales,
    },
  };

  const buffer = await renderQuickChart(chartConfig);
  if (!buffer) return null;
  return { buffer, title: "Cash Flow Breakdown (Trailing 8Q)", seriesId: "cashflow-breakdown" };
}

// ═══════════════════════════════════════════════════════════════
//  Valuation Charts
// ═══════════════════════════════════════════════════════════════

// ─── FIX 3: Relax the guard from length < 2 to length < 1 ───
// When ttmFinRatios has only 1 entry (the current TTM snapshot),
// the old  length < 2  guard silently killed this chart entirely.
// With a single data point we still render a dot on the chart;
// the user at least sees the current multiples.

export async function renderValuationMultiples(
  keyMetrics: FmpFinRatios[],
  dateFallbacks: string[],
  sector?: string,
): Promise<FredChartResult | null> {
  if (keyMetrics.length < 1) return null;          // ← was < 2
  const sorted = [...keyMetrics].reverse();
  const datesSorted = [...dateFallbacks].reverse();

  const labels = sorted.map((s, i) => {
    if (s.date) return fmtLabel(s.date);
    if (datesSorted[i]) return fmtLabel(datesSorted[i]);
    return `Q${i + 1}`;
  });

  // When we only have 1 TTM entry but multiple dateFallbacks, pad labels
  // so the single dot appears at the rightmost position.
  if (sorted.length === 1 && datesSorted.length > 1) {
    const paddedLabels = datesSorted.map((d) => fmtLabel(d));
    const paddedData = (val: number | null) => {
      const arr: (number | null)[] = new Array(paddedLabels.length - 1).fill(null);
      arr.push(val);
      return arr;
    };

    const isGrowth = sector && /technology|software|internet|biotech/i.test(sector);
    const isFinancial = sector && /financial|banking|insurance/i.test(sector);
    const isIndustrial = sector && /industrial|materials|energy|utilities/i.test(sector);

    const s = sorted[0];

    // Build candidate series (single TTM entry, padded)
    interface TtmSeries { label: string; data: (number | null)[]; color: string; value: number | null }
    const ttmCandidates: TtmSeries[] = [];

    if (!isFinancial) {
      const v = s.priceToEarningsRatio;
      const val = v > 0 && v < 500 ? v : null;
      ttmCandidates.push({ label: "P/E Ratio", data: paddedData(val), color: COLORS.blue, value: val });
    }

    if (isIndustrial || isFinancial) {
      const v = s.priceToBookRatio;
      const val = v > 0 && v < 100 ? v : null;
      ttmCandidates.push({ label: "P/B Ratio", data: paddedData(val), color: COLORS.amber, value: val });
    }

    if (isGrowth) {
      const v = s.priceToSalesRatio;
      const val = v > 0 && v < 200 ? v : null;
      ttmCandidates.push({ label: "P/S Ratio", data: paddedData(val), color: COLORS.violet, value: val });
    }

    const ev = s.enterpriseValueMultiple;
    const evVal = ev > 0 && ev < 200 ? ev : null;
    ttmCandidates.push({ label: "EV/EBITDA", data: paddedData(evVal), color: COLORS.green, value: evVal });

    // Filter to series with valid data
    const ttmValid = ttmCandidates.filter((c) => c.value !== null);
    if (ttmValid.length === 0) return null;

    // Multi-axis detection for TTM path
    const ttmValues = ttmValid.map((c) => Math.abs(c.value!));
    const TTM_SCALE_THRESHOLD = 3;
    const ttmAxisAssign: number[] = new Array(ttmValid.length).fill(-1);
    let ttmNextAxis = 0;
    for (let i = 0; i < ttmValid.length; i++) {
      if (ttmAxisAssign[i] >= 0) continue;
      ttmAxisAssign[i] = ttmNextAxis;
      for (let j = i + 1; j < ttmValid.length; j++) {
        if (ttmAxisAssign[j] >= 0) continue;
        const ratio = ttmValues[i] > 0 && ttmValues[j] > 0
          ? Math.max(ttmValues[i] / ttmValues[j], ttmValues[j] / ttmValues[i])
          : Infinity;
        if (ratio <= TTM_SCALE_THRESHOLD) ttmAxisAssign[j] = ttmNextAxis;
      }
      ttmNextAxis++;
    }

    const ttmNeedsMultiAxis = new Set(ttmAxisAssign).size > 1;

    const datasets: Record<string, unknown>[] = ttmValid.map((c, i) => ({
      label: c.label,
      data: c.data,
      borderColor: c.color,
      backgroundColor: c.color + "20",
      fill: false,
      borderWidth: 2,
      pointRadius: 6,
      tension: 0.3,
      yAxisID: ttmNeedsMultiAxis ? (ttmAxisAssign[i] === 0 ? "y" : "y2") : "y",
    }));

    const ttmScales: Record<string, unknown> = { x: { ticks: { maxRotation: 0 } } };
    if (ttmNeedsMultiAxis) {
      const ttmAxisGroups = new Map<number, { labels: string[]; color: string }>();
      for (let i = 0; i < ttmValid.length; i++) {
        const axis = ttmAxisAssign[i];
        if (!ttmAxisGroups.has(axis)) ttmAxisGroups.set(axis, { labels: [], color: ttmValid[i].color });
        ttmAxisGroups.get(axis)!.labels.push(ttmValid[i].label);
      }
      for (const [axisIdx, group] of ttmAxisGroups) {
        const axisId = axisIdx === 0 ? "y" : "y2";
        const position = axisIdx === 0 ? "left" : "right";
        ttmScales[axisId] = {
          type: "linear", position, display: true,
          title: { display: true, text: group.labels.join(", "), color: group.color, font: { weight: "bold", size: 11 } },
          ticks: { color: group.color },
          grid: { drawOnChartArea: axisIdx === 0 },
        };
      }
    } else {
      ttmScales["y"] = { title: { display: true, text: "Multiple" } };
    }

    const chartConfig = {
      type: "line",
      data: { labels: paddedLabels, datasets },
      options: {
        responsive: false,
        plugins: {
          title: { display: true, text: "Valuation Multiples (Current TTM)", font: { size: 14, weight: "bold" } },
          legend: { display: true, position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
        },
        scales: ttmScales,
      },
    };

    const buffer = await renderQuickChart(chartConfig);
    if (!buffer) return null;
    return { buffer, title: "Valuation Multiples (Current TTM)", seriesId: "valuation-multiples" };
  }

  // ── Original multi-quarter path ──
  // FIX: Auto-detect scale differences and assign dual Y-axes when metrics
  // differ by >3x median (e.g. P/B ~2x vs EV/EBITDA ~25x).

  const isGrowth = sector && /technology|software|internet|biotech/i.test(sector);
  const isFinancial = sector && /financial|banking|insurance/i.test(sector);
  const isIndustrial = sector && /industrial|materials|energy|utilities/i.test(sector);

  // Build candidate series with their data arrays
  interface ValSeries {
    label: string;
    data: (number | null)[];
    color: string;
  }
  const candidates: ValSeries[] = [];

  if (!isFinancial) {
    candidates.push({
      label: "P/E Ratio",
      data: sorted.map((s) => {
        const v = s.priceToEarningsRatio;
        return v > 0 && v < 500 ? v : null;
      }),
      color: COLORS.blue,
    });
  }

  if (isIndustrial || isFinancial) {
    candidates.push({
      label: "P/B Ratio",
      data: sorted.map((s) => {
        const v = s.priceToBookRatio;
        return v > 0 && v < 100 ? v : null;
      }),
      color: COLORS.amber,
    });
  }

  if (isGrowth) {
    candidates.push({
      label: "P/S Ratio",
      data: sorted.map((s) => {
        const v = s.priceToSalesRatio;
        return v > 0 && v < 200 ? v : null;
      }),
      color: COLORS.violet,
    });
  }

  candidates.push({
    label: "EV/EBITDA",
    data: sorted.map((s) => {
      const v = s.enterpriseValueMultiple;
      return v > 0 && v < 200 ? v : null;
    }),
    color: COLORS.green,
  });

  // Filter out series with no valid data
  const validSeries = candidates.filter((c) => c.data.some((v) => v !== null));
  if (validSeries.length === 0) return null;

  // ── Multi-axis detection ──
  // Compute median absolute value for each series, then cluster into
  // groups where members are within 3x of each other. If >1 group
  // exists, assign separate Y-axes.
  function medianOf(arr: (number | null)[]): number {
    const nums = arr.filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b);
    if (nums.length === 0) return 0;
    return nums[Math.floor(nums.length / 2)];
  }

  const medians = validSeries.map((s) => medianOf(s.data));
  const SCALE_THRESHOLD = 3; // >3x difference triggers separate axis

  // Greedy clustering: assign each series to an axis group
  const axisAssignment: number[] = new Array(validSeries.length).fill(-1);
  let nextAxis = 0;
  for (let i = 0; i < validSeries.length; i++) {
    if (axisAssignment[i] >= 0) continue;
    axisAssignment[i] = nextAxis;
    for (let j = i + 1; j < validSeries.length; j++) {
      if (axisAssignment[j] >= 0) continue;
      const ratio = medians[i] > 0 && medians[j] > 0
        ? Math.max(medians[i] / medians[j], medians[j] / medians[i])
        : Infinity;
      if (ratio <= SCALE_THRESHOLD) {
        axisAssignment[j] = nextAxis;
      }
    }
    nextAxis++;
  }

  const needsMultiAxis = new Set(axisAssignment).size > 1;
  if (needsMultiAxis) {
    logger.info("equity-charts", `Valuation multi-axis: ${validSeries.map((s, i) => `${s.label}→y${axisAssignment[i]}`).join(", ")}`);
  }

  // Build datasets with yAxisID
  const datasets: Record<string, unknown>[] = validSeries.map((s, i) => ({
    label: s.label,
    data: s.data,
    borderColor: s.color,
    backgroundColor: s.color + "20",
    fill: false,
    borderWidth: 2,
    pointRadius: 4,
    tension: 0.3,
    yAxisID: needsMultiAxis ? (axisAssignment[i] === 0 ? "y" : "y2") : "y",
  }));

  // Build scales
  const scales: Record<string, unknown> = {
    x: { ticks: { maxRotation: 0 } },
  };

  if (needsMultiAxis) {
    // Group series labels by axis for axis titles
    const axisGroups = new Map<number, { labels: string[]; color: string }>();
    for (let i = 0; i < validSeries.length; i++) {
      const axis = axisAssignment[i];
      if (!axisGroups.has(axis)) axisGroups.set(axis, { labels: [], color: validSeries[i].color });
      axisGroups.get(axis)!.labels.push(validSeries[i].label);
    }

    for (const [axisIdx, group] of axisGroups) {
      const axisId = axisIdx === 0 ? "y" : "y2";
      const position = axisIdx === 0 ? "left" : "right";
      scales[axisId] = {
        type: "linear",
        position,
        display: true,
        title: {
          display: true,
          text: group.labels.join(", "),
          color: group.color,
          font: { weight: "bold", size: 11 },
        },
        ticks: { color: group.color },
        grid: { drawOnChartArea: axisIdx === 0 },
      };
    }
  } else {
    scales["y"] = { title: { display: true, text: "Multiple" } };
  }

  const chartConfig = {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: "Valuation Multiples (Trailing 8Q)", font: { size: 14, weight: "bold" } },
        legend: { display: true, position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
      },
      scales,
    },
  };

  const buffer = await renderQuickChart(chartConfig);
  if (!buffer) return null;
  return { buffer, title: "Valuation Multiples (Trailing 8Q)", seriesId: "valuation-multiples" };
}

// ═══════════════════════════════════════════════════════════════
//  YoY Growth Evaluation Tables — Color-Coded Bar Charts
// ═══════════════════════════════════════════════════════════════

/**
 * Grouped bar chart where each bar is individually colored by its YoY growth
 * value (green gradient → positive, red gradient → negative).
 *
 * Uses QuickChart JS-string config to support datalabels formatter callback.
 */
async function renderGrowthTable(
  title: string,
  labels: string[],
  series: { name: string; values: (number | null)[] }[],
  seriesId: string,
): Promise<FredChartResult | null> {
  if (labels.length === 0 || series.length === 0) return null;

  const datasets = series.map((s) => {
    const pctValues = s.values.map((v) => (v !== null ? +(v * 100).toFixed(1) : null));
    const bgColors = pctValues.map((v) =>
      v !== null ? growthColor(v / 100) : "transparent",
    );

    return {
      label: s.name,
      data: pctValues,
      backgroundColor: bgColors,
      borderColor: bgColors,
      borderWidth: 1,
    };
  });

  const chartConfigJs = `{
    type: 'bar',
    data: {
      labels: ${JSON.stringify(labels)},
      datasets: ${JSON.stringify(datasets)}
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: ${JSON.stringify(title)}, font: { size: 14, weight: 'bold' } },
        legend: { display: ${series.length > 1}, position: 'bottom' },
        datalabels: {
          display: function(ctx) {
            return ctx.dataset.data[ctx.dataIndex] !== null;
          },
          anchor: function(ctx) {
            return ctx.dataset.data[ctx.dataIndex] >= 0 ? 'end' : 'start';
          },
          align: function(ctx) {
            return ctx.dataset.data[ctx.dataIndex] >= 0 ? 'top' : 'bottom';
          },
          formatter: function(v) { return v !== null ? v.toFixed(1) + '%' : ''; },
          font: { size: 10, weight: 'bold' },
          color: '#333'
        }
      },
      scales: {
        x: { ticks: { maxRotation: 0 } },
        y: {
          title: { display: true, text: 'YoY Growth %' },
          ticks: { callback: function(v) { return v + '%'; } }
        }
      }
    }
  }`;

  const buffer = await renderQuickChartJs(chartConfigJs);
  if (!buffer) return null;
  return { buffer, title, seriesId };
}

/**
 * Income Statement YoY growth evaluation table.
 * Metrics: Revenue, Net Income, EPS.
 */
export async function renderIncomeGrowthTable(
  yoyData: FmpIncomeStatementYoY[],
): Promise<FredChartResult | null> {
  if (yoyData.length < 2) return null;
  const sorted = [...yoyData].sort((a, b) => a.date.localeCompare(b.date));
  const labels = sorted.map((s) => fmtLabel(s.date));

  return renderGrowthTable(
    "Income Statement \u2014 YoY Growth",
    labels,
    [
      { name: "Revenue", values: sorted.map((s) => s.revenueYoY || null) },
      { name: "Net Income", values: sorted.map((s) => s.netIncomeYoY || null) },
      { name: "EPS", values: sorted.map((s) => s.epsYoY || null) },
    ],
    "income-yoy-growth",
  );
}

/**
 * Balance Sheet YoY growth evaluation table.
 * Metrics: Total Assets, Equity, Total Debt.
 */
export async function renderBalanceSheetGrowthTable(
  yoyData: FmpBalanceSheetYoY[],
): Promise<FredChartResult | null> {
  if (yoyData.length < 2) return null;
  const sorted = [...yoyData].sort((a, b) => a.date.localeCompare(b.date));
  const labels = sorted.map((s) => fmtLabel(s.date));

  return renderGrowthTable(
    "Balance Sheet \u2014 YoY Growth",
    labels,
    [
      { name: "Total Assets", values: sorted.map((s) => s.totalAssetsYoY || null) },
      { name: "Equity", values: sorted.map((s) => s.totalEquityYoY || null) },
      { name: "Total Debt", values: sorted.map((s) => s.totalDebtYoY || null) },
    ],
    "balance-sheet-yoy-growth",
  );
}

/**
 * Cash Flow YoY growth evaluation table.
 * Metrics: Operating CF, Free Cash Flow.
 */
export async function renderCashFlowGrowthTable(
  yoyData: FmpCashFlowStatementYoY[],
): Promise<FredChartResult | null> {
  if (yoyData.length < 2) return null;
  const sorted = [...yoyData].sort((a, b) => a.date.localeCompare(b.date));
  const labels = sorted.map((s) => fmtLabel(s.date));

  return renderGrowthTable(
    "Cash Flow \u2014 YoY Growth",
    labels,
    [
      { name: "Operating CF", values: sorted.map((s) => s.operatingCashFlowYoY || null) },
      { name: "Free Cash Flow", values: sorted.map((s) => s.freeCashFlowYoY || null) },
    ],
    "cashflow-yoy-growth",
  );
}

// ═══════════════════════════════════════════════════════════════
//  Master Renderer
// ═══════════════════════════════════════════════════════════════

export interface YoYData {
  income?: FmpIncomeStatementYoY[];
  balanceSheet?: FmpBalanceSheetYoY[];
  cashFlow?: FmpCashFlowStatementYoY[];
}

export async function renderAllEquityCharts(
  data: FmpFinancialData,
  yoy?: YoYData,
): Promise<FredChartResult[]> {
  const dateFallbacks = data.balanceSheets.map((s) => s.date);

  // Render charts sequentially to avoid exceeding CF Workers' concurrent
  // HTTP connection limit (~6). Parallel Promise.all() with 5+ QuickChart
  // calls causes "stalled HTTP response" deadlocks.
  const chartFns = [
    () => renderRevenueAndNetIncome(data.incomeStatements, yoy?.income),
    () => renderMarginTrends(data.incomeStatements),
    () => renderLeverageAndLiquidity(data.balanceSheets, data.ttmFinRatios),
    () => renderCashFlowBreakdown(data.cashFlowStatements, yoy?.cashFlow),
    () => renderValuationMultiples(data.ttmFinRatios, dateFallbacks, data.profile?.sector),
  ];

  const charts: FredChartResult[] = [];
  for (const fn of chartFns) {
    const result = await fn();
    if (result) charts.push(result);
  }

  logger.info("equity-charts", `Rendered ${charts.length} equity charts`);
  return charts;
}