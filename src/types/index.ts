// ─── Perplexity (News Layer) ───
export interface NewsItem {
  summary: string;
  citations: string[];
  query: string;
}

// ─── Polymarket (Prediction Market Layer) ───
export interface PolymarketPrediction {
  option: string;
  percentage: number;
  volume: number;
  citation?: string;
}

export interface PolymarketOptionDetail {
  [key: string]: string | number | boolean | null;
}

export interface PolymarketMarket {
  title: string;
  url: string;
  totalVolume: number;
  pollEndDate: string;
  predictions: PolymarketPrediction[];
  optionDetails?: PolymarketOptionDetail[];
  daysUntilClose: number;
  relevanceScore: number;
}

export interface PolymarketResult {
  markets: PolymarketMarket[];
  searchTopic: string;
}

// ─── Manus (Public Sentiment Layer) ───
export interface SentimentResult {
  summary: string;
  taskUrl?: string;
}

// ─── FRED (Macro Data Layer) ───
export interface FredObservation {
  date: string;
  value: number;
}

export interface FredSeries {
  id: string;
  title: string;
  units: string;
  frequency: string;
  observations: FredObservation[];
}

export interface FredChartResult {
  buffer: Buffer;
  title: string;
  seriesId: string;
}

// ─── Core Concepts (LLM extraction) ───
export interface CoreConcept {
  name: string;
  trigger: string;
  affectedMarkets: string;
  searchTerms: string[];
  polymarketTopics?: string[];
  fredSeriesIds?: string[];
}

// ─── Synthesis ───
export interface SynthesisInput {
  topic: string;
  label?: string;
  news: NewsItem[];
  polymarkets: PolymarketResult[];
  sentiment: SentimentResult | null;
  conceptSentiments?: Record<string, SentimentResult | null>;
  charts?: FredChartResult[];
}

export interface SynthesisOutput {
  topic: string;
  label?: string;
  body: string;
  citations: string[];
  timestamp: Date;
  charts?: FredChartResult[];
}

// ─── Workflow Progress ───
//
// Single editable Telegram message with a visual progress bar.
// Edited in-place at each step. Deleted when workflow completes.
export interface WorkflowProgress {
  totalSteps: number;
  update: (step: number, description: string) => Promise<void>;
  done: () => Promise<void>;
}

// ─── FMP Financial Data ───
export interface FmpIncomeStatement {
  date: string;
  period: string;
  revenue: number;
  costOfRevenue: number;
  grossProfit: number;
  grossProfitRatio: number;
  operatingExpenses: number;
  sellingGeneralAndAdministrativeExpenses: number;
  researchAndDevelopmentExpenses: number;
  operatingIncome: number;
  operatingIncomeRatio: number;
  interestExpense: number;
  incomeBeforeTax: number;
  netIncome: number;
  netIncomeRatio: number;
  eps: number;
  epsdiluted: number;
  weightedAverageShsOut: number;
  weightedAverageShsOutDil: number;
}

export interface FmpBalanceSheet {
  date: string;
  period: string;
  cashAndCashEquivalents: number;
  shortTermInvestments: number;
  cashAndShortTermInvestments: number;
  netReceivables: number;
  inventory: number;
  totalCurrentAssets: number;
  totalCurrentLiabilities: number;
  totalAssets: number;
  totalLiabilities: number;
  totalStockholdersEquity: number;
  totalDebt: number;
  netDebt: number;
  goodwill: number;
  intangibleAssets: number;
  goodwillAndIntangibleAssets: number;
  accountPayables: number;
  longTermDebt: number;
  shortTermDebt: number;
  propertyPlantEquipmentNet: number;
}

export interface FmpCashFlowStatement {
  date: string;
  period: string;
  netIncome: number;
  operatingCashFlow: number;
  capitalExpenditure: number;
  freeCashFlow: number;
  dividendsPaid: number;
  commonStockRepurchased: number;
  debtRepayment: number;
  depreciationAndAmortization: number;
  stockBasedCompensation: number;
  changeInWorkingCapital: number;
  accountsReceivables: number;
  accountsPayables: number;
  inventory: number;
}

export interface FmpFinRatios {
  symbol: string;
  date: string;
  fiscalYear: string;
  period: string;
  grossProfitMargin: number;
  ebitMargin: number;
  ebitdaMargin: number;
  operatingProfitMargin: number;
  pretaxProfitMargin: number;
  continuousOperationsProfitMargin: number;
  netProfitMargin: number;
  bottomLineProfitMargin: number;
  receivablesTurnover: number;
  payablesTurnover: number;
  inventoryTurnover: number;
  fixedAssetTurnover: number;
  assetTurnover: number;
  currentRatio: number;
  quickRatio: number;
  solvencyRatio: number;
  cashRatio: number;
  priceToEarningsRatio: number;
  priceToEarningsGrowthRatio: number;
  forwardPriceToEarningsGrowthRatio: number;
  priceToBookRatio: number;
  priceToSalesRatio: number;
  priceToFreeCashFlowRatio: number;
  priceToOperatingCashFlowRatio: number;
  priceToFairValue: number;
  debtToAssetsRatio: number;
  debtToEquityRatio: number;
  debtToCapitalRatio: number;
  longTermDebtToCapitalRatio: number;
  financialLeverageRatio: number;
  workingCapitalTurnoverRatio: number;
  operatingCashFlowRatio: number;
  operatingCashFlowSalesRatio: number;
  freeCashFlowOperatingCashFlowRatio: number;
  debtServiceCoverageRatio: number;
  interestCoverageRatio: number;
  shortTermOperatingCashFlowCoverageRatio: number;
  operatingCashFlowCoverageRatio: number;
  capitalExpenditureCoverageRatio: number;
  dividendPaidAndCapexCoverageRatio: number;
  dividendPayoutRatio: number;
  dividendYield: number;
  enterpriseValue: number;
  revenuePerShare: number;
  netIncomePerShare: number;
  interestDebtPerShare: number;
  cashPerShare: number;
  bookValuePerShare: number;
  tangibleBookValuePerShare: number;
  shareholdersEquityPerShare: number;
  operatingCashFlowPerShare: number;
  capexPerShare: number;
  freeCashFlowPerShare: number;
  netIncomePerEBT: number;
  ebtPerEbit: number;
  debtToMarketCap: number;
  effectiveTaxRate: number;
  enterpriseValueMultiple: number;
}

export interface FmpCompanyProfile {
  symbol: string;
  companyName: string;
  sector: string;
  industry: string;
  mktCap: number;
  description: string;
  exchange: string;
  country: string;
  ipoDate: string;
}

export interface FmpFinancialData {
  profile: FmpCompanyProfile | null;
  incomeStatements: FmpIncomeStatement[];
  balanceSheets: FmpBalanceSheet[];
  cashFlowStatements: FmpCashFlowStatement[];
  ttmFinRatios: FmpFinRatios[];
}

export interface EquityEvalResult {
  ticker: string;
  companyName: string;
  evaluation: string;
  charts: FredChartResult[];
  financialData: FmpFinancialData;
  timestamp: Date;
}

// ─── OpenRouter Model Routing ───
export type ModelTier = "fast" | "full" | "reasoning";
