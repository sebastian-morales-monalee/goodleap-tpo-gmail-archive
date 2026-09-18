/**
 * GoodLeap TPO - AI primary-category dashboard
 *
 * This file belongs in the SAME Apps Script project as OpenAIAnalysis.gs. It
 * reads "AI Analysis", maintains the complete weekly history in
 * "AI Weekly Summary", and shows one all-time Primary Category chart, one
 * stacked weekly Production-versus-other trend based on Categories, two
 * stacked weekly project-production status charts (created and updated), plus
 * up to eight optional recent Primary Category charts in "AI Dashboard". It
 * does not call OpenAI, Gmail, Drive, or PostHog.
 *
 * Safe first-run sequence:
 *   1) setupProjectIdSummary()
 *   2) previewAIAnalysisDashboard()
 *   3) setupAIAnalysisDashboard()
 *
 * OpenAIAnalysis.gs calls refreshAIAnalysisDashboardSafely_() after each
 * automatic analysis check. The existing five-minute trigger is sufficient.
 */

const AI_ANALYSIS_DASHBOARD_CONFIG = {
  SHEET_NAME: 'AI Dashboard',
  WEEKLY_SHEET_NAME: 'AI Weekly Summary',
  SOURCE_SHEET_NAME: 'AI Analysis',
  PRIMARY_CATEGORY_HEADER: 'Primary Category',
  CATEGORIES_HEADER: 'Categories',
  EMAIL_RECEIVED_AT_HEADER: 'Email Received At',
  TABLE_HEADERS: ['Primary Category', 'Count', 'Percentage'],
  WEEKLY_HEADERS: [
    'Week Start',
    'Week End',
    'Primary Category',
    'Count',
    'Percentage',
    'Week Total',
  ],
  CATEGORY_ORDER: [
    'Production',
    'Layout',
    'Equipment',
    'Shading / Site Conditions',
    'Structure',
    'Documentation',
    'Offset',
    'Communication / Follow-up',
    'Other',
  ],
  CATEGORY_COLORS: {
    Production: '#4285f4',
    Layout: '#fb8c00',
    Equipment: '#34a853',
    'Shading / Site Conditions': '#fbbc04',
    Structure: '#8e24aa',
    Documentation: '#00acc1',
    Offset: '#ea4335',
    'Communication / Follow-up': '#5c6bc0',
    Other: '#9aa0a6',
  },
  FALLBACK_CATEGORY_COLORS: [
    '#00897b',
    '#d81b60',
    '#7cb342',
    '#6d4c41',
    '#3949ab',
    '#f4511e',
  ],
  WEEKLY_MATRIX_TITLE: 'Weekly Category Matrix',
  WEEKLY_MATRIX_START_COLUMN: 8,
  WEEKLY_CHART_MATRIX_TITLE: 'Weekly Production vs Other Categories',
  PRODUCTION_PROJECTS_MATRIX_TITLE: 'Weekly Production Projects',
  UPDATED_PRODUCTION_PROJECTS_MATRIX_TITLE:
    'Weekly Production Updated Projects',
  PROJECT_SUMMARY_SHEET_NAME: 'Project ID Summary',
  PROJECT_ID_HEADER: 'Project ID',
  PROJECT_CREATED_AT_HEADER: 'Created At',
  PROJECT_UPDATED_AT_HEADER: 'Updated At',
  PROJECT_TOLERANCE_HEADER: 'Is tolerance into the range [-5%, +15%]',
  PROJECT_INSIDE_RANGE_LABEL: 'Production Inside the Range',
  PROJECT_OUTSIDE_RANGE_LABEL: 'Production Outside the Range',
  PROJECT_WITHOUT_DATA_LABEL: 'Without Production Data',
  PROJECT_INSIDE_RANGE_COLOR: '#b7e1cd',
  PROJECT_OUTSIDE_RANGE_COLOR: '#f4cccc',
  PROJECT_WITHOUT_DATA_COLOR: '#9aa0a6',
  PRODUCTION_CATEGORY: 'Production',
  PRODUCTION_SERIES_LABEL: 'Production with other categories',
  OTHER_CATEGORIES_LABEL: 'Other Categories without Production',
  PRODUCTION_DATA_LABEL_COLOR: '#00ffff',
  TITLE: 'AI Analysis - Primary Category Dashboard',
  TIME_ZONE: 'America/Bogota',
  SHOW_WEEKLY_PRIMARY_CATEGORY_DETAILS: false,
  WEEKLY_CHART_LIMIT: 8,
  CATEGORY_SLOT_ROWS: 20,
  WEEKLY_FIRST_ROW: 32,
  WEEKLY_BLOCK_HEIGHT: 28,
  CHART_COLUMN: 5,
  STACKED_CHART_COLUMN: 15,
  PRODUCTION_PROJECTS_CHART_COLUMN: 25,
  UPDATED_PRODUCTION_PROJECTS_CHART_COLUMN: 35,
  LAYOUT_NOTE:
    'Managed AI Dashboard layout v10: optional weekly Primary Category details plus labeled email, created-project, and updated-project Production trends.',
  HEADER_COLOR: '#6e04bd',
  HEADER_TEXT_COLOR: '#ffffff',
  CHART_COLOR: '#4285f4',
};

/**
 * Creates or rebuilds AI Weekly Summary and AI Dashboard from all existing
 * AI Analysis rows. This function is idempotent and does not call OpenAI.
 */
function setupAIAnalysisDashboard() {
  const resources = getOrCreateResources_();
  const summary = loadAIAnalysisDashboardSummary_(resources.spreadsheet);
  const weeklyStats = writeAIWeeklySummary_(
    resources.spreadsheet,
    summary,
    true,
  );
  const dashboardStats = writeAIAnalysisDashboard_(
    resources.spreadsheet,
    summary,
    true,
  );
  const stats = buildAIAnalysisDashboardStats_(
    summary,
    weeklyStats,
    dashboardStats,
  );

  console.log('AI Analysis dashboard setup completed.');
  console.log(`Spreadsheet: ${resources.spreadsheet.getUrl()}`);
  console.log(`Weekly history sheet: ${AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_SHEET_NAME}`);
  console.log(`Dashboard sheet: ${AI_ANALYSIS_DASHBOARD_CONFIG.SHEET_NAME}`);
  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

/**
 * Logs the all-time and weekly category counts without modifying either
 * managed reporting sheet.
 */
function previewAIAnalysisDashboard() {
  const resources = getOrCreateResources_();
  const summary = loadAIAnalysisDashboardSummary_(resources.spreadsheet);

  summary.rows.forEach((row) => {
    console.log(
      `[ALL TIME] ${row.category} | ${row.count} | ` +
      `${(row.percentage * 100).toFixed(2)}%`,
    );
  });
  getVisibleAIAnalysisDashboardWeeks_(summary).forEach((week) => {
    console.log(
      `[WEEK] ${week.start} to ${week.end} | ` +
      `categorized=${week.totalCount} | categories=${week.rows.length}`,
    );
    week.rows.forEach((row) => {
      console.log(
        `[WEEK CATEGORY] ${week.start} | ${row.category} | ` +
        `${row.count} | ${(row.percentage * 100).toFixed(2)}%`,
      );
    });
  });
  summary.productionProjects.weeks.forEach((week) => {
    console.log(
      `[WEEKLY PRODUCTION PROJECTS] ${week.start} to ${week.end} | ` +
      `inside=${week.insideRangeCount} | ` +
      `outside=${week.outsideRangeCount} | ` +
      `withoutData=${week.withoutProductionDataCount} | ` +
      `total=${week.totalCount}`,
    );
  });
  summary.updatedProductionProjects.weeks.forEach((week) => {
    console.log(
      `[WEEKLY UPDATED PRODUCTION PROJECTS] ${week.start} to ${week.end} | ` +
      `inside=${week.insideRangeCount} | ` +
      `outside=${week.outsideRangeCount} | ` +
      `withoutData=${week.withoutProductionDataCount} | ` +
      `total=${week.totalCount}`,
    );
  });

  const stats = buildAIAnalysisDashboardStats_(summary, null, null);
  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

/**
 * Refreshes both managed reporting sheets only when their source data differs
 * from AI Analysis. It is safe to run manually at any time.
 */
function refreshAIAnalysisDashboard() {
  const resources = getOrCreateResources_();
  const summary = loadAIAnalysisDashboardSummary_(resources.spreadsheet);
  const weeklyStats = writeAIWeeklySummary_(
    resources.spreadsheet,
    summary,
    false,
  );
  const dashboardStats = writeAIAnalysisDashboard_(
    resources.spreadsheet,
    summary,
    false,
  );
  const stats = buildAIAnalysisDashboardStats_(
    summary,
    weeklyStats,
    dashboardStats,
  );

  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

/**
 * Prevents dashboard formatting failures from interrupting email analysis.
 */
function refreshAIAnalysisDashboardSafely_() {
  try {
    return refreshAIAnalysisDashboard();
  } catch (error) {
    console.error(`AI Dashboard refresh failed safely: ${error}`);
    return {
      updated: false,
      skippedSafely: true,
      error: String(error).slice(0, 1000),
    };
  }
}

function loadAIAnalysisDashboardSummary_(spreadsheet) {
  const sourceSheet = spreadsheet.getSheetByName(
    AI_ANALYSIS_DASHBOARD_CONFIG.SOURCE_SHEET_NAME,
  );
  if (!sourceSheet || sourceSheet.getLastRow() === 0) {
    throw new Error(
      'AI Analysis is missing or empty. Run setupOpenAIEmailAnalysis() first.',
    );
  }

  const values = sourceSheet
    .getRange(
      1,
      1,
      sourceSheet.getLastRow(),
      sourceSheet.getLastColumn(),
    )
    .getValues();
  const headers = values[0].map((value) => String(value).trim());
  const categoryIndex = headers.indexOf(
    AI_ANALYSIS_DASHBOARD_CONFIG.PRIMARY_CATEGORY_HEADER,
  );
  const categoriesIndex = headers.indexOf(
    AI_ANALYSIS_DASHBOARD_CONFIG.CATEGORIES_HEADER,
  );
  const receivedAtIndex = headers.indexOf(
    AI_ANALYSIS_DASHBOARD_CONFIG.EMAIL_RECEIVED_AT_HEADER,
  );
  if (categoryIndex < 0) {
    throw new Error(
      'AI Analysis does not contain the required Primary Category header.',
    );
  }
  if (categoriesIndex < 0) {
    throw new Error(
      'AI Analysis does not contain the required Categories header.',
    );
  }
  if (receivedAtIndex < 0) {
    throw new Error(
      'AI Analysis does not contain the required Email Received At header.',
    );
  }

  const allTimeCounts = new Map();
  const weeklyCounts = new Map();
  let categorizedRows = 0;
  let uncategorizedRows = 0;
  let excludedFromWeeklyCount = 0;

  values.slice(1).forEach((row) => {
    const category = String(row[categoryIndex] || '').trim();
    if (!category) {
      uncategorizedRows += 1;
      return;
    }

    categorizedRows += 1;
    incrementAIAnalysisCategoryCount_(allTimeCounts, category);

    const receivedAt = normalizeAIAnalysisDashboardDate_(
      row[receivedAtIndex],
    );
    if (!receivedAt) {
      excludedFromWeeklyCount += 1;
      return;
    }

    const bounds = getAIAnalysisWeekBounds_(receivedAt);
    if (!weeklyCounts.has(bounds.start)) {
      weeklyCounts.set(bounds.start, {
        start: bounds.start,
        end: bounds.end,
        counts: new Map(),
        productionCount: 0,
        otherCategoriesCount: 0,
      });
    }
    const weeklyEntry = weeklyCounts.get(bounds.start);
    incrementAIAnalysisCategoryCount_(
      weeklyEntry.counts,
      category,
    );
    if (doesAIAnalysisCategoriesIncludeProduction_(row[categoriesIndex])) {
      weeklyEntry.productionCount += 1;
    } else {
      weeklyEntry.otherCategoriesCount += 1;
    }
  });

  const rows = buildAIAnalysisCategoryRows_(allTimeCounts);
  const weeks = Array.from(weeklyCounts.values())
    .map((week) => ({
      start: week.start,
      end: week.end,
      totalCount: sumAIAnalysisCategoryCounts_(week.counts),
      rows: buildAIAnalysisCategoryRows_(week.counts),
      productionCount: week.productionCount,
      otherCategoriesCount: week.otherCategoriesCount,
    }))
    .sort((left, right) => right.start.localeCompare(left.start));
  const productionProjects = loadAIWeeklyProductionProjects_(
    spreadsheet,
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_CREATED_AT_HEADER,
  );
  const updatedProductionProjects = loadAIWeeklyProductionProjects_(
    spreadsheet,
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_UPDATED_AT_HEADER,
  );

  assertAIAnalysisDashboardCapacity_(rows, weeks);
  return {
    totalCount: categorizedRows,
    rows,
    weeks,
    uncategorizedRows,
    excludedFromWeeklyCount,
    productionProjects,
    updatedProductionProjects,
  };
}

function loadAIWeeklyProductionProjects_(spreadsheet, dateHeader) {
  const sheet = spreadsheet.getSheetByName(
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_SUMMARY_SHEET_NAME,
  );
  if (!sheet || sheet.getLastRow() === 0) {
    throw new Error(
      'Project ID Summary is missing or empty. Run setupProjectIdSummary() ' +
      'before setupAIAnalysisDashboard().',
    );
  }

  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getValues();
  const headers = values[0].map((value) => String(value).trim());
  const projectIdIndex = requireAIAnalysisDashboardHeader_(
    headers,
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_ID_HEADER,
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_SUMMARY_SHEET_NAME,
  );
  const dateIndex = requireAIAnalysisDashboardHeader_(
    headers,
    dateHeader,
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_SUMMARY_SHEET_NAME,
  );
  const toleranceIndex = requireAIAnalysisDashboardHeader_(
    headers,
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_TOLERANCE_HEADER,
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_SUMMARY_SHEET_NAME,
  );
  const weeklyCounts = new Map();
  const seenProjectIds = new Set();
  let totalProjects = 0;
  let projectsWithoutDate = 0;
  let duplicateProjectRows = 0;

  values.slice(1).forEach((row) => {
    const projectId = String(row[projectIdIndex] || '').trim().toLowerCase();
    if (!projectId) return;
    if (seenProjectIds.has(projectId)) {
      duplicateProjectRows += 1;
      return;
    }
    seenProjectIds.add(projectId);
    totalProjects += 1;

    const projectDate = normalizeAIAnalysisDashboardDate_(row[dateIndex]);
    if (!projectDate) {
      projectsWithoutDate += 1;
      return;
    }
    const bounds = getAIAnalysisWeekBounds_(projectDate);
    if (!weeklyCounts.has(bounds.start)) {
      weeklyCounts.set(bounds.start, {
        start: bounds.start,
        end: bounds.end,
        insideRangeCount: 0,
        outsideRangeCount: 0,
        withoutProductionDataCount: 0,
      });
    }
    const weeklyEntry = weeklyCounts.get(bounds.start);
    const status = classifyAIWeeklyProductionProject_(row[toleranceIndex]);
    if (status === 'inside') {
      weeklyEntry.insideRangeCount += 1;
    } else if (status === 'outside') {
      weeklyEntry.outsideRangeCount += 1;
    } else {
      weeklyEntry.withoutProductionDataCount += 1;
    }
  });

  const weeks = Array.from(weeklyCounts.values())
    .map((week) => ({
      ...week,
      totalCount:
        week.insideRangeCount +
        week.outsideRangeCount +
        week.withoutProductionDataCount,
    }))
    .sort((left, right) => right.start.localeCompare(left.start));
  return {
    dateHeader,
    totalProjects,
    projectsWithDate: totalProjects - projectsWithoutDate,
    projectsWithoutDate,
    duplicateProjectRows,
    weeks,
  };
}

function classifyAIWeeklyProductionProject_(value) {
  if (value === true) return 'inside';
  if (value === false) return 'outside';
  const normalized = String(value == null ? '' : value)
    .trim()
    .toUpperCase();
  if (normalized === 'TRUE') return 'inside';
  if (normalized === 'FALSE') return 'outside';
  return 'withoutData';
}

function requireAIAnalysisDashboardHeader_(headers, header, sheetName) {
  const index = headers.indexOf(header);
  if (index < 0) {
    throw new Error(`${sheetName} is missing the required ${header} header.`);
  }
  return index;
}

function doesAIAnalysisCategoriesIncludeProduction_(value) {
  return String(value || '')
    .split(/[\r\n,;|]+/)
    .map((category) =>
      category
        .trim()
        .replace(/^[-*\u2022]\s*/, '')
        .replace(/^["'\[]+|["'\]]+$/g, '')
        .trim()
        .toLowerCase(),
    )
    .includes(
      AI_ANALYSIS_DASHBOARD_CONFIG.PRODUCTION_CATEGORY.toLowerCase(),
    );
}

function incrementAIAnalysisCategoryCount_(counts, category) {
  counts.set(category, Number(counts.get(category) || 0) + 1);
}

function sumAIAnalysisCategoryCounts_(counts) {
  return Array.from(counts.values()).reduce(
    (total, count) => total + count,
    0,
  );
}

function buildAIAnalysisCategoryRows_(counts) {
  const totalCount = sumAIAnalysisCategoryCounts_(counts);
  return Array.from(counts.entries())
    .map(([category, count]) => ({
      category,
      count,
      percentage: totalCount > 0 ? count / totalCount : 0,
    }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.category.localeCompare(right.category);
    });
}

function normalizeAIAnalysisDashboardDate_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime());
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 100000000000) {
      const timestampDate = new Date(value);
      return Number.isNaN(timestampDate.getTime()) ? null : timestampDate;
    }
    const sheetSerialDate = new Date((value - 25569) * 86400000);
    return Number.isNaN(sheetSerialDate.getTime()) ? null : sheetSerialDate;
  }

  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  const colombiaDateTime = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (colombiaDateTime) {
    const isoValue =
      `${colombiaDateTime[1]}-${colombiaDateTime[2]}-${colombiaDateTime[3]}` +
      `T${colombiaDateTime[4] || '00'}:${colombiaDateTime[5] || '00'}:` +
      `${colombiaDateTime[6] || '00'}-05:00`;
    const parsedColombiaDate = new Date(isoValue);
    if (!Number.isNaN(parsedColombiaDate.getTime())) {
      return parsedColombiaDate;
    }
  }

  const parsedDate = new Date(text);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function getAIAnalysisWeekBounds_(date) {
  const dateText = Utilities.formatDate(
    date,
    AI_ANALYSIS_DASHBOARD_CONFIG.TIME_ZONE,
    'yyyy-MM-dd',
  );
  const [year, month, day] = dateText.split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  const mondayOffset = (calendarDate.getUTCDay() + 6) % 7;
  const startDate = new Date(calendarDate.getTime());
  startDate.setUTCDate(startDate.getUTCDate() - mondayOffset);
  const endDate = new Date(startDate.getTime());
  endDate.setUTCDate(endDate.getUTCDate() + 6);

  return {
    start: Utilities.formatDate(startDate, 'UTC', 'yyyy-MM-dd'),
    end: Utilities.formatDate(endDate, 'UTC', 'yyyy-MM-dd'),
  };
}

function assertAIAnalysisDashboardCapacity_(allTimeRows, weeks) {
  const maximumRows = Math.max(
    allTimeRows.length,
    ...weeks.map((week) => week.rows.length),
    0,
  );
  if (maximumRows > AI_ANALYSIS_DASHBOARD_CONFIG.CATEGORY_SLOT_ROWS) {
    throw new Error(
      `The dashboard supports up to ` +
      `${AI_ANALYSIS_DASHBOARD_CONFIG.CATEGORY_SLOT_ROWS} categories per ` +
      `chart, but ${maximumRows} were found. Increase CATEGORY_SLOT_ROWS.`,
    );
  }
}

function buildAIWeeklySummaryOutput_(summary) {
  const output = [];
  summary.weeks.forEach((week) => {
    week.rows.forEach((row) => {
      output.push([
        week.start,
        week.end,
        row.category,
        row.count,
        row.percentage,
        week.totalCount,
      ]);
    });
  });
  return output;
}

function getAIWeeklyMatrixCategories_(summary) {
  const observedCategories = new Set(
    summary.rows.map((row) => row.category),
  );
  const configuredCategories =
    AI_ANALYSIS_DASHBOARD_CONFIG.CATEGORY_ORDER.slice();
  const configuredSet = new Set(configuredCategories);
  const additionalCategories = Array.from(observedCategories)
    .filter((category) => !configuredSet.has(category))
    .sort((left, right) => left.localeCompare(right));
  return configuredCategories.concat(additionalCategories);
}

function buildAIWeeklyMatrix_(summary) {
  const categories = getAIWeeklyMatrixCategories_(summary);
  const headers = ['Week'].concat(categories, ['Total']);
  const rows = summary.weeks
    .slice()
    .reverse()
    .map((week) => {
      const countsByCategory = new Map(
        week.rows.map((row) => [row.category, row.count]),
      );
      return [
        `${week.start} to ${week.end}`,
        ...categories.map(
          (category) => Number(countsByCategory.get(category) || 0),
        ),
        week.totalCount,
      ];
    });
  return {categories, headers, rows};
}

function buildAIWeeklyChartMatrix_(summary, matrix) {
  const rows = summary.weeks
    .slice()
    .reverse()
    .map((week) => {
      const production = Number(week.productionCount || 0);
      const otherCategories = Number(week.otherCategoriesCount || 0);
      const total = production + otherCategories;
      return [
        `${week.start} to ${week.end}`,
        production,
        otherCategories,
        total,
      ];
    });
  return {
    headers: [
      'Week',
      AI_ANALYSIS_DASHBOARD_CONFIG.PRODUCTION_SERIES_LABEL,
      AI_ANALYSIS_DASHBOARD_CONFIG.OTHER_CATEGORIES_LABEL,
      'Total',
    ],
    rows,
    startColumn:
      AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_MATRIX_START_COLUMN +
      matrix.headers.length +
      1,
  };
}

function buildAIWeeklyProductionProjectsMatrix_(summary, chartMatrix) {
  return buildAIWeeklyProjectStatusMatrix_(
    summary.productionProjects,
    chartMatrix.startColumn + chartMatrix.headers.length + 1,
  );
}

function buildAIWeeklyUpdatedProductionProjectsMatrix_(
  summary,
  productionProjectsMatrix,
) {
  return buildAIWeeklyProjectStatusMatrix_(
    summary.updatedProductionProjects,
    productionProjectsMatrix.startColumn +
      productionProjectsMatrix.headers.length +
      1,
  );
}

function buildAIWeeklyProjectStatusMatrix_(projectSummary, startColumn) {
  const rows = projectSummary.weeks
    .slice()
    .reverse()
    .map((week) => [
      `${week.start} to ${week.end}`,
      week.insideRangeCount,
      week.outsideRangeCount,
      week.withoutProductionDataCount,
      week.totalCount,
    ]);
  return {
    headers: [
      'Week',
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_INSIDE_RANGE_LABEL,
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_OUTSIDE_RANGE_LABEL,
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_WITHOUT_DATA_LABEL,
      'Total',
    ],
    rows,
    startColumn,
  };
}

function writeAIWeeklySummary_(spreadsheet, summary, force) {
  let sheet = spreadsheet.getSheetByName(
    AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_SHEET_NAME,
  );
  if (!sheet) {
    sheet = spreadsheet.insertSheet(
      AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_SHEET_NAME,
    );
    force = true;
  }

  const output = buildAIWeeklySummaryOutput_(summary);
  const matrix = buildAIWeeklyMatrix_(summary);
  const chartMatrix = buildAIWeeklyChartMatrix_(summary, matrix);
  const productionProjectsMatrix =
    buildAIWeeklyProductionProjectsMatrix_(summary, chartMatrix);
  const updatedProductionProjectsMatrix =
    buildAIWeeklyUpdatedProductionProjectsMatrix_(
      summary,
      productionProjectsMatrix,
    );
  if (
    !force &&
    doesAIWeeklySummaryMatch_(
      sheet,
      output,
      matrix,
      chartMatrix,
      productionProjectsMatrix,
      updatedProductionProjectsMatrix,
    )
  ) {
    return {
      sheet: sheet.getName(),
      updated: false,
      unchanged: true,
      rows: output.length,
      historicalWeeks: summary.weeks.length,
      matrixRows: matrix.rows.length,
      matrixCategories: matrix.categories.length,
      chartMatrixSeries: 2,
      productionProjectsMatrixRows: productionProjectsMatrix.rows.length,
      productionProjectsMatrixSeries: 3,
      updatedProductionProjectsMatrixRows:
        updatedProductionProjectsMatrix.rows.length,
      updatedProductionProjectsMatrixSeries: 3,
    };
  }

  if (sheet.getLastRow() > 0 && sheet.getLastColumn() > 0) {
    sheet.getDataRange().breakApart();
  }
  sheet.clear();
  const matrixLastColumn =
    AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_MATRIX_START_COLUMN +
    matrix.headers.length -
    1;
  const updatedProductionProjectsMatrixLastColumn =
    updatedProductionProjectsMatrix.startColumn +
    updatedProductionProjectsMatrix.headers.length -
    1;
  ensureAIAnalysisSheetCapacity_(
    sheet,
    Math.max(
      output.length + 2,
      matrix.rows.length + 3,
      chartMatrix.rows.length + 3,
      productionProjectsMatrix.rows.length + 3,
      updatedProductionProjectsMatrix.rows.length + 3,
    ),
    updatedProductionProjectsMatrixLastColumn + 1,
  );
  sheet.setHiddenGridlines(false);
  sheet.setFrozenRows(1);
  sheet
    .getRange(
      1,
      1,
      1,
      AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_HEADERS.length,
    )
    .setValues([AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_HEADERS])
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR);

  if (output.length > 0) {
    sheet.getRange(2, 1, output.length, 2).setNumberFormat('@');
    sheet.getRange(2, 1, output.length, output[0].length).setValues(output);
    sheet.getRange(2, 4, output.length, 1).setNumberFormat('0');
    sheet.getRange(2, 5, output.length, 1).setNumberFormat('0.00%');
    sheet.getRange(2, 6, output.length, 1).setNumberFormat('0');
  }

  const matrixStartColumn =
    AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_MATRIX_START_COLUMN;
  sheet
    .getRange(1, matrixStartColumn, 1, matrix.headers.length)
    .merge()
    .setValue(AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_MATRIX_TITLE)
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR)
    .setHorizontalAlignment('center');
  sheet
    .getRange(2, matrixStartColumn, 1, matrix.headers.length)
    .setValues([matrix.headers])
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR);
  if (matrix.rows.length > 0) {
    sheet
      .getRange(3, matrixStartColumn, matrix.rows.length, matrix.headers.length)
      .setValues(matrix.rows);
    sheet
      .getRange(
        3,
        matrixStartColumn + 1,
        matrix.rows.length,
        matrix.headers.length - 1,
      )
      .setNumberFormat('0');
  }

  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 240);
  sheet.setColumnWidth(4, 100);
  sheet.setColumnWidth(5, 120);
  sheet.setColumnWidth(6, 110);
  sheet.setColumnWidth(matrixStartColumn, 220);
  sheet.setColumnWidths(
    matrixStartColumn + 1,
    matrix.headers.length - 2,
    145,
  );
  matrix.categories.forEach((category, index) => {
    if (category.length > 18) {
      sheet.setColumnWidth(matrixStartColumn + index + 1, 220);
    }
  });
  sheet.setColumnWidth(matrixLastColumn, 100);

  sheet
    .getRange(
      1,
      chartMatrix.startColumn,
      1,
      chartMatrix.headers.length,
    )
    .merge()
    .setValue(AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_CHART_MATRIX_TITLE)
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR)
    .setHorizontalAlignment('center');
  sheet
    .getRange(
      2,
      chartMatrix.startColumn,
      1,
      chartMatrix.headers.length,
    )
    .setValues([chartMatrix.headers])
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR);
  if (chartMatrix.rows.length > 0) {
    sheet
      .getRange(
        3,
        chartMatrix.startColumn,
        chartMatrix.rows.length,
        chartMatrix.headers.length,
      )
      .setValues(chartMatrix.rows);
    sheet
      .getRange(
        3,
        chartMatrix.startColumn + 1,
        chartMatrix.rows.length,
        chartMatrix.headers.length - 1,
      )
      .setNumberFormat('0');
  }
  sheet.setColumnWidth(chartMatrix.startColumn, 220);
  sheet.setColumnWidths(chartMatrix.startColumn + 1, 3, 145);

  writeAIWeeklyProjectStatusMatrix_(
    sheet,
    productionProjectsMatrix,
    AI_ANALYSIS_DASHBOARD_CONFIG.PRODUCTION_PROJECTS_MATRIX_TITLE,
  );
  writeAIWeeklyProjectStatusMatrix_(
    sheet,
    updatedProductionProjectsMatrix,
    AI_ANALYSIS_DASHBOARD_CONFIG.UPDATED_PRODUCTION_PROJECTS_MATRIX_TITLE,
  );
  return {
    sheet: sheet.getName(),
    updated: true,
    unchanged: false,
    rows: output.length,
    historicalWeeks: summary.weeks.length,
    matrixRows: matrix.rows.length,
    matrixCategories: matrix.categories.length,
    chartMatrixSeries: 2,
    productionProjectsMatrixRows: productionProjectsMatrix.rows.length,
    productionProjectsMatrixSeries: 3,
    updatedProductionProjectsMatrixRows:
      updatedProductionProjectsMatrix.rows.length,
    updatedProductionProjectsMatrixSeries: 3,
  };
}

function writeAIWeeklyProjectStatusMatrix_(sheet, matrix, title) {
  const lastColumn = matrix.startColumn + matrix.headers.length - 1;
  sheet
    .getRange(1, matrix.startColumn, 1, matrix.headers.length)
    .merge()
    .setValue(title)
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR)
    .setHorizontalAlignment('center');
  sheet
    .getRange(2, matrix.startColumn, 1, matrix.headers.length)
    .setValues([matrix.headers])
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR)
    .setWrap(true);
  if (matrix.rows.length > 0) {
    sheet
      .getRange(
        3,
        matrix.startColumn,
        matrix.rows.length,
        matrix.headers.length,
      )
      .setValues(matrix.rows);
    sheet
      .getRange(
        3,
        matrix.startColumn + 1,
        matrix.rows.length,
        matrix.headers.length - 1,
      )
      .setNumberFormat('0');
  }
  sheet.setColumnWidth(matrix.startColumn, 220);
  sheet.setColumnWidths(matrix.startColumn + 1, 3, 190);
  sheet.setColumnWidth(lastColumn, 100);
}

function doesAIWeeklySummaryMatch_(
  sheet,
  output,
  matrix,
  chartMatrix,
  productionProjectsMatrix,
  updatedProductionProjectsMatrix,
) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 6) {
    return false;
  }
  const headers = sheet.getRange(1, 1, 1, 6).getDisplayValues()[0];
  if (
    headers.some(
      (header, index) =>
        String(header).trim() !==
        AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_HEADERS[index],
    )
  ) {
    return false;
  }
  if (output.length > 0) {
    const existing = sheet.getRange(2, 1, output.length, 6).getValues();
    const longFormatMatches = output.every((row, rowIndex) =>
      row.every((value, columnIndex) => {
        const current = existing[rowIndex][columnIndex];
        if (columnIndex === 3 || columnIndex === 4 || columnIndex === 5) {
          return Math.abs(Number(current) - Number(value)) < 0.0000001;
        }
        return String(current).trim() === String(value).trim();
      }),
    );
    if (!longFormatMatches) {
      return false;
    }
  }
  if (
    String(sheet.getRange(output.length + 2, 1).getDisplayValue()).trim()
  ) {
    return false;
  }
  return (
    doesAIWeeklyMatrixMatch_(sheet, matrix) &&
    doesAIWeeklyChartMatrixMatch_(sheet, chartMatrix) &&
    doesAIWeeklyProjectStatusMatrixMatch_(
      sheet,
      productionProjectsMatrix,
      AI_ANALYSIS_DASHBOARD_CONFIG.PRODUCTION_PROJECTS_MATRIX_TITLE,
    ) &&
    doesAIWeeklyProjectStatusMatrixMatch_(
      sheet,
      updatedProductionProjectsMatrix,
      AI_ANALYSIS_DASHBOARD_CONFIG.UPDATED_PRODUCTION_PROJECTS_MATRIX_TITLE,
    )
  );
}

function doesAIWeeklyMatrixMatch_(sheet, matrix) {
  const startColumn =
    AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_MATRIX_START_COLUMN;
  if (
    sheet.getMaxColumns() < startColumn + matrix.headers.length ||
    sheet.getMaxRows() < matrix.rows.length + 3
  ) {
    return false;
  }
  if (
    String(sheet.getRange(1, startColumn).getDisplayValue()).trim() !==
    AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_MATRIX_TITLE
  ) {
    return false;
  }
  const headers = sheet
    .getRange(2, startColumn, 1, matrix.headers.length)
    .getDisplayValues()[0];
  if (
    headers.some(
      (header, index) => String(header).trim() !== matrix.headers[index],
    )
  ) {
    return false;
  }
  if (
    String(
      sheet
        .getRange(2, startColumn + matrix.headers.length)
        .getDisplayValue(),
    ).trim()
  ) {
    return false;
  }
  if (matrix.rows.length === 0) {
    return !String(sheet.getRange(3, startColumn).getDisplayValue()).trim();
  }

  const existing = sheet
    .getRange(3, startColumn, matrix.rows.length, matrix.headers.length)
    .getValues();
  const valuesMatch = matrix.rows.every((row, rowIndex) =>
    row.every((value, columnIndex) => {
      const current = existing[rowIndex][columnIndex];
      if (columnIndex === 0) {
        return String(current).trim() === String(value).trim();
      }
      return Number(current) === Number(value);
    }),
  );
  if (!valuesMatch) {
    return false;
  }
  return !String(
    sheet
      .getRange(matrix.rows.length + 3, startColumn)
      .getDisplayValue(),
  ).trim();
}

function doesAIWeeklyChartMatrixMatch_(sheet, chartMatrix) {
  const startColumn = chartMatrix.startColumn;
  if (
    sheet.getMaxColumns() < startColumn + chartMatrix.headers.length ||
    sheet.getMaxRows() < chartMatrix.rows.length + 3
  ) {
    return false;
  }
  if (
    String(sheet.getRange(1, startColumn).getDisplayValue()).trim() !==
    AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_CHART_MATRIX_TITLE
  ) {
    return false;
  }
  const headers = sheet
    .getRange(2, startColumn, 1, chartMatrix.headers.length)
    .getDisplayValues()[0];
  if (
    headers.some(
      (header, index) => String(header).trim() !== chartMatrix.headers[index],
    )
  ) {
    return false;
  }
  if (
    String(
      sheet
        .getRange(2, startColumn + chartMatrix.headers.length)
        .getDisplayValue(),
    ).trim()
  ) {
    return false;
  }
  if (chartMatrix.rows.length === 0) {
    return !String(sheet.getRange(3, startColumn).getDisplayValue()).trim();
  }
  const existing = sheet
    .getRange(
      3,
      startColumn,
      chartMatrix.rows.length,
      chartMatrix.headers.length,
    )
    .getValues();
  const valuesMatch = chartMatrix.rows.every((row, rowIndex) =>
    row.every((value, columnIndex) => {
      const current = existing[rowIndex][columnIndex];
      if (columnIndex === 0) {
        return String(current).trim() === String(value).trim();
      }
      return Number(current) === Number(value);
    }),
  );
  if (!valuesMatch) {
    return false;
  }
  return !String(
    sheet
      .getRange(chartMatrix.rows.length + 3, startColumn)
      .getDisplayValue(),
  ).trim();
}

function doesAIWeeklyProjectStatusMatrixMatch_(sheet, matrix, title) {
  const startColumn = matrix.startColumn;
  if (
    sheet.getMaxColumns() < startColumn + matrix.headers.length ||
    sheet.getMaxRows() < matrix.rows.length + 3
  ) {
    return false;
  }
  if (
    String(sheet.getRange(1, startColumn).getDisplayValue()).trim() !==
    title
  ) {
    return false;
  }
  const headers = sheet
    .getRange(2, startColumn, 1, matrix.headers.length)
    .getDisplayValues()[0];
  if (
    headers.some(
      (header, index) => String(header).trim() !== matrix.headers[index],
    )
  ) {
    return false;
  }
  if (
    String(
      sheet
        .getRange(2, startColumn + matrix.headers.length)
        .getDisplayValue(),
    ).trim()
  ) {
    return false;
  }
  if (matrix.rows.length === 0) {
    return !String(sheet.getRange(3, startColumn).getDisplayValue()).trim();
  }
  const existing = sheet
    .getRange(3, startColumn, matrix.rows.length, matrix.headers.length)
    .getValues();
  const valuesMatch = matrix.rows.every((row, rowIndex) =>
    row.every((value, columnIndex) => {
      const current = existing[rowIndex][columnIndex];
      if (columnIndex === 0) {
        return String(current).trim() === String(value).trim();
      }
      return Number(current) === Number(value);
    }),
  );
  if (!valuesMatch) return false;
  return !String(
    sheet
      .getRange(matrix.rows.length + 3, startColumn)
      .getDisplayValue(),
  ).trim();
}

function writeAIAnalysisDashboard_(spreadsheet, summary, force) {
  let sheet = spreadsheet.getSheetByName(
    AI_ANALYSIS_DASHBOARD_CONFIG.SHEET_NAME,
  );
  if (!sheet) {
    sheet = spreadsheet.insertSheet(
      AI_ANALYSIS_DASHBOARD_CONFIG.SHEET_NAME,
    );
    force = true;
  }

  const visibleWeeks = getVisibleAIAnalysisDashboardWeeks_(summary);
  const matrix = buildAIWeeklyMatrix_(summary);
  const chartMatrix = buildAIWeeklyChartMatrix_(summary, matrix);
  const productionProjectsMatrix =
    buildAIWeeklyProductionProjectsMatrix_(summary, chartMatrix);
  const updatedProductionProjectsMatrix =
    buildAIWeeklyUpdatedProductionProjectsMatrix_(
      summary,
      productionProjectsMatrix,
    );
  const layoutMatches = doesAIAnalysisDashboardLayoutMatch_(
    sheet,
    summary,
    visibleWeeks,
    matrix,
    productionProjectsMatrix,
    updatedProductionProjectsMatrix,
  );
  if (
    !force &&
    layoutMatches &&
    doesAIAnalysisDashboardDataMatch_(sheet, summary, visibleWeeks)
  ) {
    return {
      sheet: sheet.getName(),
      updated: false,
      unchanged: true,
      chartsRebuilt: false,
      charts: expectedAIAnalysisDashboardChartCount_(summary, visibleWeeks),
      weeklyCharts: visibleWeeks.length,
    };
  }

  const rebuildLayout = force || !layoutMatches;
  if (rebuildLayout) {
    initializeAIAnalysisDashboardLayout_(sheet, visibleWeeks);
  } else {
    clearAIAnalysisDashboardValues_(sheet, visibleWeeks.length);
  }
  writeAIAnalysisDashboardValues_(
    sheet,
    summary,
    visibleWeeks,
    matrix,
    productionProjectsMatrix,
    updatedProductionProjectsMatrix,
  );
  if (rebuildLayout) {
    insertAIAnalysisDashboardCharts_(
      spreadsheet,
      sheet,
      summary,
      visibleWeeks,
      matrix,
      productionProjectsMatrix,
      updatedProductionProjectsMatrix,
    );
  }
  SpreadsheetApp.flush();

  return {
    sheet: sheet.getName(),
    updated: true,
    unchanged: false,
    chartsRebuilt: rebuildLayout,
    charts: expectedAIAnalysisDashboardChartCount_(summary, visibleWeeks),
    weeklyCharts: visibleWeeks.length,
  };
}

function initializeAIAnalysisDashboardLayout_(sheet, visibleWeeks) {
  ensureAIAnalysisSheetCapacity_(
    sheet,
    getAIAnalysisDashboardLastManagedRow_(visibleWeeks.length),
    Math.max(
      AI_ANALYSIS_DASHBOARD_CONFIG.CHART_COLUMN,
      AI_ANALYSIS_DASHBOARD_CONFIG.STACKED_CHART_COLUMN,
      AI_ANALYSIS_DASHBOARD_CONFIG.PRODUCTION_PROJECTS_CHART_COLUMN,
      AI_ANALYSIS_DASHBOARD_CONFIG.UPDATED_PRODUCTION_PROJECTS_CHART_COLUMN,
    ),
  );
  sheet.getCharts().forEach((chart) => sheet.removeChart(chart));
  if (sheet.getLastRow() > 0 && sheet.getLastColumn() > 0) {
    sheet.getDataRange().breakApart();
  }
  sheet.clear();
  sheet.setHiddenGridlines(true);
  sheet.setFrozenRows(4);

  sheet.getRange('A1:D1').merge();
  formatAIAnalysisDashboardTitle_(sheet.getRange('A1:D1'));
  formatAIAnalysisDashboardHeader_(sheet.getRange(4, 1, 1, 3));

  visibleWeeks.forEach((week, index) => {
    const startRow = getAIAnalysisWeeklyBlockStartRow_(index);
    sheet.getRange(startRow, 1, 1, 4).merge();
    formatAIAnalysisDashboardTitle_(sheet.getRange(startRow, 1, 1, 4));
    formatAIAnalysisDashboardHeader_(
      sheet.getRange(startRow + 3, 1, 1, 3),
    );
  });

  sheet.setColumnWidth(1, 240);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 150);
}

function clearAIAnalysisDashboardValues_(sheet, visibleWeekCount) {
  const lastManagedRow = getAIAnalysisDashboardLastManagedRow_(
    visibleWeekCount,
  );
  sheet.getRange(1, 1, lastManagedRow, 4).clearContent();
}

function writeAIAnalysisDashboardValues_(
  sheet,
  summary,
  visibleWeeks,
  matrix,
  productionProjectsMatrix,
  updatedProductionProjectsMatrix,
) {
  sheet
    .getRange('A1')
    .setValue(AI_ANALYSIS_DASHBOARD_CONFIG.TITLE)
    .setNote(
      buildAIAnalysisDashboardLayoutNote_(
        matrix,
        productionProjectsMatrix,
        updatedProductionProjectsMatrix,
      ),
    );
  sheet.getRange('A2').setValue('Updated At').setFontWeight('bold');
  sheet
    .getRange('B2')
    .setValue(new Date())
    .setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('C2').setValue('Total Categorized Rows').setFontWeight('bold');
  sheet.getRange('D2').setValue(summary.totalCount).setNumberFormat('0');
  sheet.getRange('A3').setValue('Historical Weeks').setFontWeight('bold');
  sheet.getRange('B3').setValue(summary.weeks.length).setNumberFormat('0');
  sheet
    .getRange('C3')
    .setValue('Excluded From Weekly')
    .setFontWeight('bold');
  sheet
    .getRange('D3')
    .setValue(summary.excludedFromWeeklyCount)
    .setNumberFormat('0');

  writeAIAnalysisCategorySlot_(sheet, 4, summary.rows, true);

  visibleWeeks.forEach((week, index) => {
    const startRow = getAIAnalysisWeeklyBlockStartRow_(index);
    sheet
      .getRange(startRow, 1)
      .setValue(`Week ${week.start} to ${week.end}`);
    sheet.getRange(startRow + 1, 1).setValue('Week Start').setFontWeight('bold');
    sheet.getRange(startRow + 1, 2).setNumberFormat('@').setValue(week.start);
    sheet.getRange(startRow + 1, 3).setValue('Week End').setFontWeight('bold');
    sheet.getRange(startRow + 1, 4).setNumberFormat('@').setValue(week.end);
    sheet
      .getRange(startRow + 2, 1)
      .setValue('Categorized Emails')
      .setFontWeight('bold');
    sheet.getRange(startRow + 2, 2).setValue(week.totalCount);
    writeAIAnalysisCategorySlot_(sheet, startRow + 3, week.rows, false);
  });
}

function writeAIAnalysisCategorySlot_(sheet, headerRow, rows, allowEmpty) {
  sheet
    .getRange(headerRow, 1, 1, 3)
    .setValues([AI_ANALYSIS_DASHBOARD_CONFIG.TABLE_HEADERS]);
  const dataStartRow = headerRow + 1;
  if (rows.length > 0) {
    const output = rows.map((row) => [
      row.category,
      row.count,
      row.percentage,
    ]);
    sheet.getRange(dataStartRow, 1, output.length, 3).setValues(output);
    sheet.getRange(dataStartRow, 2, output.length, 1).setNumberFormat('0');
    sheet
      .getRange(dataStartRow, 3, output.length, 1)
      .setNumberFormat('0.00%');
  } else if (allowEmpty) {
    sheet
      .getRange(dataStartRow, 1)
      .setValue('No categorized AI Analysis rows found.');
  }
}

function formatAIAnalysisDashboardTitle_(range) {
  range
    .setFontSize(16)
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR)
    .setHorizontalAlignment('center');
}

function formatAIAnalysisDashboardHeader_(range) {
  range
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR);
}

function insertAIAnalysisDashboardCharts_(
  spreadsheet,
  sheet,
  summary,
  visibleWeeks,
  matrix,
  productionProjectsMatrix,
  updatedProductionProjectsMatrix,
) {
  if (summary.rows.length > 0) {
    insertAIAnalysisCategoryChart_(
      sheet,
      4,
      2,
      'All-time Count of Primary Category',
    );
  }
  if (
    matrix.rows.length > 0 ||
    productionProjectsMatrix.rows.length > 0 ||
    updatedProductionProjectsMatrix.rows.length > 0
  ) {
    const weeklySheet = spreadsheet.getSheetByName(
      AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_SHEET_NAME,
    );
    if (!weeklySheet) {
      throw new Error(
        'AI Weekly Summary is missing. Run setupAIAnalysisDashboard() again.',
      );
    }
    if (matrix.rows.length > 0) {
      insertAIWeeklyStackedChart_(
        sheet,
        weeklySheet,
        buildAIWeeklyChartMatrix_(summary, matrix),
      );
    }
    if (productionProjectsMatrix.rows.length > 0) {
      insertAIWeeklyProjectStatusChart_(
        sheet,
        weeklySheet,
        productionProjectsMatrix,
        AI_ANALYSIS_DASHBOARD_CONFIG.PRODUCTION_PROJECTS_MATRIX_TITLE,
        AI_ANALYSIS_DASHBOARD_CONFIG.PRODUCTION_PROJECTS_CHART_COLUMN,
      );
    }
    if (updatedProductionProjectsMatrix.rows.length > 0) {
      insertAIWeeklyProjectStatusChart_(
        sheet,
        weeklySheet,
        updatedProductionProjectsMatrix,
        AI_ANALYSIS_DASHBOARD_CONFIG.UPDATED_PRODUCTION_PROJECTS_MATRIX_TITLE,
        AI_ANALYSIS_DASHBOARD_CONFIG.UPDATED_PRODUCTION_PROJECTS_CHART_COLUMN,
      );
    }
  }
  visibleWeeks.forEach((week, index) => {
    const startRow = getAIAnalysisWeeklyBlockStartRow_(index);
    insertAIAnalysisCategoryChart_(
      sheet,
      startRow + 3,
      startRow + 1,
      `Primary Category Count: ${week.start} to ${week.end}`,
    );
  });
}

function insertAIAnalysisCategoryChart_(sheet, headerRow, chartRow, title) {
  const chart = sheet
    .newChart()
    .asColumnChart()
    .addRange(
      sheet.getRange(
        headerRow,
        1,
        AI_ANALYSIS_DASHBOARD_CONFIG.CATEGORY_SLOT_ROWS + 1,
        2,
      ),
    )
    .setNumHeaders(1)
    .setPosition(
      chartRow,
      AI_ANALYSIS_DASHBOARD_CONFIG.CHART_COLUMN,
      0,
      0,
    )
    .setOption('title', title)
    .setOption('legend', {position: 'none'})
    .setOption('colors', [AI_ANALYSIS_DASHBOARD_CONFIG.CHART_COLOR])
    .setOption('width', 900)
    .setOption('height', 500)
    .setOption('hAxis', {
      title: 'Primary Category',
      slantedText: true,
      slantedTextAngle: 30,
    })
    .setOption('vAxis', {
      title: 'Count',
      minValue: 0,
      format: '0',
    })
    .build();
  sheet.insertChart(chart);
}

function insertAIWeeklyStackedChart_(dashboardSheet, weeklySheet, chartMatrix) {
  const chartRange = weeklySheet.getRange(
    2,
    chartMatrix.startColumn,
    chartMatrix.rows.length + 1,
    3,
  );
  const colors = [
    getAIAnalysisCategoryColor_(
      AI_ANALYSIS_DASHBOARD_CONFIG.PRODUCTION_CATEGORY,
      0,
    ),
    '#9aa0a6',
  ];
  const series = {
    0: {
      color: colors[0],
      dataLabel: 'value',
      annotations: {
        textStyle: {
          color: AI_ANALYSIS_DASHBOARD_CONFIG.PRODUCTION_DATA_LABEL_COLOR,
          fontSize: 18,
          bold: true,
          auraColor: 'none',
        },
      },
    },
    1: {
      color: colors[1],
      dataLabel: 'value',
      annotations: {
        textStyle: {
          color: '#000000',
          fontSize: 18,
          bold: true,
          auraColor: 'none',
        },
      },
    },
  };
  const chart = dashboardSheet
    .newChart()
    .asColumnChart()
    .addRange(chartRange)
    .setNumHeaders(1)
    .setPosition(
      2,
      AI_ANALYSIS_DASHBOARD_CONFIG.STACKED_CHART_COLUMN,
      0,
      0,
    )
    .setOption('title', 'Weekly Production vs Other Categories')
    .setOption('isStacked', true)
    .setOption('legend', {position: 'top'})
    .setOption('colors', colors)
    .setOption('series', series)
    .setOption('width', 1000)
    .setOption('height', 500)
    .setOption('hAxis', {
      title: 'Week',
      slantedText: true,
      slantedTextAngle: 30,
    })
    .setOption('vAxis', {
      title: 'Categorized Emails',
      minValue: 0,
      format: '0',
    })
    .build();
  dashboardSheet.insertChart(chart);
}

function insertAIWeeklyProjectStatusChart_(
  dashboardSheet,
  weeklySheet,
  matrix,
  title,
  chartColumn,
) {
  const chartRange = weeklySheet.getRange(
    2,
    matrix.startColumn,
    matrix.rows.length + 1,
    4,
  );
  const colors = [
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_INSIDE_RANGE_COLOR,
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_OUTSIDE_RANGE_COLOR,
    AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_WITHOUT_DATA_COLOR,
  ];
  const series = {};
  colors.forEach((color, index) => {
    series[index] = {
      color,
      dataLabel: 'value',
      annotations: {
        textStyle: {
          color: '#000000',
          fontSize: 16,
          bold: true,
          auraColor: 'none',
        },
      },
    };
  });
  const chart = dashboardSheet
    .newChart()
    .asColumnChart()
    .addRange(chartRange)
    .setNumHeaders(1)
    .setPosition(
      2,
      chartColumn,
      0,
      0,
    )
    .setOption('title', title)
    .setOption('isStacked', true)
    .setOption('legend', {position: 'top'})
    .setOption('colors', colors)
    .setOption('series', series)
    .setOption('width', 1000)
    .setOption('height', 500)
    .setOption('hAxis', {
      title: 'Week',
      slantedText: true,
      slantedTextAngle: 30,
    })
    .setOption('vAxis', {
      title: 'Projects',
      minValue: 0,
      format: '0',
    })
    .build();
  dashboardSheet.insertChart(chart);
}

function getAIAnalysisCategoryColor_(category, index) {
  const configuredColor =
    AI_ANALYSIS_DASHBOARD_CONFIG.CATEGORY_COLORS[category];
  if (configuredColor) {
    return configuredColor;
  }
  const fallbackColors =
    AI_ANALYSIS_DASHBOARD_CONFIG.FALLBACK_CATEGORY_COLORS;
  return fallbackColors[index % fallbackColors.length];
}

function doesAIAnalysisDashboardLayoutMatch_(
  sheet,
  summary,
  visibleWeeks,
  matrix,
  productionProjectsMatrix,
  updatedProductionProjectsMatrix,
) {
  if (sheet.getLastRow() < 4 || sheet.getLastColumn() < 4) {
    return false;
  }
  if (
    sheet.getRange('A1').getNote() !==
    buildAIAnalysisDashboardLayoutNote_(
      matrix,
      productionProjectsMatrix,
      updatedProductionProjectsMatrix,
    )
  ) {
    return false;
  }
  if (
    sheet.getCharts().length !==
    expectedAIAnalysisDashboardChartCount_(summary, visibleWeeks)
  ) {
    return false;
  }

  return visibleWeeks.every((week, index) => {
    const startRow = getAIAnalysisWeeklyBlockStartRow_(index);
    return (
      String(sheet.getRange(startRow + 1, 2).getDisplayValue()).trim() ===
      week.start
    );
  });
}

function doesAIAnalysisDashboardDataMatch_(sheet, summary, visibleWeeks) {
  if (Number(sheet.getRange('D2').getValue()) !== summary.totalCount) {
    return false;
  }
  if (Number(sheet.getRange('B3').getValue()) !== summary.weeks.length) {
    return false;
  }
  if (
    Number(sheet.getRange('D3').getValue()) !==
    summary.excludedFromWeeklyCount
  ) {
    return false;
  }
  if (!doesAIAnalysisCategorySlotMatch_(sheet, 4, summary.rows, true)) {
    return false;
  }

  return visibleWeeks.every((week, index) => {
    const startRow = getAIAnalysisWeeklyBlockStartRow_(index);
    return (
      String(sheet.getRange(startRow + 1, 2).getDisplayValue()).trim() ===
        week.start &&
      String(sheet.getRange(startRow + 1, 4).getDisplayValue()).trim() ===
        week.end &&
      Number(sheet.getRange(startRow + 2, 2).getValue()) ===
        week.totalCount &&
      doesAIAnalysisCategorySlotMatch_(
        sheet,
        startRow + 3,
        week.rows,
        false,
      )
    );
  });
}

function doesAIAnalysisCategorySlotMatch_(sheet, headerRow, rows, allowEmpty) {
  const headers = sheet.getRange(headerRow, 1, 1, 3).getDisplayValues()[0];
  if (
    headers.some(
      (header, index) =>
        String(header).trim() !==
        AI_ANALYSIS_DASHBOARD_CONFIG.TABLE_HEADERS[index],
    )
  ) {
    return false;
  }

  const values = sheet
    .getRange(
      headerRow + 1,
      1,
      AI_ANALYSIS_DASHBOARD_CONFIG.CATEGORY_SLOT_ROWS,
      3,
    )
    .getValues();
  if (rows.length === 0 && allowEmpty) {
    return (
      String(values[0][0]).trim() ===
      'No categorized AI Analysis rows found.'
    );
  }

  return values.every((existing, index) => {
    const expected = rows[index];
    if (!expected) {
      return existing.every((value) => String(value).trim() === '');
    }
    return (
      String(existing[0]).trim() === expected.category &&
      Number(existing[1]) === expected.count &&
      Math.abs(Number(existing[2]) - expected.percentage) < 0.0000001
    );
  });
}

function expectedAIAnalysisDashboardChartCount_(summary, visibleWeeks) {
  return (
    (summary.rows.length > 0 ? 1 : 0) +
    (summary.weeks.length > 0 ? 1 : 0) +
    (summary.productionProjects.weeks.length > 0 ? 1 : 0) +
    (summary.updatedProductionProjects.weeks.length > 0 ? 1 : 0) +
    visibleWeeks.length
  );
}

function buildAIAnalysisDashboardLayoutNote_(
  matrix,
  productionProjectsMatrix,
  updatedProductionProjectsMatrix,
) {
  const weekSignature = matrix.rows.map((row) => row[0]).join('|');
  const categorySignature = matrix.categories.join('|');
  const projectWeekSignature = productionProjectsMatrix.rows
    .map((row) => row[0])
    .join('|');
  const updatedProjectWeekSignature = updatedProductionProjectsMatrix.rows
    .map((row) => row[0])
    .join('|');
  return (
    `${AI_ANALYSIS_DASHBOARD_CONFIG.LAYOUT_NOTE}\n` +
    `Weekly detail enabled: ${
      AI_ANALYSIS_DASHBOARD_CONFIG.SHOW_WEEKLY_PRIMARY_CATEGORY_DETAILS
    }\n` +
    `Weeks: ${weekSignature}\n` +
    `Categories: ${categorySignature}\n` +
    `Project weeks: ${projectWeekSignature}\n` +
    `Updated project weeks: ${updatedProjectWeekSignature}`
  );
}

function getAIAnalysisWeeklyBlockStartRow_(index) {
  return (
    AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_FIRST_ROW +
    index * AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_BLOCK_HEIGHT
  );
}

function getVisibleAIAnalysisDashboardWeeks_(summary) {
  if (
    !AI_ANALYSIS_DASHBOARD_CONFIG.SHOW_WEEKLY_PRIMARY_CATEGORY_DETAILS
  ) {
    return [];
  }
  return summary.weeks.slice(
    0,
    AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_CHART_LIMIT,
  );
}

function getAIAnalysisDashboardLastManagedRow_(visibleWeekCount) {
  if (visibleWeekCount === 0) {
    return 4 + AI_ANALYSIS_DASHBOARD_CONFIG.CATEGORY_SLOT_ROWS;
  }
  return (
    getAIAnalysisWeeklyBlockStartRow_(visibleWeekCount - 1) +
    AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_BLOCK_HEIGHT -
    1
  );
}

function ensureAIAnalysisSheetCapacity_(sheet, requiredRows, requiredColumns) {
  if (sheet.getMaxRows() < requiredRows) {
    sheet.insertRowsAfter(
      sheet.getMaxRows(),
      requiredRows - sheet.getMaxRows(),
    );
  }
  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      requiredColumns - sheet.getMaxColumns(),
    );
  }
}

function buildAIAnalysisDashboardStats_(summary, weeklyStats, dashboardStats) {
  const visibleWeeks = getVisibleAIAnalysisDashboardWeeks_(summary);
  const visibleWeeklyCharts = visibleWeeks.length;
  return {
    totalCount: summary.totalCount,
    distinctCategories: summary.rows.length,
    historicalWeeks: summary.weeks.length,
    weeklyPrimaryCategoryDetailsEnabled:
      AI_ANALYSIS_DASHBOARD_CONFIG.SHOW_WEEKLY_PRIMARY_CATEGORY_DETAILS,
    visibleWeeklyCharts,
    stackedWeeklyChart: summary.weeks.length > 0,
    stackedWeeklySourceHeader:
      AI_ANALYSIS_DASHBOARD_CONFIG.CATEGORIES_HEADER,
    stackedWeeklySeries: [
      AI_ANALYSIS_DASHBOARD_CONFIG.PRODUCTION_SERIES_LABEL,
      AI_ANALYSIS_DASHBOARD_CONFIG.OTHER_CATEGORIES_LABEL,
    ],
    weeklyProductionProjectsChart:
      summary.productionProjects.weeks.length > 0,
    weeklyProductionProjectsSourceHeaders: [
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_CREATED_AT_HEADER,
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_TOLERANCE_HEADER,
    ],
    weeklyProductionProjectsSeries: [
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_INSIDE_RANGE_LABEL,
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_OUTSIDE_RANGE_LABEL,
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_WITHOUT_DATA_LABEL,
    ],
    productionProjectHistoricalWeeks:
      summary.productionProjects.weeks.length,
    productionProjects: summary.productionProjects.totalProjects,
    productionProjectsWithCreatedAt:
      summary.productionProjects.projectsWithDate,
    productionProjectsWithoutCreatedAt:
      summary.productionProjects.projectsWithoutDate,
    duplicateProductionProjectRows:
      summary.productionProjects.duplicateProjectRows,
    weeklyProductionUpdatedProjectsChart:
      summary.updatedProductionProjects.weeks.length > 0,
    weeklyProductionUpdatedProjectsSourceHeaders: [
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_UPDATED_AT_HEADER,
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_TOLERANCE_HEADER,
    ],
    weeklyProductionUpdatedProjectsSeries: [
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_INSIDE_RANGE_LABEL,
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_OUTSIDE_RANGE_LABEL,
      AI_ANALYSIS_DASHBOARD_CONFIG.PROJECT_WITHOUT_DATA_LABEL,
    ],
    updatedProductionProjectHistoricalWeeks:
      summary.updatedProductionProjects.weeks.length,
    updatedProductionProjects:
      summary.updatedProductionProjects.totalProjects,
    updatedProductionProjectsWithUpdatedAt:
      summary.updatedProductionProjects.projectsWithDate,
    updatedProductionProjectsWithoutUpdatedAt:
      summary.updatedProductionProjects.projectsWithoutDate,
    duplicateUpdatedProductionProjectRows:
      summary.updatedProductionProjects.duplicateProjectRows,
    totalCharts: expectedAIAnalysisDashboardChartCount_(
      summary,
      visibleWeeks,
    ),
    weeklyMatrixCategories: getAIWeeklyMatrixCategories_(summary),
    excludedFromWeeklyCount: summary.excludedFromWeeklyCount,
    uncategorizedRows: summary.uncategorizedRows,
    weeklySummary: weeklyStats,
    dashboard: dashboardStats,
  };
}
