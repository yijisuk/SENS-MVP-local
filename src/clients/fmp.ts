import axios from "axios";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import type {
  FmpIncomeStatement,
  FmpBalanceSheet,
  FmpCashFlowStatement,
  FmpFinRatios,
  FmpCompanyProfile,
  FmpFinancialData,
} from "../types/index.js";

const FMP_BASE = "https://financialmodelingprep.com/stable";

// ─── Raw API Fetchers ───

async function fmpGet<T>(
  path: string,
  params?: Record<string, string | number>
): Promise<T | null> {
  try {
    const response = await axios.get(`${FMP_BASE}${path}`, {
      params: { ...params, apikey: config.FMP_API_KEY },
      timeout: 15_000,
    });
    return response.data as T;
  } catch (err) {
    logger.error("fmp", `Failed to fetch ${path}: ${err}`);
    return null;
  }
}

export async function fetchCompanyProfile(
  ticker: string
): Promise<FmpCompanyProfile | null> {
  const data = await fmpGet<FmpCompanyProfile[]>(`/profile?symbol=${ticker}`);
  if (!data || data.length === 0) return null;
  const p = data[0];
  return {
    symbol: p.symbol,
    companyName: p.companyName,
    sector: p.sector,
    industry: p.industry,
    mktCap: p.mktCap,
    description: p.description,
    exchange: p.exchange,
    country: p.country,
    ipoDate: p.ipoDate,
  };
}

export async function fetchIncomeStatements(
  ticker: string,
  limit: number = 8
): Promise<FmpIncomeStatement[]> {
  const data = await fmpGet<FmpIncomeStatement[]>(
    `/income-statement?symbol=${ticker}`,
    { period: "quarter", limit }
  );
  return (data ?? []).map((s) => ({
    date: s.date,
    period: s.period,
    revenue: s.revenue ?? 0,
    costOfRevenue: s.costOfRevenue ?? 0,
    grossProfit: s.grossProfit ?? 0,
    grossProfitRatio: s.grossProfitRatio ?? 0,
    operatingExpenses: s.operatingExpenses ?? 0,
    sellingGeneralAndAdministrativeExpenses:
      s.sellingGeneralAndAdministrativeExpenses ?? 0,
    researchAndDevelopmentExpenses: s.researchAndDevelopmentExpenses ?? 0,
    operatingIncome: s.operatingIncome ?? 0,
    operatingIncomeRatio: s.operatingIncomeRatio ?? 0,
    interestExpense: s.interestExpense ?? 0,
    incomeBeforeTax: s.incomeBeforeTax ?? 0,
    netIncome: s.netIncome ?? 0,
    netIncomeRatio: s.netIncomeRatio ?? 0,
    eps: s.eps ?? 0,
    epsdiluted: s.epsdiluted ?? 0,
    weightedAverageShsOut: s.weightedAverageShsOut ?? 0,
    weightedAverageShsOutDil: s.weightedAverageShsOutDil ?? 0,
  }));
}

export async function fetchBalanceSheets(
  ticker: string,
  limit: number = 8
): Promise<FmpBalanceSheet[]> {
  const data = await fmpGet<FmpBalanceSheet[]>(
    `/balance-sheet-statement?symbol=${ticker}`,
    { period: "quarter", limit }
  );
  return (data ?? []).map((s) => ({
    date: s.date,
    period: s.period,
    cashAndCashEquivalents: s.cashAndCashEquivalents ?? 0,
    shortTermInvestments: s.shortTermInvestments ?? 0,
    cashAndShortTermInvestments: s.cashAndShortTermInvestments ?? 0,
    netReceivables: s.netReceivables ?? 0,
    inventory: s.inventory ?? 0,
    totalCurrentAssets: s.totalCurrentAssets ?? 0,
    totalCurrentLiabilities: s.totalCurrentLiabilities ?? 0,
    totalAssets: s.totalAssets ?? 0,
    totalLiabilities: s.totalLiabilities ?? 0,
    totalStockholdersEquity: s.totalStockholdersEquity ?? 0,
    totalDebt: s.totalDebt ?? 0,
    netDebt: s.netDebt ?? 0,
    goodwill: s.goodwill ?? 0,
    intangibleAssets: s.intangibleAssets ?? 0,
    goodwillAndIntangibleAssets: s.goodwillAndIntangibleAssets ?? 0,
    accountPayables: s.accountPayables ?? 0,
    longTermDebt: s.longTermDebt ?? 0,
    shortTermDebt: s.shortTermDebt ?? 0,
    propertyPlantEquipmentNet: s.propertyPlantEquipmentNet ?? 0,
  }));
}

export async function fetchCashFlowStatements(
  ticker: string,
  limit: number = 8
): Promise<FmpCashFlowStatement[]> {
  const data = await fmpGet<FmpCashFlowStatement[]>(
    `/cash-flow-statement?symbol=${ticker}`,
    { period: "quarter", limit }
  );
  return (data ?? []).map((s) => ({
    date: s.date,
    period: s.period,
    netIncome: s.netIncome ?? 0,
    operatingCashFlow: s.operatingCashFlow ?? 0,
    capitalExpenditure: s.capitalExpenditure ?? 0,
    freeCashFlow: s.freeCashFlow ?? 0,
    dividendsPaid: s.dividendsPaid ?? 0,
    commonStockRepurchased: s.commonStockRepurchased ?? 0,
    debtRepayment: s.debtRepayment ?? 0,
    depreciationAndAmortization: s.depreciationAndAmortization ?? 0,
    stockBasedCompensation: s.stockBasedCompensation ?? 0,
    changeInWorkingCapital: s.changeInWorkingCapital ?? 0,
    accountsReceivables: s.accountsReceivables ?? 0,
    accountsPayables: s.accountsPayables ?? 0,
    inventory: s.inventory ?? 0,
  }));
}

export async function fetchFinRatios(
  ticker: string,
  limit: number = 8
): Promise<FmpFinRatios[]> {
  const data = await fmpGet<FmpFinRatios[]>(
    `/ratios?symbol=${ticker}`,
    { period: "quarter", limit }
  );

  // Return the API response shape as-is (with safe defaults).
  return (data ?? []).map((s) => ({
    symbol: s.symbol ?? ticker,
    date: (s as any).date ?? undefined,
    fiscalYear: (s as any).fiscalYear ?? undefined,
    period: (s as any).period ?? undefined,

    grossProfitMargin: s.grossProfitMargin ?? 0,
    ebitMargin: s.ebitMargin ?? 0,
    ebitdaMargin: s.ebitdaMargin ?? 0,
    operatingProfitMargin: s.operatingProfitMargin ?? 0,
    pretaxProfitMargin: s.pretaxProfitMargin ?? 0,
    continuousOperationsProfitMargin: s.continuousOperationsProfitMargin ?? 0,
    netProfitMargin: s.netProfitMargin ?? 0,
    bottomLineProfitMargin: s.bottomLineProfitMargin ?? 0,

    receivablesTurnover: s.receivablesTurnover ?? 0,
    payablesTurnover: s.payablesTurnover ?? 0,
    inventoryTurnover: s.inventoryTurnover ?? 0,
    fixedAssetTurnover: s.fixedAssetTurnover ?? 0,
    assetTurnover: s.assetTurnover ?? 0,

    currentRatio: s.currentRatio ?? 0,
    quickRatio: s.quickRatio ?? 0,
    solvencyRatio: s.solvencyRatio ?? 0,
    cashRatio: s.cashRatio ?? 0,

    priceToEarningsRatio: s.priceToEarningsRatio ?? 0,
    priceToEarningsGrowthRatio: s.priceToEarningsGrowthRatio ?? 0,
    forwardPriceToEarningsGrowthRatio: s.forwardPriceToEarningsGrowthRatio ?? 0,
    priceToBookRatio: s.priceToBookRatio ?? 0,
    priceToSalesRatio: s.priceToSalesRatio ?? 0,
    priceToFreeCashFlowRatio: s.priceToFreeCashFlowRatio ?? 0,
    priceToOperatingCashFlowRatio: s.priceToOperatingCashFlowRatio ?? 0,
    priceToFairValue: s.priceToFairValue ?? 0,

    debtToAssetsRatio: s.debtToAssetsRatio ?? 0,
    debtToEquityRatio: s.debtToEquityRatio ?? 0,
    debtToCapitalRatio: s.debtToCapitalRatio ?? 0,
    longTermDebtToCapitalRatio: s.longTermDebtToCapitalRatio ?? 0,
    financialLeverageRatio: s.financialLeverageRatio ?? 0,
    workingCapitalTurnoverRatio: s.workingCapitalTurnoverRatio ?? 0,

    operatingCashFlowRatio: s.operatingCashFlowRatio ?? 0,
    operatingCashFlowSalesRatio: s.operatingCashFlowSalesRatio ?? 0,
    freeCashFlowOperatingCashFlowRatio: s.freeCashFlowOperatingCashFlowRatio ?? 0,

    debtServiceCoverageRatio: s.debtServiceCoverageRatio ?? 0,
    interestCoverageRatio: s.interestCoverageRatio ?? 0,
    shortTermOperatingCashFlowCoverageRatio: s.shortTermOperatingCashFlowCoverageRatio ?? 0,
    operatingCashFlowCoverageRatio: s.operatingCashFlowCoverageRatio ?? 0,
    capitalExpenditureCoverageRatio: s.capitalExpenditureCoverageRatio ?? 0,
    dividendPaidAndCapexCoverageRatio: s.dividendPaidAndCapexCoverageRatio ?? 0,

    dividendPayoutRatio: s.dividendPayoutRatio ?? 0,
    dividendYield: s.dividendYield ?? 0,

    enterpriseValue: s.enterpriseValue ?? 0,

    revenuePerShare: s.revenuePerShare ?? 0,
    netIncomePerShare: s.netIncomePerShare ?? 0,
    interestDebtPerShare: s.interestDebtPerShare ?? 0,
    cashPerShare: s.cashPerShare ?? 0,
    bookValuePerShare: s.bookValuePerShare ?? 0,
    tangibleBookValuePerShare: s.tangibleBookValuePerShare ?? 0,
    shareholdersEquityPerShare: s.shareholdersEquityPerShare ?? 0,
    operatingCashFlowPerShare: s.operatingCashFlowPerShare ?? 0,
    capexPerShare: s.capexPerShare ?? 0,
    freeCashFlowPerShare: s.freeCashFlowPerShare ?? 0,

    netIncomePerEBT: s.netIncomePerEBT ?? 0,
    ebtPerEbit: s.ebtPerEbit ?? 0,

    debtToMarketCap: s.debtToMarketCap ?? 0,
    effectiveTaxRate: s.effectiveTaxRate ?? 0,

    enterpriseValueMultiple: s.enterpriseValueMultiple ?? 0,
  }));
}

// ─── Aggregate Fetcher ───

export async function fetchAllFinancials(ticker: string): Promise<FmpFinancialData> {
  logger.info("fmp", `Fetching all financials for ${ticker} (trailing 8Q)`);

  const [profile, incomeStatements, balanceSheets, cashFlowStatements, ttmFinRatios] =
    await Promise.all([
      fetchCompanyProfile(ticker),
      fetchIncomeStatements(ticker, 8),
      fetchBalanceSheets(ticker, 8),
      fetchCashFlowStatements(ticker, 8),
      fetchFinRatios(ticker, 8),
    ]);

  logger.info(
    "fmp",
    `${ticker} data: profile=${profile ? "yes" : "no"}, ` +
      `income=${incomeStatements.length}Q, balance=${balanceSheets.length}Q, ` +
      `cashflow=${cashFlowStatements.length}Q, ratiosTTM=${ttmFinRatios.length}Q`
  );

  return { profile, incomeStatements, balanceSheets, cashFlowStatements, ttmFinRatios };
}

// ─── Data Formatting for LLM Consumption ───

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function ratio(n: number): string {
  return n.toFixed(2);
}

export function formatFinancialsForLLM(data: FmpFinancialData): string {
  const sections: string[] = [];

  // Profile
  if (data.profile) {
    const p = data.profile;
    sections.push(
      `═══ COMPANY PROFILE ═══\n` +
        `${p.companyName} (${p.symbol}) | ${p.sector} > ${p.industry}\n` +
        `Exchange: ${p.exchange} | Country: ${p.country} | IPO: ${p.ipoDate}\n` +
        `Market Cap: ${fmtNum(p.mktCap)}`
    );
  }

  // Income Statements (chronological — oldest first)
  if (data.incomeStatements.length > 0) {
    const sorted = [...data.incomeStatements].reverse();
    const lines = sorted.map((s) => {
      const qLabel = `${s.date} (${s.period})`;
      return (
        `  ${qLabel}:\n` +
        `    Revenue: ${fmtNum(s.revenue)} | Gross Profit: ${fmtNum(s.grossProfit)} (${pct(s.grossProfitRatio)})\n` +
        `    Operating Income: ${fmtNum(s.operatingIncome)} (${pct(s.operatingIncomeRatio)})\n` +
        `    Net Income: ${fmtNum(s.netIncome)} (${pct(s.netIncomeRatio)})\n` +
        `    SGA: ${fmtNum(s.sellingGeneralAndAdministrativeExpenses)} | R&D: ${fmtNum(s.researchAndDevelopmentExpenses)}\n` +
        `    Interest Expense: ${fmtNum(s.interestExpense)} | EPS: $${s.epsdiluted.toFixed(2)}`
      );
    });
    sections.push(
      `═══ INCOME STATEMENT (Trailing ${sorted.length}Q) ═══\n${lines.join("\n\n")}`
    );
  }

  // Balance Sheets
  if (data.balanceSheets.length > 0) {
    const sorted = [...data.balanceSheets].reverse();
    const lines = sorted.map((s) => {
      const qLabel = `${s.date} (${s.period})`;
      return (
        `  ${qLabel}:\n` +
        `    Cash & ST Investments: ${fmtNum(s.cashAndShortTermInvestments)}\n` +
        `    Total Current Assets: ${fmtNum(s.totalCurrentAssets)} | Total Current Liabilities: ${fmtNum(s.totalCurrentLiabilities)}\n` +
        `    Total Assets: ${fmtNum(s.totalAssets)} | Total Liabilities: ${fmtNum(s.totalLiabilities)}\n` +
        `    Total Equity: ${fmtNum(s.totalStockholdersEquity)} | Total Debt: ${fmtNum(s.totalDebt)}\n` +
        `    Receivables: ${fmtNum(s.netReceivables)} | Inventory: ${fmtNum(s.inventory)} | Payables: ${fmtNum(s.accountPayables)}\n` +
        `    Goodwill & Intangibles: ${fmtNum(s.goodwillAndIntangibleAssets)} | PP&E: ${fmtNum(s.propertyPlantEquipmentNet)}`
      );
    });
    sections.push(
      `═══ BALANCE SHEET (Trailing ${sorted.length}Q) ═══\n${lines.join("\n\n")}`
    );
  }

  // Cash Flow Statements
  if (data.cashFlowStatements.length > 0) {
    const sorted = [...data.cashFlowStatements].reverse();
    const lines = sorted.map((s) => {
      const qLabel = `${s.date} (${s.period})`;
      const totalReturn = Math.abs(s.dividendsPaid) + Math.abs(s.commonStockRepurchased);
      return (
        `  ${qLabel}:\n` +
        `    Operating Cash Flow: ${fmtNum(s.operatingCashFlow)}\n` +
        `    Capex: ${fmtNum(s.capitalExpenditure)} | Free Cash Flow: ${fmtNum(s.freeCashFlow)}\n` +
        `    D&A: ${fmtNum(s.depreciationAndAmortization)} | SBC: ${fmtNum(s.stockBasedCompensation)}\n` +
        `    Dividends Paid: ${fmtNum(Math.abs(s.dividendsPaid))} | Buybacks: ${fmtNum(Math.abs(s.commonStockRepurchased))}\n` +
        `    Total Shareholder Return: ${fmtNum(totalReturn)} | Debt Repayment: ${fmtNum(Math.abs(s.debtRepayment))}`
      );
    });
    sections.push(
      `═══ CASH FLOW STATEMENT (Trailing ${sorted.length}Q) ═══\n${lines.join("\n\n")}`
    );
  }

  // TTM Financial Ratios / Valuation
  if (data.ttmFinRatios.length > 0) {
    const sorted = [...data.ttmFinRatios].reverse();
    const lines = sorted.map((s) => {
      // `/ratios-ttm` objects usually don't have date/period; keep label robust.
      const label = (s as any).date && (s as any).period
        ? `${(s as any).date} (${(s as any).period})`
        : `${s.symbol} (TTM)`;

      return (
        `  ${label}:\n` +
        `    Profitability: Gross ${pct(s.grossProfitMargin)} | EBIT ${pct(s.ebitMargin)} | EBITDA ${pct(s.ebitdaMargin)} | Net ${pct(s.netProfitMargin)}\n` +
        `    Valuation: P/E ${ratio(s.priceToEarningsRatio)} | P/B ${ratio(s.priceToBookRatio)} | PEG ${ratio(s.priceToEarningsGrowthRatio)} | P/S ${ratio(s.priceToSalesRatio)}\n` +
        `    Cash Flow Valuation: P/FCF ${ratio(s.priceToFreeCashFlowRatio)} | P/OCF ${ratio(s.priceToOperatingCashFlowRatio)} | EV Multiple ${ratio(s.enterpriseValueMultiple)}\n` +
        `    Liquidity: Current ${ratio(s.currentRatio)} | Quick ${ratio(s.quickRatio)} | Cash ${ratio(s.cashRatio)}\n` +
        `    Leverage: D/E ${ratio(s.debtToEquityRatio)} | D/A ${ratio(s.debtToAssetsRatio)} | Leverage ${ratio(s.financialLeverageRatio)}\n` +
        `    Per Share: Rev/Share $${s.revenuePerShare.toFixed(2)} | NI/Share $${s.netIncomePerShare.toFixed(2)} | FCF/Share $${s.freeCashFlowPerShare.toFixed(2)} | BV/Share $${s.bookValuePerShare.toFixed(2)}\n` +
        `    Dividend: Yield ${pct(s.dividendYield)} | Payout ${pct(s.dividendPayoutRatio)} | EV ${fmtNum(s.enterpriseValue)}`
      );
    });

    sections.push(
      `═══ TTM FINANCIAL RATIOS & VALUATION (Trailing ${sorted.length}Q) ═══\n${lines.join("\n\n")}`
    );
  }

  return sections.join("\n\n");
}


// ==========================
// YoY Growth Helpers + Types
// ==========================

type Quarter = 1 | 2 | 3 | 4;

function yoy(curr: number, prev: number): number {
  if (!isFinite(curr) || !isFinite(prev) || prev === 0) return 0;
  return (curr - prev) / Math.abs(prev);
}

// Convert an ISO date to quarter number based on month.
function quarterFromDate(dateISO: string): Quarter {
  const month = Number(dateISO.slice(5, 7)); // "MM"
  if (month <= 3) return 1;
  if (month <= 6) return 2;
  if (month <= 9) return 3;
  return 4;
}

// Build a stable quarter key: "YYYY-Q#"
// We *prefer* using the `period` (Q1..Q4) if present; otherwise derive from the month.
function quarterKey(row: { date: string; period?: string }): string {
  const year = row.date.slice(0, 4);
  const p = row.period?.toUpperCase?.() ?? "";

  let q: Quarter;
  if (p === "Q1") q = 1;
  else if (p === "Q2") q = 2;
  else if (p === "Q3") q = 3;
  else if (p === "Q4") q = 4;
  else q = quarterFromDate(row.date);

  return `${year}-Q${q}`;
}

function buildQuarterMap<T extends { date: string; period?: string }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) m.set(quarterKey(r), r);
  return m;
}

function priorYearQuarterKey(key: string): string {
  // "2025-Q4" -> "2024-Q4"
  const [y, q] = key.split("-");
  return `${Number(y) - 1}-${q}`;
}

function findSameQuarterLastYearByKey<T extends { date: string; period?: string }>(
  all: T[],
  row: T
): T | null {
  const m = buildQuarterMap(all);
  const key = quarterKey(row);
  return m.get(priorYearQuarterKey(key)) ?? null;
}

// ===============
// Income Statement
// ===============

export type FmpIncomeStatementYoY = {
  date: string;
  period: string;

  revenueYoY: number;
  grossProfitYoY: number;
  operatingIncomeYoY: number;
  netIncomeYoY: number;
  epsYoY: number;

  costOfRevenueYoY: number;
  operatingExpensesYoY: number;
  sgaYoY: number;
  rndYoY: number;
};

export async function fetchIncomeStatementsYoY(
  ticker: string,
  limitYoYQuarters: number = 8
): Promise<FmpIncomeStatementYoY[]> {
  const limitFetch = Math.max(12, limitYoYQuarters + 4);

  const statements = await fetchIncomeStatements(ticker, limitFetch);

  // Ensure newest-first (your API typically returns newest-first; this keeps it robust).
  const sorted = [...statements].sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted.slice(0, limitYoYQuarters);

  return latest.map((s) => {
    const prev = findSameQuarterLastYearByKey(sorted, s);

    return {
      date: s.date,
      period: s.period,

      revenueYoY: prev ? yoy(s.revenue, prev.revenue) : 0,
      grossProfitYoY: prev ? yoy(s.grossProfit, prev.grossProfit) : 0,
      operatingIncomeYoY: prev ? yoy(s.operatingIncome, prev.operatingIncome) : 0,
      netIncomeYoY: prev ? yoy(s.netIncome, prev.netIncome) : 0,
      epsYoY: prev ? yoy(s.eps, prev.eps) : 0,

      costOfRevenueYoY: prev ? yoy(s.costOfRevenue, prev.costOfRevenue) : 0,
      operatingExpensesYoY: prev ? yoy(s.operatingExpenses, prev.operatingExpenses) : 0,
      sgaYoY: prev
        ? yoy(
            s.sellingGeneralAndAdministrativeExpenses,
            prev.sellingGeneralAndAdministrativeExpenses
          )
        : 0,
      rndYoY: prev ? yoy(s.researchAndDevelopmentExpenses, prev.researchAndDevelopmentExpenses) : 0,
    };
  });
}

// ==============
// Balance Sheet
// ==============

export type FmpBalanceSheetYoY = {
  date: string;
  period: string;

  totalAssetsYoY: number;
  totalLiabilitiesYoY: number;
  totalEquityYoY: number;

  cashAndShortTermInvestmentsYoY: number;
  totalDebtYoY: number;
  netDebtYoY: number;

  totalCurrentAssetsYoY: number;
  totalCurrentLiabilitiesYoY: number;
};

export async function fetchBalanceSheetsYoY(
  ticker: string,
  limitYoYQuarters: number = 8
): Promise<FmpBalanceSheetYoY[]> {
  const limitFetch = Math.max(12, limitYoYQuarters + 4);

  const sheets = await fetchBalanceSheets(ticker, limitFetch);

  const sorted = [...sheets].sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted.slice(0, limitYoYQuarters);

  return latest.map((s) => {
    const prev = findSameQuarterLastYearByKey(sorted, s);

    return {
      date: s.date,
      period: s.period,

      totalAssetsYoY: prev ? yoy(s.totalAssets, prev.totalAssets) : 0,
      totalLiabilitiesYoY: prev ? yoy(s.totalLiabilities, prev.totalLiabilities) : 0,
      totalEquityYoY: prev ? yoy(s.totalStockholdersEquity, prev.totalStockholdersEquity) : 0,

      cashAndShortTermInvestmentsYoY: prev
        ? yoy(s.cashAndShortTermInvestments, prev.cashAndShortTermInvestments)
        : 0,

      totalDebtYoY: prev ? yoy(s.totalDebt, prev.totalDebt) : 0,
      netDebtYoY: prev ? yoy(s.netDebt, prev.netDebt) : 0,

      totalCurrentAssetsYoY: prev ? yoy(s.totalCurrentAssets, prev.totalCurrentAssets) : 0,
      totalCurrentLiabilitiesYoY: prev
        ? yoy(s.totalCurrentLiabilities, prev.totalCurrentLiabilities)
        : 0,
    };
  });
}

// =================
// Cash Flow Statement
// =================

export type FmpCashFlowStatementYoY = {
  date: string;
  period: string;

  operatingCashFlowYoY: number;
  freeCashFlowYoY: number;
  capexYoY: number;
  netIncomeYoY: number;

  dividendsPaidYoY: number;
  buybacksYoY: number;

  depreciationAndAmortizationYoY: number;
  stockBasedCompensationYoY: number;
};

export async function fetchCashFlowStatementsYoY(
  ticker: string,
  limitYoYQuarters: number = 8
): Promise<FmpCashFlowStatementYoY[]> {
  const limitFetch = Math.max(12, limitYoYQuarters + 4);

  const flows = await fetchCashFlowStatements(ticker, limitFetch);

  const sorted = [...flows].sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted.slice(0, limitYoYQuarters);

  return latest.map((s) => {
    const prev = findSameQuarterLastYearByKey(sorted, s);

    return {
      date: s.date,
      period: s.period,

      operatingCashFlowYoY: prev ? yoy(s.operatingCashFlow, prev.operatingCashFlow) : 0,
      freeCashFlowYoY: prev ? yoy(s.freeCashFlow, prev.freeCashFlow) : 0,
      capexYoY: prev ? yoy(s.capitalExpenditure, prev.capitalExpenditure) : 0,
      netIncomeYoY: prev ? yoy(s.netIncome, prev.netIncome) : 0,

      dividendsPaidYoY: prev ? yoy(s.dividendsPaid, prev.dividendsPaid) : 0,
      buybacksYoY: prev ? yoy(s.commonStockRepurchased, prev.commonStockRepurchased) : 0,

      depreciationAndAmortizationYoY: prev
        ? yoy(s.depreciationAndAmortization, prev.depreciationAndAmortization)
        : 0,
      stockBasedCompensationYoY: prev
        ? yoy(s.stockBasedCompensation, prev.stockBasedCompensation)
        : 0,
    };
  });
}
