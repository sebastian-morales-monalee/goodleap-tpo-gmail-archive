# Pending panel-count rules and source diagnosis

## Snapshot implementation, 2026-09-30

The historical provisional rules below are superseded for energy metrics by
the latest saved ProjectVersion. Active count and DC production now come from
the same version's active panel array. Snapshot-specific Pricing, inverter
override, engine and annual consumption drive the subsequent calculations.
The micro count defaults to that array count, while the approved string count
remains one. Version/date/engine and calculation status are published alongside
the metrics. Raw SolarPanels are not used as an energy fallback.

The Sales 20-panel and GoodLeap nine-panel generated queries were validated
through PostHog MCP. Their DC sums are 11473.880950039056 and
3842.675949950245 kWh. The nine-panel snapshot estimate differs from the
current live screen; its missing historical efficiency uses the selected-model
catalog fallback and the status exposes that fact.

Installed and executed in the existing Apps Script project on 2026-09-30.
The completed summary refresh published reference DC for all 117 projects and
estimated AC for 97. The remaining 20 have explicit calculation statuses:
17 lack sufficient selected-inverter metadata (one also has an unsupported
engine), and three have a DC/AC ratio outside the supported factor table.
Category Explorer was rebuilt successfully and retained its Equipment selector
with seven results. Both snapshot example validations passed in Apps Script.

The published Sales example is 20 panels, 8.6 kW, 11995.002860 kWh AC and
142 percent offset. The nine-panel example is 3.87 kW, 4022.389216 kWh AC and
68 percent from the 2026-09-21 saved snapshot, not the current live UI's
3970 kWh and 67 percent. No commit or push was performed for this update.

The following sections preserve the earlier provisional investigation. Their
raw-panel selection limitations do not describe the new snapshot calculation.

## Requested interim rule

- For `Inverter Type = micro`, publish `active_panel_count` equal to the
  resolved `inverter_count`.
- For `Inverter Type = string`, use `inverter_count = 1` and retain the panel
  count from `goodleap_postgres_solarpanels` (or its Sales equivalent), filtering
  `is_active = true`.
- Do not infer a type or turn an unresolved count into zero.
- Resolve the inverter count independently before applying the micro rule;
  copying a count originally derived from the suspect panel-row count would
  merely reproduce that count. Micro count uses a positive project override,
  then the project's `active_panels_count`; both output counts use that result.
- Correcting the count does not identify the panel records to sum for DC
  production. Do not silently scale or substitute the existing DC total.

## Diagnosed project: d4f658cb-dcaf-4efd-bd08-9a84c1ed0dd6

Proposal: https://goodleap.artemis.solar/projects/d4f658cb-dcaf-4efd-bd08-9a84c1ed0dd6/proposal

Read-only PostHog checks returned:

| Source | Field / result | Value |
| --- | --- | --- |
| goodleap_postgres_projects | active_panels_count | 22 |
| goodleap_postgres_projects | inverter_count_override | null |
| goodleap_postgres_projects | inverter_model_override | null |
| goodleap_postgres_projects | inverter_type_id | ef9a09d2-40f0-4f69-b1d4-917e2e6857c6 |
| goodleap_postgres_projects | pricing_version_id | 0e496f38-3dba-4521-b0f3-6e7f1d8e2528 |
| goodleap_postgres_solarpanels | total distinct panel rows | 78 |
| goodleap_postgres_solarpanels | rows with is_active = true | 65 |
| goodleap_postgres_solarpanels | active reference DC sum, kWh | 31041.76096323911 |
| selected Pricing inverter | models length | 1 |
| selected Pricing inverter model | id | missing |
| selected Pricing inverter model | model | GL_ENPH1_IQ8HC-72-M-DOM-US (380 W) |
| selected Pricing inverter model | nominalACPowerOutputW | 0 |
| selected Pricing inverter model | ratedACPowerW | 380 |
| selected Pricing inverter model | maxEfficiencyPercentage | null |
| goodleap_postgres_invertermodels | id | 6b16431f-b6a0-4b7d-853c-1014307fdf0a |
| goodleap_postgres_invertermodels | model_number | GL_ENPH1_IQ8HC-72-M-DOM-US |
| goodleap_postgres_invertermodels | count_strategy | micro |
| goodleap_postgres_invertermodels | nominal_ac_power_output_w | 380 |
| goodleap_postgres_invertermodels | max_efficiency_percentage | 97.3 |

The selectedinverters row exists but its inverter_model_number is empty.
The supplied Artemis screenshot shows 22 panels, 22 inverters, and 9.46 kW.

## Confirmed cause and implemented lookup

The previous script resolved count_strategy only by the model ID stored in
Pricing. This older model representation has no ID, so the catalogue lookup
was skipped and the inverter type/count remained blank, not numeric zero.
The model can be uniquely matched in the catalogue by its normalized model
number, stripping the display suffix `(380 W)` and verifying uniqueness.
The Pricing snapshot also lacks usable nominal power and efficiency, whereas
the matched catalogue row supplies both. The implementation now uses this
fallback only for a unique model-number match, not an inference from brand.
Positive Pricing power/efficiency remain preferred; missing or zero values
use the matched catalogue. Model IDs, when present, are matched by ID only.

The project-level count of 22 agrees with the screenshot. The 65 active rows
do not. This establishes a source inconsistency, but does not prove which
rows are obsolete or whether the discrepancy originates in source data or
warehouse synchronization. The current reference DC sum must not be presented
as the production of the 22-panel design without resolving that selection.
The script now leaves reference DC, estimated AC, and offset blank whenever
the raw active-panel row count differs from the effective count or the known
project-level count. It does not rescale the sum. Unknown inverter types stay
blank; their system size uses the available project-level panel count.

For the previously investigated project
`05d70604-d371-4c91-b5c0-a2d075cec526`, PostHog returned project-level
active_panels_count = 10, inverter_count_override = 10, but 45 distinct active
panel rows. That override explains why the installed inverter count was 10.

## Duplicate-catalog type consensus, installed 2026-09-30

Sales project `1a178bd7-8640-4702-b7b5-c0e929404c06` selects a legacy Tesla
Powerwall 3 integrated model without a model ID. Its normalized model number
matches two catalogue rows, both with count_strategy = string. The resolver
now accepts only their shared nonempty type, not arbitrary power/efficiency
from either duplicate. Contradictory or missing strategies remain unresolved.
Pricing supplies 11500 W and 97.5 percent for this project.

The installed refresh verified string / 1 inverter, but exposed another count
discrepancy: the existing string rule publishes 28 active panel records and
12.04 kW, whereas the earlier project-level query and user screenshot show
20 panels / 8.6 kW. Production and offset remain blank. No change to the
authorized string panel-count rule was made; this discrepancy needs review.

## Read-only snapshot and synchronization investigation, 2026-09-30

No snapshot fallback or new string-count rule has been implemented. The
following findings document the remaining work, not a deployed solution.

Both Sales and GoodLeap SolarPanels schemas use incremental synchronization.
Their latest inspected jobs completed without a reported error. The sources
have direct_query_enabled = 0 and is_live_queryable = 0. Detailed sync logs
were denied because the MCP connection lacks external_data_source:read;
the exact incremental cursor was not available in the accessible metadata.
These findings do not establish the cause of every stale or extra record.

| Project | Project count | Active panel-table rows | Latest snapshot active count | Snapshot reference DC kWh |
| --- | --- | --- | --- | --- |
| 1a178bd7-8640-4702-b7b5-c0e929404c06 | 20 | 28 | 20 | 11473.880950039056 |
| f8c08b92-ce68-453b-9353-210e41c2d149 | 9 | 38 | 9 | 3842.675949950245 |

The Sales snapshot is 80c4c67b-d2cf-4809-ada2-42df895ec044, created
2026-09-29 17:50:05.236 UTC-5. Using its parameters reproduces 8.6 kW,
11995.002859830853 kWh AC, and 142 percent offset. The same 20 IDs in the
replicated SolarPanels table instead sum to 11662.085330399332 kWh DC;
all 28 active rows sum to 16465.585543634934 kWh DC.

The GoodLeap snapshot is aa604b23-fc06-49c0-a7b7-4ad7323344cf, created
2026-09-21 18:05:04.888 UTC-5. It stores nine panels, all active, whereas
the project metadata was updated on September 28. The same nine IDs in
SolarPanels sum to 3851.2328748397404 kWh DC; all 38 active rows sum to
15975.471014501994 kWh DC. Neither snapshot has nonempty diurnal curves.
Using 430 W, 380 W, 97.3 percent efficiency and the existing correction
formula with the GoodLeap snapshot gives 4022.389215636849 kWh AC and
68 percent offset, not the supplied current-screen values of 3970 kWh
and 67 percent. The reason for that remaining difference is unresolved.

Selecting snapshot panel IDs alone is therefore insufficient: their recorded
production values can also differ. A saved version must not be labeled as
live/current, and calculations must use coherent version-specific inputs.
Future snapshot support would require visible version/date provenance and
explicit treatment of projects without a suitable saved version.
