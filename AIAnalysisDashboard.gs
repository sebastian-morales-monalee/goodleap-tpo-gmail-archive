/**
 * GoodLeap TPO - AI primary-category dashboard
 *
 * This file belongs in the SAME Apps Script project as OpenAIAnalysis.gs. It
 * reads the managed "AI Analysis" sheet, counts every non-empty Primary
 * Category, and maintains an idempotent summary table and column chart in the
 * "AI Dashboard" sheet. It does not call OpenAI, Gmail, Drive, or PostHog.
 *
 * Safe first-run sequence:
 *   1) previewAIAnalysisDashboard()
 *   2) setupAIAnalysisDashboard()
 *
 * OpenAIAnalysis.gs calls refreshAIAnalysisDashboardSafely_() after each
 * automatic analysis check. The dashboard is rewritten only when its category
 * counts changed, so the existing five-minute trigger remains sufficient.
 */

const AI_ANALYSIS_DASHBOARD_CONFIG = {
  SHEET_NAME: 'AI Dashboard',
  SOURCE_SHEET_NAME: 'AI Analysis',
  PRIMARY_CATEGORY_HEADER: 'Primary Category',
  TABLE_HEADERS: ['Primary Category', 'Count', 'Percentage'],
  TITLE: 'AI Analysis - Primary Category Dashboard',
  HEADER_COLOR: '#6e04bd',
  HEADER_TEXT_COLOR: '#ffffff',
  CHART_COLOR: '#4285f4',
};

/**
 * Creates or rebuilds AI Dashboard from all existing AI Analysis rows.
 * This function is idempotent and does not call OpenAI.
 */
function setupAIAnalysisDashboard() {
  const resources = getOrCreateResources_();
  const summary = loadAIAnalysisDashboardSummary_(resources.spreadsheet);
  const stats = writeAIAnalysisDashboard_(
    resources.spreadsheet,
    summary,
    true,
  );

  console.log('AI Analysis dashboard setup completed.');
  console.log(`Spreadsheet: ${resources.spreadsheet.getUrl()}`);
  console.log(`Dashboard sheet: ${AI_ANALYSIS_DASHBOARD_CONFIG.SHEET_NAME}`);
  console.log(`Analyzed categories counted: ${summary.totalCount}.`);
  console.log(`Distinct primary categories: ${summary.rows.length}.`);

  return stats;
}

/**
 * Logs the category counts without creating or modifying AI Dashboard.
 */
function previewAIAnalysisDashboard() {
  const resources = getOrCreateResources_();
  const summary = loadAIAnalysisDashboardSummary_(resources.spreadsheet);

  summary.rows.forEach((row) => {
    console.log(
      `[CATEGORY] ${row.category} | ${row.count} | ` +
      `${(row.percentage * 100).toFixed(2)}%`,
    );
  });
  console.log(
    JSON.stringify(
      {
        totalCount: summary.totalCount,
        distinctCategories: summary.rows.length,
      },
      null,
      2,
    ),
  );

  return {
    totalCount: summary.totalCount,
    distinctCategories: summary.rows.length,
    categories: summary.rows,
  };
}

/**
 * Refreshes AI Dashboard only when the managed summary differs from the
 * current AI Analysis data. It is safe to run manually at any time.
 */
function refreshAIAnalysisDashboard() {
  const resources = getOrCreateResources_();
  const summary = loadAIAnalysisDashboardSummary_(resources.spreadsheet);
  const stats = writeAIAnalysisDashboard_(
    resources.spreadsheet,
    summary,
    false,
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

  const lastColumn = sourceSheet.getLastColumn();
  const headers = sourceSheet
    .getRange(1, 1, 1, lastColumn)
    .getDisplayValues()[0]
    .map((value) => String(value).trim());
  const categoryIndex = headers.indexOf(
    AI_ANALYSIS_DASHBOARD_CONFIG.PRIMARY_CATEGORY_HEADER,
  );
  if (categoryIndex < 0) {
    throw new Error(
      'AI Analysis does not contain the required Primary Category header.',
    );
  }

  const counts = new Map();
  const dataRowCount = Math.max(0, sourceSheet.getLastRow() - 1);
  if (dataRowCount > 0) {
    const values = sourceSheet
      .getRange(2, categoryIndex + 1, dataRowCount, 1)
      .getDisplayValues();
    values.forEach((row) => {
      const category = String(row[0] || '').trim();
      if (!category) {
        return;
      }
      counts.set(category, Number(counts.get(category) || 0) + 1);
    });
  }

  const totalCount = Array.from(counts.values()).reduce(
    (total, count) => total + count,
    0,
  );
  const rows = Array.from(counts.entries())
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

  return {totalCount, rows};
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

  if (!force && doesAIAnalysisDashboardMatch_(sheet, summary)) {
    return {
      sheet: sheet.getName(),
      updated: false,
      unchanged: true,
      totalCount: summary.totalCount,
      distinctCategories: summary.rows.length,
    };
  }

  sheet.getCharts().forEach((chart) => sheet.removeChart(chart));
  if (sheet.getLastRow() > 0 && sheet.getLastColumn() > 0) {
    sheet.getDataRange().breakApart();
  }
  sheet.clear();
  sheet.setHiddenGridlines(true);
  sheet.setFrozenRows(4);

  sheet.getRange('A1:D1').merge();
  sheet
    .getRange('A1')
    .setValue(AI_ANALYSIS_DASHBOARD_CONFIG.TITLE)
    .setFontSize(16)
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR)
    .setHorizontalAlignment('center');

  sheet.getRange('A2').setValue('Updated At').setFontWeight('bold');
  sheet.getRange('B2').setValue(new Date()).setNumberFormat(
    'yyyy-mm-dd hh:mm:ss',
  );
  sheet.getRange('C2').setValue('Total Categorized Rows').setFontWeight(
    'bold',
  );
  sheet.getRange('D2').setValue(summary.totalCount);

  sheet
    .getRange(4, 1, 1, AI_ANALYSIS_DASHBOARD_CONFIG.TABLE_HEADERS.length)
    .setValues([AI_ANALYSIS_DASHBOARD_CONFIG.TABLE_HEADERS])
    .setFontWeight('bold')
    .setBackground(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_COLOR)
    .setFontColor(AI_ANALYSIS_DASHBOARD_CONFIG.HEADER_TEXT_COLOR);

  if (summary.rows.length > 0) {
    const output = summary.rows.map((row) => [
      row.category,
      row.count,
      row.percentage,
    ]);
    sheet.getRange(5, 1, output.length, 3).setValues(output);
    sheet.getRange(5, 2, output.length, 1).setNumberFormat('0');
    sheet.getRange(5, 3, output.length, 1).setNumberFormat('0.00%');

    const chart = sheet
      .newChart()
      .asColumnChart()
      .addRange(sheet.getRange(4, 1, output.length + 1, 2))
      .setNumHeaders(1)
      .setPosition(2, 5, 0, 0)
      .setOption('title', 'Count of Primary Category')
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
  } else {
    sheet.getRange('A5').setValue('No categorized AI Analysis rows found.');
  }

  sheet.setColumnWidth(1, 240);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 120);
  sheet.setColumnWidth(4, 150);
  SpreadsheetApp.flush();

  return {
    sheet: sheet.getName(),
    updated: true,
    unchanged: false,
    totalCount: summary.totalCount,
    distinctCategories: summary.rows.length,
  };
}

function doesAIAnalysisDashboardMatch_(sheet, summary) {
  if (sheet.getLastRow() < 4 || sheet.getLastColumn() < 3) {
    return false;
  }
  const headers = sheet.getRange(4, 1, 1, 3).getDisplayValues()[0];
  if (
    headers.some(
      (header, index) =>
        String(header).trim() !==
        AI_ANALYSIS_DASHBOARD_CONFIG.TABLE_HEADERS[index],
    )
  ) {
    return false;
  }
  if (Number(sheet.getRange('D2').getValue()) !== summary.totalCount) {
    return false;
  }

  if (summary.rows.length === 0) {
    return (
      String(sheet.getRange('A5').getDisplayValue()).trim() ===
      'No categorized AI Analysis rows found.'
    );
  }

  const existingRows = Math.max(0, sheet.getLastRow() - 4);
  if (existingRows !== summary.rows.length) {
    return false;
  }
  const values = sheet.getRange(5, 1, existingRows, 2).getDisplayValues();
  return summary.rows.every(
    (row, index) =>
      String(values[index][0]).trim() === row.category &&
      Number(values[index][1]) === row.count,
  );
}
