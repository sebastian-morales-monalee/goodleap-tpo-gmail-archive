# GoodLeap TPO Gmail Archive

This project automates the collection and indexing of GoodLeap TPO email
messages, saves their attachments in Google Drive when present, and enriches
the archive with the corresponding Artemis Sales Project ID from PostHog.

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
        +--- only after new mail -> PostHogSync.gs -> PostHog Projects
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

## Script Properties

Open the Apps Script project, select **Project Settings**, and use the
**Script properties** section. Do not put these values in source code or in a
spreadsheet.

`.env.example` documents the available property names and safe example values.
Apps Script does not load `.env` files, so the required values must still be
added through **Project Settings > Script Properties**. Never place a real
Personal API Key in `.env.example` or commit a populated `.env` file.

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
| `POSTHOG_APPLICATION_ID_FIELD` | `application_id` | Financier Application ID field |
| `POSTHOG_GOODLEAP_PROJECT_ID_FIELD` | `project_id` | Artemis Project ID field |
| `POSTHOG_SOURCE_UPDATED_AT_FIELD` | `updated_at` | Source freshness field |
| `POSTHOG_ARTEMIS_SALES_PROJECT_ORGANIZATION_ID_FIELD` | `organization_id` | Sales project-to-organization field |
| `POSTHOG_ARTEMIS_SALES_ORGANIZATION_NAME_FIELD` | `name` | Sales organization display field |
| `POSTHOG_PROJECT_URL_PREFIX` | `https://goodleap.artemis.solar/projects/` | URL prefix |
| `POSTHOG_ARTEMIS_SALES_PROJECT_URL_PREFIX` | `https://sales.artemis.solar/projects/` | Sales fallback URL prefix |
| `POSTHOG_PROJECT_URL_SUFFIX` | `/proposal` | URL suffix |

Existing properties whose names start with `GOODLEAP_` are managed by
`Code.gs` and must not be removed.

Script Properties are not displayed in Sheets or committed with this source,
but Apps Script project editors can access them. Restrict editor access and
rotate the personal API key when access changes.

To add them in Apps Script:

1. Open **Project Settings** in the left sidebar.
2. Under **Script Properties**, select **Add script property**.
3. Add the three required key/value pairs exactly as named in the table above.
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
| 8 | `installHybridGoodLeapPostHogTriggers()` | `PostHogSync.gs` | Replace managed triggers with the final five-minute and hourly schedule |

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

Add three script files to the same project:

- `Code.gs`
- `ManualBackfill.gs`
- `PostHogSync.gs`

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

Add the three required PostHog Script Properties before running the PostHog
functions. Do not manually add any `GOODLEAP_*` properties; setup creates those
resource identifiers automatically.

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

### 6. Enable the hybrid schedule

Only after the first manual sync is correct, run:

```text
installHybridGoodLeapPostHogTriggers()
```

This safely removes legacy or duplicate triggers managed by this project and
then creates exactly two:

- `processRecentGoodLeapEmailsAndSyncPostHog` every five minutes;
- `syncPostHogProjects` every hour.

The five-minute coordinator always checks Gmail. It calls PostHog immediately
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
- Each new `Emails` row receives its exact Google Groups conversation URL when
  that link is available in the source message.
- When new messages were archived, `PostHogSync.gs` immediately refreshes the
  derived project lookup and its Drive attachment links.
- Every hour, `PostHogSync.gs` performs the same reconciliation as a fallback.
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
2. Copy the three `.gs` files into a new standalone Apps Script project.
3. Review the Gmail query, historical start date, and time zone.
4. Obtain a new purpose-specific PostHog Personal API Key; do not reuse another
   person's key.
5. Add the three required PostHog Script Properties.
6. Run the Gmail setup, preview, and historical import sequence.
7. Run the PostHog setup, connection test, preview, and first synchronization.
8. Use the schema inspection functions only if the default mapping fails in
   the target environment.
9. After both workflows have been validated, run
   `installHybridGoodLeapPostHogTriggers()`.
10. Confirm that exactly one integrated five-minute trigger and one hourly
   PostHog trigger exist.

All Drive folders, Sheets tabs, Gmail labels, and time-based triggers are
created by setup functions. They do not need to be created manually.

## Troubleshooting

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

- Never paste the PostHog Personal API Key into source code, Sheets, chat, or
  screenshots.
- Give the key only `query:read` and restrict it to the required PostHog
  environment when possible.
- Keep the Apps Script editor list limited because editors can access Script
  Properties.
- Rotate the key if its owner leaves the project or if exposure is suspected.
- The scripts never delete, archive, or mark Gmail messages as read.
- The scripts do not delete Drive files or archive sheets.

## Reference documentation

- [PostHog API overview](https://posthog.com/docs/api)
- [PostHog Personal API keys](https://posthog.com/docs/api/personal-api-keys)
- [Google Apps Script Properties Service](https://developers.google.com/apps-script/guides/properties)
- [Google Apps Script installable triggers](https://developers.google.com/apps-script/guides/triggers/installable)
