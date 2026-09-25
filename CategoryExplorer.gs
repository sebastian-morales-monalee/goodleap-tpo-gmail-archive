/**
 * GoodLeap TPO - one-category project explorer.
 *
 * This file belongs in the same Apps Script project as ProjectIdSummary.gs
 * and OpenAIAnalysis.gs. The explorer reads Project ID Summary only; changing
 * its selector never calls OpenAI or rebuilds the project summary.
 */

const CATEGORY_EXPLORER_CONFIG = {
  SHEET_NAME: 'Category Explorer',
  SOURCE_SHEET_NAME: 'Project ID Summary',
  DEFAULT_CATEGORY: 'Production',
  HEADER_BACKGROUND: '#7200c9',
  HEADER_FONT_COLOR: '#ffffff',
  INPUT_BACKGROUND: '#fff2cc',
  TAB_COLOR: '#7200c9',
  FIRST_RESULT_ROW: 8,
  RESULT_HEADERS: [
    'Project ID',
    'Application ID',
    'Project URL',
    'Categories',
    'Status',
    'Region',
    'AI Summary',
  ],
};

/**
 * Creates or repairs the live category selector and formula-driven results.
 * Run once after setupProjectIdSummary() on a new installation. It is safe to
 * rerun and preserves a valid category already selected by the user.
 */
function setupCategoryExplorer() {
  const spreadsheet = getOrCreateResources_().spreadsheet;
  const source = spreadsheet.getSheetByName(
    CATEGORY_EXPLORER_CONFIG.SOURCE_SHEET_NAME,
  );
  if (!source || source.getLastColumn() === 0) {
    throw new Error(
      'Project ID Summary is missing. Run setupProjectIdSummary() first.',
    );
  }

  const headers = source.getRange(1, 1, 1, source.getLastColumn())
    .getDisplayValues()[0].map((value) => String(value).trim());
  const required = CATEGORY_EXPLORER_CONFIG.RESULT_HEADERS;
  required.forEach((header) => {
    if (headers.indexOf(header) < 0) {
      throw new Error('Project ID Summary is missing the ' + header + ' column.');
    }
  });

  const config = CATEGORY_EXPLORER_CONFIG;
  let sheet = spreadsheet.getSheetByName(config.SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(config.SHEET_NAME);

  const existingTitle = String(sheet.getRange('A1').getDisplayValue()).trim();
  const existingHeaders = sheet.getRange('A7:G7').getDisplayValues()[0]
    .map((value) => String(value).trim());
  if (
    (existingTitle && existingTitle !== config.SHEET_NAME) ||
    !categoryExplorerHasCompatibleHeaders_(existingHeaders, required)
  ) {
    throw new Error(
      'Category Explorer already has an unexpected layout. Review it before ' +
      'running setup so existing data is not overwritten.',
    );
  }

  // Reserve only the rows needed for the same 5,000-project limit used by the
  // source summary. The formula does not scan entire spreadsheet columns.
  const maxProjects = PROJECT_ID_SUMMARY_CONFIG.MAX_PROJECT_IDS_PER_SYNC;
  const lastResultRow = config.FIRST_RESULT_ROW + maxProjects - 1;
  if (sheet.getMaxRows() < lastResultRow) {
    sheet.insertRowsAfter(sheet.getMaxRows(), lastResultRow - sheet.getMaxRows());
  }

  const categories = OPENAI_ANALYSIS_CATEGORIES.slice();
  const selector = sheet.getRange('B3');
  const selected = String(selector.getDisplayValue()).trim();
  selector.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(categories, true)
      .setAllowInvalid(false)
      .build(),
  );
  if (categories.indexOf(selected) < 0) {
    selector.setValue(config.DEFAULT_CATEGORY);
  }

  sheet.getRange('A1').setValue(config.SHEET_NAME);
  sheet.getRange('A3').setValue('Category');
  sheet.getRange('D3').setValue('Projects found');
  sheet.getRange('A5').setValue('Source: latest email categories');
  sheet.getRange('A7:G7').setValues([required]);
  sheet.getRange('E3').setFormula(
    '=IF($B$3="","",COUNTIF($A$8:$A,"?*"))',
  );
  sheet.getRange('A8').setFormula(
    buildCategoryExplorerFilterFormula_(
      headers,
      config.SOURCE_SHEET_NAME,
      maxProjects + 1,
    ),
  );

  sheet.getRange('A1:G1')
    .setBackground(config.HEADER_BACKGROUND)
    .setFontColor(config.HEADER_FONT_COLOR)
    .setFontWeight('bold')
    .setFontSize(14);
  sheet.getRange('A7:G7')
    .setBackground(config.HEADER_BACKGROUND)
    .setFontColor(config.HEADER_FONT_COLOR)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);
  selector.setBackground(config.INPUT_BACKGROUND);
  sheet.getRange('E3').setFontWeight('bold');
  sheet.getRange('D8:D' + lastResultRow).setWrap(true);
  sheet.getRange('G8:G' + lastResultRow).setWrap(true);
  sheet.setFrozenRows(7);
  sheet.setFrozenColumns(1);
  sheet.setTabColor(config.TAB_COLOR);
  [280, 220, 450, 320, 190, 140, 550].forEach((width, index) => {
    sheet.setColumnWidth(index + 1, width);
  });
  sheet.setRowHeight(1, 32);
  sheet.setRowHeight(7, 38);

  const result = {
    sheet: config.SHEET_NAME,
    selectedCategory: String(selector.getDisplayValue()).trim(),
    projectsFound: sheet.getRange('E3').getValue(),
    sourceLastRow: source.getLastRow(),
  };
  console.log(JSON.stringify(result));
  return result;
}

/** Accepts an empty tab, the previous six-column view, or the current view. */
function categoryExplorerHasCompatibleHeaders_(existing, required) {
  if (existing.every((value) => !value)) return true;
  const previous = required.slice(0, -1);
  const matchesPrevious = previous.every((value, index) =>
    existing[index] === value) && !existing[previous.length];
  const matchesCurrent = required.every((value, index) =>
    existing[index] === value);
  return matchesPrevious || matchesCurrent;
}

/** Builds an exact, semicolon-delimited category filter for Google Sheets. */
function buildCategoryExplorerFilterFormula_(headers, sourceSheetName, endRow) {
  const escapedName = String(sourceSheetName).replace(/'/g, "''");
  const sourceName = "'" + escapedName + "'";
  const rangeFor = (header) => {
    const index = headers.indexOf(header);
    if (index < 0) throw new Error('Missing source column: ' + header + '.');
    const letter = categoryExplorerColumnLetter_(index + 1);
    return sourceName + '!$' + letter + '$2:$' + letter + '$' + endRow;
  };
  const resultRanges = CATEGORY_EXPLORER_CONFIG.RESULT_HEADERS.map(rangeFor);
  const projectIds = rangeFor('Project ID');
  const categories = rangeFor('Categories');
  const tokenPattern = '"(^|;\\s*)"&$B$3&"(\\s*;|$)"';
  return '=IF($B$3="","",IFNA(FILTER({' + resultRanges.join(',') + '},' +
    projectIds + '<>"",REGEXMATCH(' + categories + ',' + tokenPattern +
    ')),""))';
}

function categoryExplorerColumnLetter_(column) {
  let remaining = column;
  let result = '';
  while (remaining > 0) {
    remaining--;
    result = String.fromCharCode(65 + remaining % 26) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}
