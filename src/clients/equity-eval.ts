import { logger } from "../utils/logger.js";
import {
  fetchAllFinancials,
  fetchIncomeStatementsYoY,
  fetchBalanceSheetsYoY,
  fetchCashFlowStatementsYoY,
} from "./fmp.js";
import {
  renderAllEquityCharts,
  renderIncomeGrowthTable,
  renderBalanceSheetGrowthTable,
  renderCashFlowGrowthTable,
} from "./equity-charts.js";
import type {
  FmpFinancialData,
  FredChartResult,
  EquityEvalResult,
} from "../types/index.js";
import type { YoYData } from "./equity-charts.js";

// ─── Evaluation Runner ───

const CHART_SEQUENCE = [
  "income-yoy-growth",
  "revenue-net-income",
  "margin-trends",
  "balance-yoy-growth",
  "leverage-liquidity",
  "cashflow-yoy-growth",
  "cashflow-breakdown",
  "valuation-multiples",
];

function orderEquityCharts(charts: FredChartResult[]): FredChartResult[] {
  const rank = new Map(CHART_SEQUENCE.map((id, index) => [id, index]));
  return [...charts].sort((a, b) => {
    const aRank = rank.get(a.seriesId) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rank.get(b.seriesId) ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return a.title.localeCompare(b.title);
  });
}

export async function evaluateFinancials(
  ticker: string,
  companyName: string,
  financialData?: FmpFinancialData,
): Promise<EquityEvalResult> {
  // Fetch financials if not pre-supplied
  const data = financialData ?? (await fetchAllFinancials(ticker));

  const hasData =
    data.incomeStatements.length > 0 ||
    data.balanceSheets.length > 0 ||
    data.cashFlowStatements.length > 0;

  if (!hasData) {
    logger.warn("equity-eval", `No financial data available for ${ticker}`);
    return {
      ticker,
      companyName,
      evaluation: "",
      charts: [],
      financialData: data,
      timestamp: new Date(),
    };
  }

  // Fetch YoY growth data in parallel
  logger.info("equity-eval", `Fetching YoY growth data for ${ticker}`);
  const [incomeYoY, balanceSheetYoY, cashFlowYoY] = await Promise.all([
    fetchIncomeStatementsYoY(ticker).catch((err) => {
      logger.warn("equity-eval", `Income YoY fetch failed: ${err}`);
      return [];
    }),
    fetchBalanceSheetsYoY(ticker).catch((err) => {
      logger.warn("equity-eval", `Balance sheet YoY fetch failed: ${err}`);
      return [];
    }),
    fetchCashFlowStatementsYoY(ticker).catch((err) => {
      logger.warn("equity-eval", `Cash flow YoY fetch failed: ${err}`);
      return [];
    }),
  ]);

  const yoy: YoYData = {
    income: incomeYoY.length > 0 ? incomeYoY : undefined,
    balanceSheet: balanceSheetYoY.length > 0 ? balanceSheetYoY : undefined,
    cashFlow: cashFlowYoY.length > 0 ? cashFlowYoY : undefined,
  };

  // Render metric charts and growth tables sequentially to avoid
  // exceeding CF Workers' concurrent HTTP connection limit (~6).
  // Parallel rendering caused "stalled HTTP response" deadlocks.
  const charts = await renderAllEquityCharts(data, yoy);
  const incomeTable = yoy.income ? await renderIncomeGrowthTable(yoy.income) : null;
  const balanceTable = yoy.balanceSheet ? await renderBalanceSheetGrowthTable(yoy.balanceSheet) : null;
  const cashFlowTable = yoy.cashFlow ? await renderCashFlowGrowthTable(yoy.cashFlow) : null;

  // Growth evaluation tables come first, then metric charts
  const evalTables: FredChartResult[] = [incomeTable, balanceTable, cashFlowTable].filter(
    (t): t is FredChartResult => t !== null,
  );

  const allCharts = orderEquityCharts([...evalTables, ...charts]);

  logger.info(
    "equity-eval",
    `${ticker}: ${evalTables.length} growth tables + ${charts.length} metric charts`,
  );

  return {
    ticker,
    companyName,
    evaluation: "",
    charts: allCharts,
    financialData: data,
    timestamp: new Date(),
  };
}
