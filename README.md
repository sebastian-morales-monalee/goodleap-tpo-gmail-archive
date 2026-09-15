# GoodLeap TPO Gmail Archive

This project automates the collection and indexing of GoodLeap TPO email
messages, saves their attachments in Google Drive when present, and enriches
the archive with the corresponding Artemis Sales Project ID from PostHog. It
also classifies each archived email and extracts the two tabular datasets from
Shade Report PDFs through the OpenAI Responses API. Managed `AI Weekly
Summary` and `AI Dashboard` sheets preserve the weekly Primary Category
history and display an all-time Primary Category chart, a two-series stacked
historical chart that detects Production in `Categories`, and the eight most
recent individual Primary Category weeks. A deterministic `TOF Values
Comparison` sheet compares the Aurora PDF tables with the corresponding
Artemis project tables for each Project ID.

The implementation is designed for a standalone Google Apps Script project.
No web-app deployment is required.

## Architecture

```text
GoodLeap Google Group
        |
        v
User Gmail mailbox
        |
        v
Integrated trigger (every 5 minutes)
        |
        +-------------------------> Code.gs -> Drive + archive sheets
        |
        +--- pending batch each check -> OpenAIAnalysis.gs -> AI Analysis
        |                                      |
        |                                      `-> AIAnalysisDashboard.gs
        |                                              |-> AI Weekly Summary
        |                                              `-> AI Dashboard
        |                                      `-> ProjectIdSummary.gs
        |                                              `-> Project ID Summary
        |
        +--- pending Shade Reports -> OpenAIPdfExtraction.gs
        |                                  |-> PDF Analysis
        |                                  |-> Summary CSV
        |                                  |-> Monthly CSV
        |                                  `-> ProjectIdSummary.gs
        |
        +--- only after new mail -> PostHogSync.gs -> PostHog Projects
                                             |
                                             |-> PostHogSolarTables.gs
                                             |       `-> Project CSVs
                                             |               `-> TOFValuesComparison.gs
                                             |                       `-> Shade Reports Comparison
                                             `-> ProjectIdSummary.gs
                                             ^
                                             |
                              Hourly reconciliation fallback
```

`ManualBackfill.gs` is a one-time controlled path for the four historical
messages that were forwarded manually and therefore did not match the normal
Google Group delivery rules.

## Deployment assumptions

- The Google account that runs setup must receive the GoodLeap group messages
  in its own Gmail mailbox. Group membership alone is not sufficient if the
  messages are not delivered to that mailbox.
- Matching messages must be delivered through the configured GoodLeap group
  and contain a valid Case ID in the `00-00-000000` format. Attachments are
  optional.
- The operating account must be allowed to create files in My Drive,
  spreadsheets, Gmail labels, and installable Apps Script triggers.
- The operator must have access to the target PostHog environment and
  permission to create a Personal API Key for it.
- The operator must have access to an OpenAI API project with billing and
  permission to use the configured model.
- Installable triggers run as the Google account that creates them. A new owner
  must run the final trigger installer while signed in as the account that will
  operate the archive.
- A fresh independent deployment should use a new standalone Apps Script
  project and copy only the source files. Do not reuse another deployment's
  generated `GOODLEAP_ROOT_FOLDER_ID` or `GOODLEAP_SPREADSHEET_ID` values.
- No deployment, Apps Script library, advanced Google service, or separate
  Google Cloud project is required.

## Files

### `Code.gs`

The primary Gmail archive workflow.

It:

- Searches Gmail for messages sent to `goodleap-tpo@artemispower.com` and
  retains only those containing a valid GoodLeap Case ID.
- Extracts the Case ID and production fields from each message.
- Creates a `year/month/Case ID` folder hierarchy in Google Drive.
- Saves attachments when present and, when enabled, a plain-text copy of the
  email body.
- Maintains the `Emails`, `Attachments`, and `Errors` sheets.
- Stores both the personal Gmail message URL and the canonical Google Groups
  conversation URL when Google includes that conversation link in the message.
- Deduplicates Gmail messages by Gmail Message ID.
- Deduplicates attachments by message, attachment index, and SHA-1 hash.
- Can install the initial Gmail-only five-minute trigger before PostHog is
  configured.

Primary functions:

1. `setupGoodLeapArchive()`
2. `previewGoodLeapMatches()`
3. `processGoodLeapHistory()`
4. `processRecentGoodLeapEmails()`
5. `installGoodLeapTrigger()`
6. `removeGoodLeapTrigger()`
7. `previewGoogleGroupUrls()`
8. `backfillGoogleGroupUrls()`

### `ManualBackfill.gs`

A controlled, one-time importer for these four forwarded messages:

- `26-42-004485`
- `26-30-001387`
- `26-44-005345`
- `26-44-005256`

It does not modify the normal Gmail query and does not install a trigger. It
requires the Gmail label `GoodLeap/ManualBackfill` to be applied only to the
approved forwarded messages. It validates the original sender, subject, date,
attachment presence, and expected Case ID before writing anything.

Primary functions:

1. `setupGoodLeapManualBackfill()`
2. `previewGoodLeapManualBackfill()`
3. `processGoodLeapManualBackfill()`

Run this workflow only when a reviewed historical backfill is required.

### `OpenAIAnalysis.gs`

The independent email-classification workflow.

It:

- Reads the archived plain-text body from `Emails`, with the Drive TXT file and
  original Gmail message as fallbacks.
- Removes quoted reply history, Google Groups footer text, and common legal
  boilerplate before analysis.
- Sends the newest email content to the OpenAI Responses API with
  `store: false`.
- Uses strict Structured Outputs instead of parsing free-form prose.
- Creates and maintains the `AI Analysis` sheet automatically.
- Adds `Project ID` as column B and resolves it from `PostHog Projects` by
  Application ID for historical and future rows.
- Stores one row per Gmail Message ID, allowing multiple emails for one
  Application ID to retain separate analyses.
- Classifies one primary category plus every applicable secondary category.
- Extracts review type, review status, rejection reasons, steps to clear,
  production values, required evidence, technical notes, a concise summary,
  and a human-review flag.
- Records failed messages as `Error` without interrupting Gmail archiving or
  PostHog synchronization.
- Does not automatically retry failed rows, preventing repeated API calls. A
  reviewed retry function is available.

Primary functions:

1. `setupOpenAIEmailAnalysis()`
2. `testOpenAIConnection()`
3. `previewOpenAIEmailAnalysis()`
4. `analyzePendingGoodLeapEmailsWithOpenAI()`
5. `analyzeGoodLeapEmailHistoryWithOpenAI()`
6. `retryFailedOpenAIEmailAnalyses()`

The current taxonomy is multi-label and includes `Production`, `Layout`,
`Equipment`, `Shading / Site Conditions`, `Structure`, `Documentation`,
`Offset`, `Communication / Follow-up`, and `Other`.

### `AIAnalysisDashboard.gs`

The deterministic Primary Category reporting workflow.

It:

- Creates and maintains `AI Weekly Summary` and `AI Dashboard` automatically.
- Locates `Primary Category` and `Email Received At` by their headers instead
  of relying on fixed columns.
- Counts every non-empty Primary Category across all time and by Monday-to-
  Sunday week in the `America/Bogota` time zone.
- Preserves every historical weekly aggregate in `AI Weekly Summary`, ordered
  from the newest week to the oldest.
- Adds a visible `Weekly Category Matrix` beside the long-format weekly table.
  It includes every configured category, writes explicit zeroes for categories
  without emails in a week, and orders weeks chronologically for charting.
- Adds a visible `Weekly Production vs Other Categories` matrix. Each analyzed
  email is counted once: under `Production with other categories` when its
  multi-value `Categories` cell contains the exact Production category, or
  under `Other Categories without Production` otherwise. New and custom
  non-Production categories are included automatically.
- Displays one all-time chart, one two-series stacked chart covering the
  complete history, and the eight most recent individual weekly charts, for a
  maximum of ten charts in `AI Dashboard`.
- Shows the count inside each segment of the stacked chart, with a descriptive
  legend for both series. Production labels use a persistent high-contrast
  cyan color so weekly values remain visible after chart rebuilds.
- Keeps each category in a stable matrix column and chart color. Categories
  outside the configured taxonomy are appended deterministically for review.
- Keeps weekly chart positions fixed. During a visible week, source-range
  values change without rebuilding charts; chart objects are recreated only
  when the visible set of weeks or the managed layout changes.
- Records categorized rows with missing or invalid received dates in the
  all-time total and reports how many were excluded from weekly aggregation.
- Does not call OpenAI, Gmail, Drive, or PostHog.
- Refreshes safely after each automatic OpenAI analysis check through the
  existing five-minute workflow; dashboard errors cannot fail email analysis.

Primary functions:

1. `previewAIAnalysisDashboard()`
2. `setupAIAnalysisDashboard()`
3. `refreshAIAnalysisDashboard()`

### `ProjectIdSummary.gs`

The deterministic project-level rollup.

It:

- Creates and maintains `Project ID Summary` with one row per resolved Project
  ID from `PostHog Projects`.
- Copies the authoritative Project URL instead of constructing it, preserving
  the correct GoodLeap or Artemis Sales domain.
- Counts associated rows in `AI Analysis`, `Attachments`, and `PDF Analysis`.
- Shows the first and most recent `Email Received At` value for each project.
- Reads `map_data_source` and `rgb_basemap_url` from the GoodLeap project map
  source table, with Artemis Sales as fallback, and keeps the RGB URL
  clickable.
- Queries map metadata in batches only for new projects or rows whose map
  metadata is still incomplete. Previous successful values survive temporary
  PostHog errors.
- Omits Application ID and Organization from the reader-facing output.
- Sorts projects by Email Count and then by the most recent email.
- Refreshes safely after email-analysis, PDF-analysis, and PostHog project-sync
  workflows without adding another trigger. PostHog map lookups run only from
  the manual Project ID Summary refresh and the existing PostHog workflows.

Primary functions:

1. `previewProjectIdSummaryMapData()`
2. `previewProjectIdSummary()`
3. `setupProjectIdSummary()`
4. `refreshProjectIdSummary()`

### `OpenAIPdfExtraction.gs`

The independent Shade Report table-extraction workflow.

It:

- Selects the newest Shade Report PDF for each Application ID and records how
  many older or equivalent candidate files were suppressed.
- Sends the complete PDF to the OpenAI Responses API at high visual detail with
  `store: false` and a strict Structured Output schema.
- Inspects every page so a table that continues beyond page 1 remains in scope.
- Extracts every dynamic Array ID row; it does not assume that a report has a
  fixed number of arrays.
- Validates percentage, azimuth, pitch, panel-count, duplicate-ID, and
  cross-table consistency constraints before writing files.
- Creates `PDF Analysis` automatically with one tracking row per selected
  source PDF.
- Adds `Project ID` as column B and resolves it from `PostHog Projects` by
  Application ID for historical and future rows.
- Creates two CSV files beside the source PDF in Drive: `Summary` and
  `Monthly Solar Access Percentage Across Arrays`.
- Records unreadable cells and table inconsistencies for human review, while
  isolating failed PDFs from Gmail archiving and PostHog synchronization.

Primary functions:

1. `setupOpenAIPdfExtraction()`
2. `testOpenAIPdfConnection()`
3. `previewShadeReportPdfCandidates()`
4. `previewOpenAIPdfExtraction()`
5. `extractPendingShadeReportPdfsWithOpenAI()`
6. `extractShadeReportPdfHistoryWithOpenAI()`
7. `retryFailedOpenAIPdfExtractions()`

### `PostHogSync.gs`

The PostHog enrichment workflow.

It:

- Reads unique Case IDs from the `Emails` sheet.
- Treats each Case ID as a candidate GoodLeap Financier Application ID.
- Queries PostHog through the private HogQL query API.
- Queries `goodleap_postgres_financiers` first and sends only unmatched
  Application IDs to the `artemis_sales_postgres_financiers` fallback.
- Looks up the Artemis Sales Project ID.
- Writes `GoodLeap` as the organization for primary matches. For Sales
  fallback matches, joins the project to its organization and writes the
  organization name returned by PostHog.
- Constructs the Artemis project URL.
- Creates and maintains the `PostHog Projects` sheet automatically.
- Adds every saved Drive attachment to `PostHog Projects` as a clickable
  filename, with multiple files displayed on separate lines.
- Copies the exact or fallback Google Groups URL from `Emails` into the same
  operational project row.
- Preserves the previous matched value if a temporary API error occurs.
- Reports `Matched`, `Not Found`, `Multiple Matches`, or `Error` explicitly.
- Looks up new Application IDs immediately after new mail is archived.
- Retains a separate hourly reconciliation for delayed warehouse records and
  existing mappings.
- Propagates the latest Project ID mapping to `AI Analysis` and `PDF Analysis`
  after every successful PostHog synchronization.

The default warehouse mapping is:

| Business meaning | PostHog warehouse value |
| --- | --- |
| Financier Application ID | `goodleap_postgres_financiers.application_id` |
| Artemis Sales Project ID | `goodleap_postgres_financiers.project_id` |
| Fallback Application ID | `artemis_sales_postgres_financiers.application_id` |
| Fallback Project ID | `artemis_sales_postgres_financiers.project_id` |
| Sales project organization ID | `artemis_sales_postgres_projects.organization_id` |
| Sales organization name | `artemis_sales_postgres_organizations.name` |
| GoodLeap Project URL | `https://goodleap.artemis.solar/projects/{id}/proposal` |
| Artemis Sales Project URL | `https://sales.artemis.solar/projects/{id}/proposal` |

The tables and fields were confirmed through read-only PostHog schema
inspection and targeted HogQL verification. The GoodLeap URL shape is
consistent with existing project records in this repository. The returned row
values must still be confirmed with `previewPostHogProjectMatches()` before the
automated trigger is installed.

Primary functions:

1. `setupPostHogProjectSync()`
2. `testPostHogConnection()`
3. `inspectPostHogGoodLeapProjectSchema()`
4. `inspectPostHogGoodLeapDatabaseSchema()`
5. `previewPostHogProjectMatches()`
6. `syncPostHogProjects()`
7. `processRecentGoodLeapEmailsAndSyncPostHog()`
8. `installHybridGoodLeapPostHogTriggers()`
9. `installPostHogSyncTrigger()`
10. `removePostHogSyncTrigger()`
11. `syncProjectIdsToAnalysisSheets()`

### `PostHogSolarTables.gs`

The deterministic project-side solar table workflow.

It:

- Reads Project IDs already propagated to `PDF Analysis`.
- Queries `goodleap_postgres_projects.array_stats` first and uses
  `goodleap_postgres_solarpanels` to count active panels by `segment_index`.
- Falls back to the equivalent Artemis Sales projects and solar-panels tables
  only when the project is unavailable from GoodLeap.
- Reconstructs project-side Summary and Monthly Solar Access CSVs without
  calling OpenAI.
- Stores the CSVs beside the source Shade Report PDF in Drive and writes their
  links, source, synchronization time, status, and error detail to
  `PDF Analysis`.
- Preserves native project segment IDs and calculates panel-count-weighted
  annual Solar Access and TSRF values.
- Runs automatically inside each successful PostHog project reconciliation;
  it requires no third trigger.

Primary functions:

1. `setupPostHogSolarTableSync()`
2. `testPostHogSolarTableConnection()`
3. `previewPostHogSolarTableSync()`
4. `syncPostHogSolarTables()`
5. `previewPdfAnalysisComparisonCounts()`
6. `backfillPdfAnalysisComparisonCounts()`

### `TOFValuesComparison.gs`

The deterministic Aurora PDF versus Artemis project comparison workflow.

It:

- Reads the four existing Summary and Monthly CSV links from `PDF Analysis`;
  it does not reopen PDFs or call OpenAI.
- Keeps one canonical comparison per Project ID, using the newest
  `Source Received At` row when a project appears more than once.
- Matches arrays globally and one-to-one. Identical Panel Count is resolved
  first; the nearest remaining Panel Count is the primary fallback, while
  circular Azimuth and Pitch are tie-breakers and review checks.
- Completes the one-to-one assignment when Aurora and Artemis contain the same
  number of arrays. If their counts differ, only exact or reasonably close
  Panel Count candidates are paired and surplus arrays remain unmatched.
- Uses `Exact Panel and Geometry Match`, `Exact Panel Match`, `Probable Nearest
  Match`, and `Forced Nearest Match` to expose which rule produced each pair.
  TOF, Solar Access, TSRF, and monthly results never influence the match.
- Groups Artemis subarrays only when their shared Array ID prefix and common
  geometry make the grouping safe. Every original source row is used at most
  once.
- Uses Aurora and Artemis throughout the reader-facing headers and writes
  Artemis-minus-Aurora values for Panel Count, Azimuth, Pitch, annual TOF,
  annual Solar Access, annual TSRF, and Jan-Dec Solar Access.
- Preserves published weighted averages and also recalculates
  panel-count-weighted annual and monthly values from all original rows.
- Marks probable, grouped-probable, unmatched, incomplete, and invalid data
  for review instead of inventing an equivalence.
- Uses content fingerprints and a bounded rotating scan so changed CSVs are
  eventually recalculated without making the hourly workflow unbounded.
- Applies alternating project-level bands, strong project separators, and
  stable Aurora, Artemis, and Delta color families whenever rows are rewritten.
  Status and Error cells use restrained exception colors for faster review.
- Runs safely after project-side CSV synchronization and requires no new
  trigger or Script Property.

Primary functions:

1. `previewTOFValuesComparison()`
2. `setupTOFValuesComparison()`
3. `syncPendingTOFValuesComparisons()`
4. `refreshChangedTOFValuesComparisons()`
5. `refreshTOFValuesComparisonFormatting()`

## Script Properties

Open the Apps Script project, select **Project Settings**, and use the
**Script properties** section. Do not put these values in source code or in a
spreadsheet.

`.env.example` documents the available property names and safe example values.
Apps Script does not load `.env` files, so the required values must still be
added through **Project Settings > Script Properties**. Never place a real
Personal API Key in `.env.example` or commit a populated `.env` file.

### Obtain the OpenAI values

1. Sign in to the OpenAI API platform and select the API project that will own
   this automation's usage.
2. Create a project API key for this workflow and copy it once.
3. Add the key as `OPENAI_API_KEY` in Apps Script Script Properties.
4. Add `OPENAI_MODEL` with `gpt-5.4-mini` for email analysis.
5. Add `OPENAI_PDF_MODEL` with `gpt-5.4-mini` for PDF extraction. This is a
   model selector, not another API key; both workflows reuse `OPENAI_API_KEY`.

Never use a ChatGPT password or session token. API access, billing, and model
permissions belong to the selected OpenAI API project.

Required OpenAI properties:

| Property | Example | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | `sk-proj-...` | Project API key used only in the Authorization header |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Model used for structured email classification |
| `OPENAI_PDF_MODEL` | `gpt-5.4-mini` | Vision-capable model used for structured Shade Report PDF extraction |

Optional OpenAI properties:

| Property | Default | Purpose |
| --- | --- | --- |
| `OPENAI_ANALYSIS_BATCH_SIZE` | `10` | Maximum messages processed by each manual batch, limited to 20 |
| `OPENAI_MAX_EMAIL_CHARACTERS` | `30000` | Maximum cleaned characters sent from one email, limited to 100000 |
| `OPENAI_PDF_BATCH_SIZE` | `2` | Maximum representative PDFs processed per run, limited to 5 |
| `OPENAI_PDF_MAX_FILE_BYTES` | `15728640` | Maximum source PDF size accepted by the script, capped at 35 MiB |

### Obtain the three PostHog values

1. Sign in to PostHog and open the environment that contains the GoodLeap
   warehouse tables.
2. Obtain `POSTHOG_HOST` from the origin shown in the browser address bar:
   - US Cloud private API: `https://us.posthog.com`
   - EU Cloud private API: `https://eu.posthog.com`
   - Self-hosted: the origin of the self-hosted PostHog instance
3. Obtain `POSTHOG_PROJECT_ID` from the numeric segment in the environment URL.
   For example, `https://us.posthog.com/project/123456/home` uses `123456`.
4. Open **Settings > User > Personal API keys**. The direct US Cloud page is
   <https://us.posthog.com/settings/user-api-keys>.
5. Select **Create a personal API key**, give it a purpose-specific name such
   as `GoodLeap Apps Script read-only sync`, and grant only `query:read`.
6. Restrict organization/project access to the intended environment when that
   option is available.
7. Create the key and copy its `phx_...` value immediately. PostHog does not
   display the full value again after the page is refreshed.

This integration uses PostHog's private query endpoint. Do not substitute the
public project token used to capture events.

Required properties:

| Property | Example | Purpose |
| --- | --- | --- |
| `POSTHOG_HOST` | `https://us.posthog.com` | Private PostHog API origin |
| `POSTHOG_PROJECT_ID` | `123456` | Numeric PostHog environment ID |
| `POSTHOG_PERSONAL_API_KEY` | `phx_...` | Personal key with `query:read` |

Optional properties:

| Property | Default | Purpose |
| --- | --- | --- |
| `POSTHOG_GOODLEAP_LOOKUP_TABLE` | `goodleap_postgres_financiers` | Warehouse lookup table |
| `POSTHOG_ARTEMIS_SALES_LOOKUP_TABLE` | `artemis_sales_postgres_financiers` | Fallback warehouse lookup table |
| `POSTHOG_ARTEMIS_SALES_PROJECTS_TABLE` | `artemis_sales_postgres_projects` | Sales projects table |
| `POSTHOG_ARTEMIS_SALES_ORGANIZATIONS_TABLE` | `artemis_sales_postgres_organizations` | Sales organizations table |
| `POSTHOG_GOODLEAP_PROJECT_MAP_SOURCES_TABLE` | `goodleap_postgres_projectmapsources` | GoodLeap map metadata table |
| `POSTHOG_ARTEMIS_SALES_PROJECT_MAP_SOURCES_TABLE` | `artemis_sales_postgres_projectmapsources` | Sales fallback map metadata table |
| `POSTHOG_APPLICATION_ID_FIELD` | `application_id` | Financier Application ID field |
| `POSTHOG_GOODLEAP_PROJECT_ID_FIELD` | `project_id` | Artemis Project ID field |
| `POSTHOG_SOURCE_UPDATED_AT_FIELD` | `updated_at` | Source freshness field |
| `POSTHOG_ARTEMIS_SALES_PROJECT_ORGANIZATION_ID_FIELD` | `organization_id` | Sales project-to-organization field |
| `POSTHOG_ARTEMIS_SALES_ORGANIZATION_NAME_FIELD` | `name` | Sales organization display field |
| `POSTHOG_MAP_SOURCE_PROJECT_ID_FIELD` | `project_id` | Project identifier in map-source tables |
| `POSTHOG_MAP_DATA_SOURCE_FIELD` | `map_data_source` | RGB imagery provider field |
| `POSTHOG_RGB_BASEMAP_URL_FIELD` | `rgb_basemap_url` | RGB basemap URL field |
| `POSTHOG_MAP_SOURCE_UPDATED_AT_FIELD` | `updated_at` | Map metadata freshness field |
| `POSTHOG_PROJECT_URL_PREFIX` | `https://goodleap.artemis.solar/projects/` | URL prefix |
| `POSTHOG_ARTEMIS_SALES_PROJECT_URL_PREFIX` | `https://sales.artemis.solar/projects/` | Sales fallback URL prefix |
| `POSTHOG_PROJECT_URL_SUFFIX` | `/proposal` | URL suffix |
| `POSTHOG_GOODLEAP_PROJECTS_TABLE` | `goodleap_postgres_projects` | GoodLeap project solar statistics |
| `POSTHOG_GOODLEAP_SOLAR_PANELS_TABLE` | `goodleap_postgres_solarpanels` | GoodLeap active-panel records |
| `POSTHOG_ARTEMIS_SALES_SOLAR_PANELS_TABLE` | `artemis_sales_postgres_solarpanels` | Sales fallback active-panel records |
| `POSTHOG_SOLAR_PROJECT_ID_FIELD` | `id` | Project identifier in project tables |
| `POSTHOG_SOLAR_ARRAY_STATS_FIELD` | `array_stats` | JSON solar statistics by segment |
| `POSTHOG_SOLAR_SOURCE_UPDATED_AT_FIELD` | `updated_at` | Project data freshness field |
| `POSTHOG_SOLAR_PANEL_PROJECT_ID_FIELD` | `project_id` | Panel-to-project mapping field |
| `POSTHOG_SOLAR_PANEL_SEGMENT_FIELD` | `segment_index` | Panel array/segment identifier |
| `POSTHOG_SOLAR_PANEL_ACTIVE_FIELD` | `is_active` | Active-panel filter |
| `POSTHOG_SOLAR_PANEL_AZIMUTH_FIELD` | `azimuth` | Panel azimuth field |
| `POSTHOG_SOLAR_PANEL_PITCH_FIELD` | `pitch` | Panel pitch field |

Existing properties whose names start with `GOODLEAP_` are managed by
`Code.gs` and must not be removed.

Script Properties are not displayed in Sheets or committed with this source,
but Apps Script project editors can access them. Restrict editor access and
rotate the personal API key when access changes.

To add them in Apps Script:

1. Open **Project Settings** in the left sidebar.
2. Under **Script Properties**, select **Add script property**.
3. Add the required OpenAI and PostHog key/value pairs exactly as named in the
   tables above.
4. Select **Save script properties**.
5. Never add quotes around the values and never paste the key into a `.gs`
   file, Sheet cell, execution log, screenshot, or chat.

## First-time installation

For a standard deployment using the confirmed GoodLeap/PostHog schema, the
complete function order is:

| Order | Function | Defined in | Purpose |
| --- | --- | --- | --- |
| 1 | `setupGoodLeapArchive()` | `Code.gs` | Create or reuse the Drive folder, spreadsheet, sheets, and Gmail labels |
| 2 | `previewGoodLeapMatches()` | `Code.gs` | Inspect matching Gmail messages without writing archive data |
| 3 | `processGoodLeapHistory()` | `Code.gs` | Import existing matching messages and any available attachments |
| 4 | `setupPostHogProjectSync()` | `PostHogSync.gs` | Validate PostHog settings and create the derived sheet |
| 5 | `testPostHogConnection()` | `PostHogSync.gs` | Verify the private API connection without writing project data |
| 6 | `previewPostHogProjectMatches()` | `PostHogSync.gs` | Preview Application ID to Project ID matches |
| 7 | `syncPostHogProjects()` | `PostHogSync.gs` | Write the first verified project synchronization |
| 8 | `setupOpenAIEmailAnalysis()` | `OpenAIAnalysis.gs` | Validate OpenAI settings and create the AI Analysis sheet |
| 9 | `testOpenAIConnection()` | `OpenAIAnalysis.gs` | Verify API authentication, model access, and Structured Outputs |
| 10 | `previewOpenAIEmailAnalysis()` | `OpenAIAnalysis.gs` | Analyze one email without writing the AI Analysis sheet |
| 11 | `analyzePendingGoodLeapEmailsWithOpenAI()` | `OpenAIAnalysis.gs` | Write the first bounded historical analysis batch; rerun until pending is zero |
| 12 | `setupAIAnalysisDashboard()` | `AIAnalysisDashboard.gs` | Create Primary Category summaries plus the Categories-based Production-versus-other history and charts |
| 13 | `setupOpenAIPdfExtraction()` | `OpenAIPdfExtraction.gs` | Validate PDF settings and create PDF Analysis |
| 14 | `testOpenAIPdfConnection()` | `OpenAIPdfExtraction.gs` | Verify authentication, model access, and the PDF Structured Output schema |
| 15 | `previewShadeReportPdfCandidates()` | `OpenAIPdfExtraction.gs` | Review selected source PDFs and suppressed duplicates without an API call |
| 16 | `previewOpenAIPdfExtraction()` | `OpenAIPdfExtraction.gs` | Extract one complete PDF without writing a row or CSV files |
| 17 | `extractPendingShadeReportPdfsWithOpenAI()` | `OpenAIPdfExtraction.gs` | Write one bounded historical PDF batch; rerun until pendingPdfs is zero |
| 18 | `setupPostHogSolarTableSync()` | `PostHogSolarTables.gs` | Upgrade PDF Analysis and validate deterministic solar-table settings |
| 19 | `testPostHogSolarTableConnection()` | `PostHogSolarTables.gs` | Verify both GoodLeap and Sales project/panel schemas |
| 20 | `previewPostHogSolarTableSync()` | `PostHogSolarTables.gs` | Preview source and array counts without writing files |
| 21 | `syncPostHogSolarTables()` | `PostHogSolarTables.gs` | Generate the first historical project-side CSV files |
| 22 | `setupProjectIdSummary()` | `ProjectIdSummary.gs` | Create the project-level rollup and backfill map source metadata |
| 23 | `previewTOFValuesComparison()` | `TOFValuesComparison.gs` | Preview deterministic Aurora-versus-Artemis matching without writing the comparison sheet |
| 24 | `setupTOFValuesComparison()` | `TOFValuesComparison.gs` | Create and format the managed comparison sheet |
| 25 | `syncPendingTOFValuesComparisons()` | `TOFValuesComparison.gs` | Process one bounded historical comparison batch; rerun until pendingProjects is zero |
| 26 | `refreshTOFValuesComparisonFormatting()` | `TOFValuesComparison.gs` | Reapply project bands and Aurora/Artemis/Delta styling without rereading CSVs |
| 27 | `installHybridGoodLeapPostHogTriggers()` | `PostHogSync.gs` | Replace managed triggers with the final five-minute and hourly schedule |

Google Apps Script loads every `.gs` file into one shared runtime namespace,
but the editor's manual-run function selector is contextual to the currently
open source file. To run a function manually, first select the file shown in
the `Defined in` column, then select the function and click **Run**. Installed
triggers and calls between functions use the shared runtime namespace and do
not depend on which file is open in the editor.

Stop after any failed validation and resolve it before continuing. The manual
backfill and schema-inspection functions are exception workflows, not required
steps for every new deployment.

### 1. Create the Apps Script project

Create a standalone Google Apps Script project and set its time zone to
`America/Bogota`.

Add nine script files to the same project:

- `Code.gs`
- `ManualBackfill.gs`
- `PostHogSync.gs`
- `OpenAIAnalysis.gs`
- `AIAnalysisDashboard.gs`
- `ProjectIdSummary.gs`
- `OpenAIPdfExtraction.gs`
- `PostHogSolarTables.gs`
- `TOFValuesComparison.gs`

`README.md` is repository documentation and does not need to be pasted into
the Apps Script editor.

Before the first execution, review these values near the top of `Code.gs`:

| Setting | Required review |
| --- | --- |
| `GROUP_EMAIL` | Leave unchanged only if the target group address is the same |
| `GMAIL_QUERY` | Test this exact query in the target Gmail mailbox |
| `BACKFILL_AFTER` | Set earlier than the oldest existing message that must be imported |
| `TIMEZONE` | Keep aligned with the Apps Script project time zone |

`BACKFILL_AFTER` uses `YYYY/MM/DD`. It controls only the historical import;
the five-minute trigger uses the separate recent-message window.

Add the required PostHog and OpenAI Script Properties before running their
respective functions. Do not manually add any `GOODLEAP_*` properties; setup
creates those resource identifiers automatically.

### 2. Initialize the Gmail archive

Run these functions in order:

1. `setupGoodLeapArchive()`
2. `previewGoodLeapMatches()`
3. Review the execution log.
4. `processGoodLeapHistory()`
5. Review Drive and the three generated sheets.

Google will request Gmail, Drive, Sheets, and trigger permissions during the
first executions. Approve them using the Google account whose Gmail mailbox
receives the GoodLeap group messages.

Do not install a trigger yet. The hybrid installer in the final step creates
the complete schedule after both Gmail and PostHog have been validated.

The default historical safety limit is 500 matching Gmail threads. If the
preview or Gmail search indicates more than 500 matching threads, process the
history in reviewed date windows or increase the limit only after evaluating
Apps Script execution time and service quotas.

Do not click **Deploy**. Time-based triggers run the automation.

### 3. Run the historical forwarded-message patch, if needed

1. Run `setupGoodLeapManualBackfill()`.
2. In Gmail, apply `GoodLeap/ManualBackfill` only to the four approved
   forwarded messages.
3. Run `previewGoodLeapManualBackfill()`.
4. Confirm that all four expected Case IDs are present exactly once.
5. Run `processGoodLeapManualBackfill()`.
6. Review Drive and Sheets, then remove the manual Gmail label if desired.

Do not install a trigger for this one-time patch.

### 4. Validate PostHog before writing project results

Then run:

1. `setupPostHogProjectSync()`
2. Confirm that the `PostHog Projects` tab was created automatically.
3. `testPostHogConnection()`
4. Confirm that the log says `PostHog connection test passed.`
5. `previewPostHogProjectMatches()`

The preview is read-only. Review every `[MATCH]` line and compare at least one
Application ID, Project ID, and project URL with the PostHog user interface.

If the preview reports no matches, stop. Do not run the synchronization or
install its trigger. Run `inspectPostHogGoodLeapProjectSchema()` and
`inspectPostHogGoodLeapDatabaseSchema()` as metadata-only diagnostics. Inspect
the logged candidate fields and correct the optional table or field Script
Properties if the target environment uses a different schema.

### 5. Run the first synchronization

After the preview has been confirmed:

1. Run `syncPostHogProjects()`.
2. Open the `PostHog Projects` sheet.
3. Review the `Match Status`, `Match Count`, and `Error` columns.
4. Open at least one generated Project URL and confirm that it points to the
   expected Artemis Sales project.
5. Investigate every `Multiple Matches` or `Error` row before automation.

The derived sheet contains one row per unique Case ID. Do not add manual
columns or notes to this tab because its data area is rewritten during each
successful sync.

An attachment is not required for a valid project row. When a matching email
has no real attachment, `Emails.Attachment Count` is `0`, its attachment URL
cell remains empty, no row is added to `Attachments`, and `PostHog Projects`
still receives the Application ID, Project ID, and Project URL. Messages that
do not contain a valid Case ID are ignored, preventing general group messages
or tests from entering the archive.

Its managed columns are:

| Column | Value |
| --- | --- |
| `Application ID` | Case ID read from `Emails` |
| `Project ID` | Artemis project identifier returned by PostHog |
| `Organization` | `GoodLeap` for primary matches or the joined Sales organization name |
| `Project URL` | Direct Artemis proposal URL |
| `Attachment Links` | Clickable Drive filenames read from `Attachments` |
| `Google Group URL` | Exact conversation or Case-ID search link read from `Emails` |
| `Source Updated At` | PostHog warehouse update time |
| `Last Synced At` | Most recent reconciliation time |
| `Match Status` | `Matched`, `Not Found`, `Multiple Matches`, or `Error` |
| `Match Count` | Number of unique PostHog project matches |
| `Error` | Validation, query, or review detail |

Attachment links are matched by `Attachments.Case ID` to
`PostHog Projects.Application ID`. Duplicate Drive URLs are suppressed. A row
can show attachments even when its PostHog status is `Not Found`. Drive access
continues to follow the file and folder permissions already configured in
Google Drive.

Google Groups links are matched by `Emails.Case ID` to the same Application
ID. Duplicate URLs are suppressed. Exact `/c/{token}` conversation URLs take
precedence; when no exact URL exists, the Case-ID search fallback is displayed.

### 6. Validate OpenAI email and PDF workflows, then enable the schedule

Before installing the schedule, initialize and validate OpenAI:

1. Open `OpenAIAnalysis.gs` in the Apps Script editor.
2. Run `setupOpenAIEmailAnalysis()` and confirm that `AI Analysis` is created.
3. Run `testOpenAIConnection()` and confirm that the log reports a response ID
   without displaying the API key.
4. Run `previewOpenAIEmailAnalysis()` and review the classification. The
   preview consumes API tokens but does not write a row.
5. Run `analyzePendingGoodLeapEmailsWithOpenAI()` to write one historical
   batch.
6. Review the `AI Analysis` output. Rerun the same function until the execution
   log reports `pendingMessages: 0`.
7. Investigate every row marked `Error`. After correcting the cause, run
   `retryFailedOpenAIEmailAnalyses()` to retry only failed rows.
8. Open `AIAnalysisDashboard.gs`, run `previewAIAnalysisDashboard()`, and
   confirm that the logged all-time and weekly counts match `AI Analysis`.
9. Run `setupAIAnalysisDashboard()` and confirm that `AI Weekly Summary`
   contains the long weekly history, detailed Primary Category matrix, and
   Categories-based Production-versus-other matrix. Confirm that `AI Dashboard`
   contains one all-time chart, one two-series stacked historical chart, and up
   to eight weekly charts, newest first.

Next, initialize and validate Shade Report extraction:

1. Open `OpenAIPdfExtraction.gs` in the Apps Script editor.
2. Run `setupOpenAIPdfExtraction()` and confirm that `PDF Analysis` is created.
3. Run `testOpenAIPdfConnection()` and confirm that authentication, model
   access, and the strict schema pass without sending a Drive PDF.
4. Run `previewShadeReportPdfCandidates()` and verify the chosen filename for
   each Application ID and the number of omitted duplicates.
5. Run `previewOpenAIPdfExtraction()` and compare the logged Array IDs and row
   counts with one source report. This consumes API tokens but writes no row or
   CSV file.
6. Run `extractPendingShadeReportPdfsWithOpenAI()` to process one bounded
   historical batch. Rerun it until the log reports `pendingPdfs: 0`.
7. Review `PDF Analysis` and open both CSV links for reports containing one,
   three, or more Array IDs. Investigate rows marked `Error` or requiring human
   review. After correcting an error, run
   `retryFailedOpenAIPdfExtractions()` to retry only failed rows.

Only after the first manual sync is correct, run:

```text
installHybridGoodLeapPostHogTriggers()
```

This safely removes legacy or duplicate triggers managed by this project and
then creates exactly two:

- `processRecentGoodLeapEmailsAndSyncPostHog` every five minutes;
- `syncPostHogProjects` every hour.

The five-minute coordinator always checks Gmail and then processes bounded
batches of pending email analyses and Shade Report PDFs. When neither workflow
has pending work, no OpenAI request is created. PostHog is called immediately
only when at least one new message was archived. The hourly trigger retries
Application IDs that may not yet have reached the PostHog warehouse and
reconciles existing rows. The installer is idempotent and can be rerun without
accumulating duplicate triggers.

The Google account that runs this installer owns both triggers. Run it while
signed in as the account whose Gmail mailbox will be monitored.

`installPostHogSyncTrigger()` remains available when only the hourly fallback
needs to be recreated. It does not replace the five-minute coordinator.

### Migrating an existing two-trigger installation

For a project that already has the original Gmail-only five-minute trigger and
the PostHog hourly trigger:

1. Replace both `Code.gs` and `PostHogSync.gs` with the updated files.
2. Save the Apps Script project and wait until the save indicator completes.
3. Run `installHybridGoodLeapPostHogTriggers()` once.
4. Review the execution log and confirm that both new triggers were installed.
5. Open **Triggers** and confirm that exactly these two managed handlers exist:
   - `processRecentGoodLeapEmailsAndSyncPostHog`, every five minutes;
   - `syncPostHogProjects`, every hour.

Do not manually edit or delete the old managed triggers before step 3. The
installer removes every legacy or duplicate instance itself, while leaving
unrelated triggers untouched.

### Adding OpenAI analysis to an existing installation

An installation that already runs the five-minute Gmail/PostHog coordinator
does not need another trigger.

1. Create `OpenAIAnalysis.gs` in the same Apps Script project and paste the
   repository version. Save it before modifying the coordinator.
2. Add `OPENAI_API_KEY` and `OPENAI_MODEL` in Script Properties.
3. Run `setupOpenAIEmailAnalysis()`, `testOpenAIConnection()`, and
   `previewOpenAIEmailAnalysis()` from `OpenAIAnalysis.gs`.
4. Run `analyzePendingGoodLeapEmailsWithOpenAI()` repeatedly until
   `pendingMessages` is `0`, reviewing the bounded output after each batch.
5. Replace `PostHogSync.gs` with the repository version and save the project.
6. Do not reinstall the triggers. The existing
   `processRecentGoodLeapEmailsAndSyncPostHog` trigger resolves the new OpenAI
   function from the shared Apps Script runtime on its next five-minute run.
7. Confirm that the Triggers page still shows exactly the existing integrated
   five-minute trigger and hourly PostHog trigger.

The new `AI Analysis` tab is independent from `PostHog Projects`. It is keyed
by Gmail Message ID rather than Application ID, so several emails for the same
project preserve their own categories, status, reasons, and summary. Do not
insert, remove, rename, or reorder its managed columns.

### Adding AI Dashboard to an existing installation

No new Script Property or trigger is required.

1. Create or replace `AIAnalysisDashboard.gs` in the same Apps Script project
   with the repository version.
2. Confirm that `OpenAIAnalysis.gs` already calls
   `refreshAIAnalysisDashboardSafely_()` after each analysis batch. Replace it
   with the repository version only when upgrading from an older installation.
3. Save the Apps Script project.
4. Open `AIAnalysisDashboard.gs` and run `previewAIAnalysisDashboard()`.
   Confirm the logged all-time and weekly category counts.
5. Run `setupAIAnalysisDashboard()` once. Confirm that `AI Weekly Summary`
   contains every historical week in long and wide formats, including the
   Production-versus-other matrix. Confirm that `AI Dashboard` contains the
   all-time chart, the two-series stacked historical chart, and up to eight
   weekly charts, newest first.
6. Optionally delete the manually created `Temporal` sheet after validation;
   the managed dashboard does not read or modify it.
7. Do not reinstall or manually edit triggers. The existing five-minute
   coordinator reaches the refresh through `OpenAIAnalysis.gs`.
8. To rebuild the dashboard manually later, run
   `refreshAIAnalysisDashboard()`.

### Adding Project ID Summary to an existing installation

No new Script Property or trigger is required.

1. Replace `ProjectIdSummary.gs`, `PostHogSync.gs`, and
   `AIAnalysisDashboard.gs` with the repository versions.
2. Keep the existing `OpenAIAnalysis.gs` and `OpenAIPdfExtraction.gs`; their
   safe summary refresh calls remain compatible with the new columns.
3. Save the Apps Script project.
4. Open `ProjectIdSummary.gs` and run `previewProjectIdSummaryMapData()`.
   Confirm that known GoodLeap and Sales projects show the expected lookup
   source, map data source, and RGB URL. The preview does not write the sheet.
5. Run `previewProjectIdSummary()`. Confirm that the logged unique-project,
   email-row, and PDF-row totals match the source sheets.
6. Run `setupProjectIdSummary()` once. It safely appends `Map Data Source` and
   `RGB Basemap URL` to the legacy seven-column layout and backfills incomplete
   historical projects. Confirm that the RGB URLs are clickable.
7. Run `refreshProjectIdSummary()` a second time. The expected result includes
   `updated: false` and `unchanged: true` when no source data changed.
8. Run `refreshAIAnalysisDashboard()` once to rebuild the weekly stacked chart
   with the persistent visible Production data-label color.
9. Do not reinstall or edit triggers. The current five-minute and hourly
   workflows discover the new summary functions from the shared Apps Script
   runtime.

### Adding Shade Report PDF extraction to an existing installation

An installation that already has the integrated five-minute trigger does not
need a third trigger.

1. Create `OpenAIPdfExtraction.gs` in the same Apps Script project and paste
   the repository version. Save it before modifying the coordinator.
2. Keep the existing `OPENAI_API_KEY`; do not create or store a second key.
   Add `OPENAI_PDF_MODEL=gpt-5.4-mini` in Script Properties.
3. Run `setupOpenAIPdfExtraction()`.
4. Run `testOpenAIPdfConnection()`.
5. Run `previewShadeReportPdfCandidates()` and confirm the representative PDF
   chosen for each Application ID.
6. Run `previewOpenAIPdfExtraction()` and compare its output with the source
   PDF. The preview creates neither `PDF Analysis` data nor CSV files.
7. Run `extractPendingShadeReportPdfsWithOpenAI()` repeatedly until
   `pendingPdfs` is `0`, reviewing `PDF Analysis` and both CSV links.
8. Replace `PostHogSync.gs` with the repository version and save it.
9. Do not reinstall or edit the triggers. The existing
   `processRecentGoodLeapEmailsAndSyncPostHog` trigger resolves the new PDF
   function from the shared Apps Script runtime on its next five-minute run.
10. Confirm that the Triggers page still shows exactly the existing integrated
    five-minute trigger and hourly PostHog trigger.

The source selector processes the newest Shade Report PDF per Application ID.
The row count is dynamic: one, three, or more Array IDs are all valid. Older or
equivalent report attachments are not sent to OpenAI and are recorded as
suppressed duplicates in `PDF Analysis`.

### Adding project-side solar tables to an existing installation

No Sheet columns or triggers need to be created manually.

1. Add `PostHogSolarTables.gs` from this repository to the existing Apps
   Script project.
2. Replace `OpenAIPdfExtraction.gs` and `PostHogSync.gs` with the repository
   versions and save all files.
3. Run `setupPostHogSolarTableSync()`. It safely renames the existing PDF link
   headers and inserts the project link, source, timestamp, status, and error
   columns without moving historical row values incorrectly.
4. Run `testPostHogSolarTableConnection()` and confirm that both GoodLeap and
   Artemis Sales tests pass.
5. Run `previewPostHogSolarTableSync()` and verify at least one known Project
   ID, data source, and active array count.
6. Run `syncPostHogSolarTables()` once for the historical backfill.
7. Run `previewPdfAnalysisComparisonCounts()` to verify the PDF and project
   panel/array totals read from existing Drive CSVs without writing the Sheet.
8. Run `backfillPdfAnalysisComparisonCounts()` once. This makes no PostHog or
   OpenAI request and fills `PDF Panel Count`, `Project Panel Count`,
   `PDF Array Count`, and `Project Array Count` before the final `Error` column.
9. Open both new project CSV links and compare them with the corresponding PDF
   CSVs. Native project segment IDs may differ from the PDF's presentation IDs,
   and genuine differences can reflect a newer cloud design revision.
10. Do not add or replace triggers. The existing five-minute coordinator and
   hourly PostHog reconciliation automatically invoke the new workflow.

### Adding Shade Reports Comparison to an existing installation

No new Script Property or trigger is required.

1. Create `TOFValuesComparison.gs` in the same Apps Script project and paste
   the repository version.
2. Replace `PostHogSolarTables.gs` and `PostHogSync.gs` with the repository
   versions so project CSV creation invokes the comparison safely.
3. Save all Apps Script files.
4. Open `TOFValuesComparison.gs` and run
   `previewTOFValuesComparison()`. Confirm the Project ID, matched arrays, and
   unmatched-array counts for the previewed projects. The preview writes
   neither the Sheet nor Drive files.
5. Run `setupTOFValuesComparison()` once. The managed tab is now named
   `Shade Reports Comparison`. If only the legacy `TOF Values Comparison` tab
   exists, setup renames it in place so its data and Sheet ID are preserved.
   If both tabs exist, setup uses `Shade Reports Comparison` and leaves the
   legacy duplicate untouched for manual review. It also safely migrates an
   existing version 1 header row from PDF/Project terminology to
   Aurora/Artemis without shifting its data. Confirm that the managed tab has
   Aurora, Artemis, and Delta columns for the Summary metrics and all twelve
   months.
6. Run `refreshTOFValuesComparisonFormatting()` once to style every historical
   project block without rereading the source CSVs. Future comparison writes
   reapply the same style automatically.
7. Run `syncPendingTOFValuesComparisons()` repeatedly until the execution log
   reports `pendingProjects: 0`. Each run processes at most ten projects. A
   comparison-version change intentionally places every existing project back
   in this bounded queue.
8. Review every row marked `Review Required`, especially `Exact Panel Match`,
   `Probable Nearest Match`, `Forced Nearest Match`, grouped, or unmatched
   rows. A delta is always Artemis minus Aurora; percentage differences are
   percentage points.
9. Run `refreshChangedTOFValuesComparisons()` when an existing CSV is manually
   corrected and an immediate content-fingerprint check is needed. Automatic
   runs check existing projects in small rotating batches.
10. After `pendingProjects` reaches zero and the managed tab is verified,
    manually remove the legacy `TOF Values Comparison` duplicate if it still
    exists. The script never deletes or merges that duplicate automatically.
11. Do not reinstall or edit triggers. The existing PostHog reconciliation
   reaches the new workflow after rebuilding the project-side CSVs.

### Adding Project ID to existing AI Analysis and PDF Analysis sheets

Do not insert either column manually. The migration preserves all existing
rows and inserts `Project ID` automatically as column B:

- `AI Analysis`: `Gmail Message ID`, `Project ID`, `Application ID`, ...
- `PDF Analysis`: `Source Drive File ID`, `Project ID`, `Application ID`, ...

For an existing installation:

1. Replace `OpenAIAnalysis.gs`, `OpenAIPdfExtraction.gs`, and `PostHogSync.gs`
   with the repository versions and save the Apps Script project.
2. Run `syncProjectIdsToAnalysisSheets()` from `PostHogSync.gs` and review its
   `populatedRows`, `blankRows`, and `changedRows` statistics.
3. Verify one GoodLeap match, one Artemis Sales fallback match, and—if
   available—one `Multiple Matches` row. Multiple Project IDs remain on
   separate lines exactly as represented in `PostHog Projects`.
4. Confirm that the existing five-minute and hourly triggers remain unchanged.

`syncProjectIdsToAnalysisSheets()` makes no PostHog or OpenAI API request. It
uses the current contents of `PostHog Projects`. A blank value means that the
Application ID currently has no Project ID there. Future five-minute and hourly
PostHog synchronizations refresh both analysis sheets automatically, including
records that become available later. Running either OpenAI setup function is
also safe and idempotent, but it is not required for this migration.

### Adding Attachment Links to an existing installation

For an installation that still has `PostHog Projects` with the original
eight-column layout:

1. Replace only `PostHogSync.gs` with the updated repository version and save.
2. Run `setupPostHogProjectSync()` once. It detects the exact legacy header
   sequence and inserts `Organization` as column C, `Attachment Links` as
   column E, and `Google Group URL` as column F automatically.
3. Run `syncPostHogProjects()` once to populate both historical link columns.
4. Verify at least one row with a single file and one with multiple files.
5. Confirm that the existing five-minute and hourly triggers remain present.

Do not insert the column manually and do not reinstall the triggers. The setup
function is idempotent: after migration, later executions validate the current
eleven-column structure without adding another column.

### Adding Google Group URLs to an existing installation

The `Emails` sheet includes two separate links:

- `Gmail URL` opens the message in the operating account's Gmail mailbox.
- `Google Group URL` opens either the canonical conversation or a search scoped
  to the Case ID within the GoodLeap Google Group.

The Google Groups conversation token is generated by Google and cannot be
derived from the Case ID. `Code.gs` first extracts it from `List-Archive` or
from a matching conversation link in the email content. When Google did not
preserve that link, it uses this deterministic fallback:

`https://groups.google.com/a/artemispower.com/g/goodleap-tpo/search?q={Case ID}`

The fallback opens the group already filtered to the relevant Application ID.
If Google later supplies an exact `/c/{token}` link, rerunning the backfill
upgrades the fallback without overwriting existing exact URLs.

To upgrade an existing installation:

1. Replace `Code.gs` and `ManualBackfill.gs` with the updated versions and save.
2. Run `setupGoodLeapArchive()` once. It detects the original `Emails` schema
   and inserts `Google Group URL` directly after `Gmail URL`.
3. Run `previewGoogleGroupUrls()` and review `[EXACT]` and `[FALLBACK]` results.
   This function does not update existing rows.
4. Run `backfillGoogleGroupUrls()` once to populate the new column from each
   row's stored Gmail Message ID.
5. Review every `[NOT FOUND]` result. Valid Case IDs should normally receive at
   least a fallback search URL.

Both setup and backfill are idempotent. Existing values are preserved, rows
are not duplicated, and the installed triggers do not need to be recreated.
Future emails receive `Google Group URL` during normal processing.

### Adding Google Group URL to an existing PostHog Projects sheet

For an installation that already has the nine-column `PostHog Projects` layout
with `Attachment Links`:

1. Replace only `PostHogSync.gs` with the updated version and save.
2. Run `setupPostHogProjectSync()` once. It inserts `Organization` as column C
   and `Google Group URL` as column F, shifting the remaining columns safely.
3. Run `syncPostHogProjects()` once to populate historical group links from
   `Emails`.
4. Verify one exact or fallback link and confirm the remaining data columns are
   still aligned.

Do not insert the column manually and do not reinstall the triggers. The
five-minute coordinator and hourly reconciliation use the updated sync
automatically.

### Enabling the Artemis Sales fallback in an existing installation

The fallback is implemented entirely in `PostHogSync.gs`; it does not require
a new trigger.

1. Replace `PostHogSync.gs` with the current repository version and save it.
2. Run `setupPostHogProjectSync()` once. Confirm that the execution log lists
   the financiers, projects, and organizations tables for Artemis Sales.
3. Run `previewPostHogProjectMatches()`. A fallback result ends with
   `Artemis Sales` in the `[MATCH]` log line.
4. Run `syncPostHogProjects()` once to refresh historical `Not Found` rows.
5. Confirm that a known Sales-only Application ID changes from `Not Found` to
   `Matched`, uses `https://sales.artemis.solar/projects/{id}/proposal`, and
   opens successfully.

No Script Property is required for the confirmed default table. Add
`POSTHOG_ARTEMIS_SALES_LOOKUP_TABLE` only when a deployment needs to override
that table name. The Sales URL prefix also defaults automatically; use
`POSTHOG_ARTEMIS_SALES_PROJECT_URL_PREFIX` only when a deployment needs a
different Sales origin. Do not reinstall the triggers: the existing
five-minute and hourly handlers automatically execute the updated lookup logic.

### Adding Organization to an existing PostHog Projects sheet

For an installation that already has the current ten-column layout:

1. Replace only `PostHogSync.gs` with the current repository version and save.
2. Run `setupPostHogProjectSync()` once. It detects the exact ten-column header
   sequence and inserts `Organization` between `Project ID` and `Project URL`.
3. Run `previewPostHogProjectMatches()`. GoodLeap results should display
   `GoodLeap`; Sales fallback results should display the joined organization
   name in each `[MATCH]` log line.
4. Run `syncPostHogProjects()` once to populate the new column for all
   historical rows.
5. Verify that attachment and Google Groups hyperlinks still occupy columns E
   and F and remain clickable.

The setup function is idempotent and does not insert duplicate columns. Do not
add the column manually and do not reinstall either trigger.

To remove only the hourly fallback, run:

```text
removePostHogSyncTrigger()
```

The integrated five-minute trigger can still call PostHog after new mail. To
stop all PostHog calls while keeping Gmail automation, run
`removePostHogSyncTrigger()` and then `installGoodLeapTrigger()`.

## Normal operation

- Every five minutes, the coordinator asks `Code.gs` to check for new GoodLeap
  Gmail messages.
- New message metadata and any available attachments are archived in Drive and
  Sheets. Messages with a valid Case ID are retained even with zero attachments.
- After each successful Gmail check, `OpenAIAnalysis.gs` classifies a bounded
  batch of not-yet-analyzed messages and adds one row per Gmail Message ID to
  `AI Analysis`. No API call is made when the pending batch is empty.
- After each analysis check, `AIAnalysisDashboard.gs` compares the current
  Primary Category counts and `Email Received At` weeks with both managed
  reporting sheets. `AI Weekly Summary` keeps the complete Primary Category
  history and classifies each valid weekly row as Production or Other
  Categories by inspecting the multi-value `Categories` field. That two-series
  range drives the stacked historical chart. `AI Dashboard` shows one all-time,
  one stacked-history, and up to eight recent weekly charts.
  Existing chart objects remain in place while only counts change within the
  same visible weeks.
- `ProjectIdSummary.gs` maintains one row per resolved project with its
  authoritative URL, email count, attachment count, analyzed-PDF count, and
  first and most recent email timestamps. It also resolves map data source and
  RGB basemap URL from GoodLeap with Artemis Sales fallback. It refreshes after
  the AI email, PDF, and PostHog workflows and does not require another trigger.
- An OpenAI error is written to that message's analysis row and does not block
  the following PostHog synchronization. Failed rows require an explicit
  reviewed retry.
- After each successful Gmail check, `OpenAIPdfExtraction.gs` selects a bounded
  batch of not-yet-extracted Shade Report PDFs. It writes `PDF Analysis` and
  creates Summary and Monthly CSV files beside each source PDF in Drive. No PDF
  API call is made when the pending batch is empty.
- Each Application ID uses its newest Shade Report candidate. Suppressed older
  or equivalent PDFs are counted, and all Array ID rows found across every
  relevant page are retained.
- Each new `Emails` row receives its exact Google Groups conversation URL when
  that link is available in the source message.
- When new messages were archived, `PostHogSync.gs` immediately refreshes the
  derived project lookup and its Drive attachment links.
- Every hour, `PostHogSync.gs` performs the same reconciliation as a fallback.
- Every successful PostHog reconciliation refreshes `Project ID` in both
  analysis sheets by matching their `Application ID` values. `Not Found` rows
  remain blank until a later synchronization returns a Project ID.
- After Project IDs are refreshed, `PostHogSolarTables.gs` rebuilds the
  project-side Summary and Monthly CSVs from structured PostHog data. GoodLeap
  is queried first and Artemis Sales is the fallback. The CSVs are stored in
  the same project Drive folder as the Shade Report.
- After the four source CSV links exist, `TOFValuesComparison.gs` compares the
  newest PDF Analysis source for each Project ID. It writes deterministic
  Summary and Jan-Dec deltas, preserves both published and recalculated
  weighted averages, and routes uncertain matches to human review.
- New PDF rows store total PDF panel and array counts directly from the
  structured extraction. Project synchronization stores the corresponding
  active project panel and array counts directly from PostHog data. Historical
  rows can be populated from their existing Drive CSVs without another API
  request.
- Both workflows use the same Apps Script lock, preventing overlapping writes.
- Empty Gmail checks do not create PostHog requests.
- The PostHog sync sends Application IDs only; it does not send email bodies,
  attachments, addresses, or Drive links to PostHog.

## Ready-for-operation checklist

The deployment is ready only when all of the following are true:

- `previewGoodLeapMatches()` finds the intended messages in the target mailbox.
- Historical messages appear once in `Emails` and their files open from Drive.
- `testPostHogConnection()` passes.
- `previewPostHogProjectMatches()` returns at least one verified match.
- `syncPostHogProjects()` populates Project IDs and valid Artemis URLs.
- `testOpenAIConnection()` passes and does not expose the API key.
- `previewOpenAIEmailAnalysis()` returns a reasonable classification.
- `AI Analysis` contains one successful row for every intended historical
  Gmail Message ID, with no unexplained `Error` rows.
- `AI Weekly Summary` contains all Monday-to-Sunday category aggregates in
  long and wide formats. Each detailed row and each Categories-based
  Production-versus-other row sums to its weekly total.
- `AI Dashboard` shows no more than ten charts: one all-time, one stacked
  historical Production-versus-other comparison, and eight individual weekly
  charts.
- `testOpenAIPdfConnection()` passes and does not expose the API key.
- `previewOpenAIPdfExtraction()` returns all visible Array IDs for a verified
  Shade Report.
- `PDF Analysis` links to valid Summary and Monthly CSV files and has no
  unexplained `Error` or human-review rows.
- `testPostHogSolarTableConnection()` passes for GoodLeap and Artemis Sales,
  and `PDF Analysis` links to valid project-side Summary and Monthly CSVs with
  an explained `Project Data Status`.
- `PDF Analysis` shows PDF and project panel/array totals before `Error`, and
  the values equal the non-weighted rows in the corresponding Summary CSVs.
- `AI Analysis` and `PDF Analysis` contain the same Project ID shown for their
  Application ID in `PostHog Projects`, or remain blank when it is `Not Found`.
- `Project ID Summary` contains one row per resolved Project ID, uses the URL
  from `PostHog Projects`, reconciles its email and PDF counts with the two
  analysis sheets, and shows the PostHog map source plus a clickable RGB
  basemap URL when available.
- `Shade Reports Comparison` contains no duplicate Project ID blocks and its
  Aurora and Artemis source links open correctly. Exact Panel matches outside
  the geometry thresholds, probable or forced matches, and unmatched rows are
  marked `Review Required`. Every contiguous Project ID block shares a visual
  band, adjacent projects alternate colors, and Aurora, Artemis, and Delta
  columns retain their distinct header and body palettes.
- The **Triggers** page shows one
  `processRecentGoodLeapEmailsAndSyncPostHog` five-minute trigger and one
  `syncPostHogProjects` hourly trigger owned by the operating account.
- There are no unresolved rows marked `Error` or unexplained
  `Multiple Matches` in `PostHog Projects`.

`Not Found` means the Application ID was absent from both the GoodLeap and
Artemis Sales financier tables at query time. The hourly reconciliation retries
it. Apps Script may run more frequently than the warehouse source refresh, so a
new source record can remain temporarily unavailable in PostHog.

## Replication in another account

1. Confirm that the target account receives the group messages in Gmail and
   can access the intended PostHog environment.
2. Copy the nine `.gs` files into a new standalone Apps Script project.
3. Review the Gmail query, historical start date, and time zone.
4. Obtain a new purpose-specific PostHog Personal API Key; do not reuse another
   person's key.
5. Create a purpose-specific OpenAI project API key and add the required
   OpenAI and PostHog Script Properties.
6. Run the Gmail setup, preview, and historical import sequence.
7. Run the PostHog setup, connection test, preview, and first synchronization.
8. Run the OpenAI email setup, connection test, preview, and bounded historical
   analysis.
9. Run the AI Dashboard preview and setup functions.
10. Run the OpenAI PDF setup, connection test, candidate preview, extraction
   preview, and bounded historical extraction. Review both generated CSVs.
11. Run the PostHog solar-table setup, connection test, preview, and historical
    synchronization. Review both project-side CSVs.
12. Run the TOF comparison preview, setup, and bounded historical sync. Review
    probable, grouped, and unmatched rows.
13. Use the schema inspection functions only if the default mapping fails in
   the target environment.
14. After all workflows have been validated, run
   `installHybridGoodLeapPostHogTriggers()`.
15. Confirm that exactly one integrated five-minute trigger and one hourly
   PostHog trigger exist.

All Drive folders, Sheets tabs, Gmail labels, and time-based triggers are
created by setup functions. They do not need to be created manually.

## Troubleshooting

### HTTP 401, 403, or model-access error from OpenAI

- Verify that `OPENAI_API_KEY` contains an active API project key and has no
  surrounding quotes or spaces.
- Verify that the selected API project has billing enabled and permission to
  use the exact `OPENAI_MODEL` and `OPENAI_PDF_MODEL` values.
- Run `testOpenAIConnection()` and `testOpenAIPdfConnection()` again after
  replacing or rotating the key.
- Do not paste the key into execution logs while diagnosing the request.

### HTTP 429 or OpenAI quota error

- Review the OpenAI API project's usage limits and billing status.
- Reduce `OPENAI_ANALYSIS_BATCH_SIZE` before a historical backfill.
- Reduce `OPENAI_PDF_BATCH_SIZE` before a PDF historical backfill.
- Wait for the applicable rate-limit window, then run
  `retryFailedOpenAIEmailAnalyses()` once.
- Successful Gmail, Drive, Sheets, and PostHog work remains valid; do not rerun
  the email import to retry only the AI layer.

### An AI Analysis row is marked `Error`

- Read the row's `Error` cell and correct authentication, quota, model, or
  source-body issues.
- Run `retryFailedOpenAIEmailAnalyses()` to retry only rows marked `Error`.
- Do not delete successful rows and do not run the historical Gmail import as
  an AI retry mechanism.

### A PDF Analysis row is marked `Error`

- Read the row's `Error` cell and correct authentication, quota, model, Drive
  access, file-size, or source-PDF issues.
- Verify that `OPENAI_PDF_MAX_FILE_BYTES` is large enough for the report but no
  larger than required. The script caps this setting at 35 MiB to leave Apps
  Script headroom for Base64 encoding and request serialization.
- Run `retryFailedOpenAIPdfExtractions()` to retry only rows marked `Error`.
- Do not delete successful rows or rerun the Gmail import as a PDF retry.

### No Shade Report PDF candidate is found

- Confirm that the file appears in `Attachments`, has a Drive File ID, and is a
  PDF whose filename contains both `Shade` and `Report`.
- Run `previewShadeReportPdfCandidates()` before making any API request.
- If the supplier changes its naming convention, review and update
  `isOpenAIShadeReportFilename_()` deliberately; do not broaden it to every PDF
  without evaluating cost and data scope.

### A PDF row requires human review

- Open the source PDF and compare every Array ID across both tables and all
  reported source pages.
- Human review is expected when a value is unreadable, an Array ID appears in
  only one table, or the model explicitly reports uncertainty.
- The CSV files retain blank cells for unreadable values instead of inventing
  numbers.

### HTTP 401 or 403 from PostHog

- Verify that the key is a Personal API Key, not a public project token.
- Verify that it has `query:read` access to the configured environment.
- Verify `POSTHOG_PROJECT_ID` and `POSTHOG_HOST`.
- If the key was rolled or deleted, update the Script Property.

### The preview returns no matches

- Run `inspectPostHogGoodLeapProjectSchema()`.
- Run `inspectPostHogGoodLeapDatabaseSchema()` and review the candidate fields
  and joins.
- Confirm that `goodleap_postgres_financiers.application_id` represents the
  Case ID format found in `Emails`.
- Confirm that `artemis_sales_postgres_financiers.application_id` contains the
  expected Sales Artemis fallback records.
- If the warehouse mapping changes, update the optional lookup table or field
  Script Properties and rerun the preview.
- Do not install the PostHog trigger until at least one known project matches.

### A project exists only in Artemis Sales

No manual action is required. The lookup checks GoodLeap first. Only IDs with
zero GoodLeap matches are queried in `artemis_sales_postgres_financiers`. A
Sales match populates the same Project ID and Project URL columns and reports
`Matched`. It also joins `artemis_sales_postgres_projects.organization_id` to
`artemis_sales_postgres_organizations.id` and writes the organization's
`name`. GoodLeap matches use organization `GoodLeap` and the
`goodleap.artemis.solar` origin; fallback matches use the joined organization
name and the `sales.artemis.solar` origin. If both sources return zero rows,
the status remains `Not Found`.

If the Sales project exists but its organization relation or name is missing,
the project remains `Matched`, the `Organization` cell stays empty, and the
execution log includes `[ORGANIZATION NOT FOUND]` for that Application ID.

PostHog currently refreshes these warehouse tables on its own source schedule.
The five-minute Apps Script trigger cannot expose a source row before PostHog
has synchronized it; the hourly reconciliation retries delayed records.

### `Multiple Matches`

More than one unique Artemis Project ID has the same Application ID. The sheet
lists every matching ID, organization, and URL on corresponding separate
lines. Review the source data; the script intentionally does not choose one
silently.

### Temporary API error

The row is marked `Error`. If it had a previous successful match, the old
Project ID, organization, and URL are preserved. Run `syncPostHogProjects()`
again after the API or permission issue is resolved.

### Another execution is running

The run is skipped safely because the Gmail archive or another PostHog sync
currently holds the shared Apps Script lock. The next scheduled run will retry.

## Security and data handling

- Never paste the OpenAI API key into source code, Sheets, chat, screenshots,
  or execution logs. Store it only in Apps Script Script Properties.
- Never paste the PostHog Personal API Key into source code, Sheets, chat, or
  screenshots.
- Give the key only `query:read` and restrict it to the required PostHog
  environment when possible.
- Keep the Apps Script editor list limited because editors can access Script
  Properties.
- Rotate either key if its owner leaves the project or exposure is suspected.
- The email-analysis request sends the cleaned newest email body plus the
  Application ID, sender, subject, extracted production fields, and review
  type. It does not send Drive attachments or PostHog data.
- The PDF-extraction request sends the selected complete Shade Report PDF plus
  its Application ID and filename to OpenAI. Older suppressed duplicates,
  unrelated attachments, email bodies, and PostHog data are not sent by that
  request.
- OpenAI requests set `store: false`. Applicable API data controls and retention
  still depend on the OpenAI organization's configuration and current terms.
- The scripts never delete, archive, or mark Gmail messages as read.
- The scripts do not delete Drive files or archive sheets.

## Reference documentation

- [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [OpenAI GPT-5.4 mini model](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
- [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs)
- [PostHog API overview](https://posthog.com/docs/api)
- [PostHog Personal API keys](https://posthog.com/docs/api/personal-api-keys)
- [Google Apps Script Properties Service](https://developers.google.com/apps-script/guides/properties)
- [Google Apps Script installable triggers](https://developers.google.com/apps-script/guides/triggers/installable)
