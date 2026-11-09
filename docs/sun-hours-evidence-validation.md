# Sun Hours evidence validation — 2026-10-07

Installed `OpenAIAnalysis.gs` in the existing GoodLeap TPO Email Archive Google Apps Script project. Rules version: `2026-10-07-sun-hours-evidence-v6`. Saved editor content was read back and matched the local source. No web-app deployment was needed; installed triggers run the saved source.

Reclassified the latest analyzed email for every current project in 14 bounded executions. The first 13 processed 10 messages each; the final execution processed one. One latest message was already under v6. All batches reported zero errors. Final pendingAfterRun was zero. The final execution updated Project ID Summary (132 projects), AI Weekly Summary and AI Dashboard, preserving five charts.

Independent read-only Google Sheets verification: all 132 current Project ID Summary rows join to an AI Analysis record carrying v6. All latest email bodies were available. Nine project category lists changed. Twenty-nine projects have Sun Hours; every assigned category has explicit qualifying evidence in the newest email category block, and no qualifying block was omitted. A private local audit records the source message ID and verbatim quote for each assignment. Historical email analyses remain unchanged unless they are the current latest message.

Both user examples legitimately qualify based on the original email: ad680382 mentions failure to meet the minimum sunhours; d5e7dd16 explicitly requests a design adjustment to meet the min/max sun hour requirement. Both current categories are Production; Shading / Site Conditions; Sun Hours, and both refreshed summaries now mention the sun-hour issue.

Validation: 70 Node tests pass (including both actual evidence examples and negative cases for generic shading, measurements, resolved requirements and conditional instructions). No credentials or private workbook/email exports are part of the source changes.
