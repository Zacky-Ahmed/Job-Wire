# Email interests

The Wire offers eight optional fields based on the supplied department reference, or a named custom filter with include/exclude phrases. Multiple fields and include phrases are ORed. Exclusions always win. All mode bypasses field choices but retains exclusions. Preferences belong to the authenticated user's subscription; they do not create queries or filter the 14-day Wire.

Preview reads retained matched jobs for the user's watch and shows up to 20 matching examples with reasons. Saving never backfills alerts. Existing emailPack behavior is retained until the owner saves new preferences. Hold/Resume still controls delivery.

The October 17 audit evaluated 3,101 stored job records (2,295 distinct titles), including unmatched records. No stored descriptions were available. The aggregate audit is in email-preferences-audit.json; it is a point-in-time snapshot, not a prediction of future accuracy. Raw records are not committed. Title matching uses normalized punctuation, phrase boundaries, field families and contextual FE/BE/QA/BA abbreviations. Marketing/sales references to AI/software are excluded from engineering classification. Generic IT/QA roles require explicit opt-in or a custom include phrase. These are suggestions, not departmental approval.

The delivery worker rechecks preferences before submitting email. Unsubmitted mismatches are cancelled. If a previously sealed batch now contains excluded jobs, the entire batch is cancelled to avoid changing an idempotent payload that may already have been accepted by a provider. Previously accepted mail cannot be recalled.
