# Legacy import: reconciliation report

File source: **none** (no legacy file copy was given; every referenced file is reported missing). Ids are legacy ids. This report holds no personal data.

## Rows per table

| Target table | Legacy source | Rows in | Rows out | Quarantined |
| --- | --- | --- | --- | --- |
| public_file | (files referenced by the tables below) | 42 | 0 | 0 |
| department | department | 5 | 5 | 0 |
| semester | semester | 28 | 28 | 0 |
| field_of_study | field_of_study | 110 | 110 | 0 |
| admission_period | AdmissionPeriod | 93 | 92 | 1 |
| article | article | 26 | 0 | 26 |
| article_department | articles_departments | 49 | 0 | 49 |
| static_content | static_content | 44 | 44 | 0 |
| sponsor | sponsor | 10 | 10 | 0 |
| social_event | event | 10 | 9 | 1 |

## Quarantined rows

| Table | Id | Reasons |
| --- | --- | --- |
| admission_period | 45 | end_date is not after start_date |
| article | 10 | imageLarge has no registered file; imageSmall has no registered file |
| article | 11 | imageLarge has no registered file; imageSmall has no registered file |
| article | 12 | imageLarge has no registered file; imageSmall has no registered file |
| article | 13 | imageLarge has no registered file; imageSmall has no registered file |
| article | 14 | imageLarge has no registered file; imageSmall has no registered file |
| article | 15 | imageLarge has no registered file; imageSmall has no registered file |
| article | 16 | imageLarge has no registered file; imageSmall has no registered file |
| article | 17 | imageLarge has no registered file; imageSmall has no registered file |
| article | 18 | imageLarge has no registered file; imageSmall has no registered file |
| article | 19 | imageLarge has no registered file; imageSmall has no registered file |
| article | 20 | imageLarge has no registered file; imageSmall has no registered file |
| article | 21 | imageLarge has no registered file; imageSmall has no registered file |
| article | 22 | imageLarge has no registered file; imageSmall has no registered file |
| article | 24 | imageLarge has no registered file; imageSmall has no registered file |
| article | 25 | imageLarge has no registered file; imageSmall has no registered file |
| article | 26 | imageLarge has no registered file; imageSmall has no registered file |
| article | 27 | imageLarge has no registered file; imageSmall has no registered file |
| article | 28 | imageLarge has no registered file; imageSmall has no registered file |
| article | 29 | imageLarge has no registered file; imageSmall has no registered file |
| article | 30 | imageLarge has no registered file; imageSmall has no registered file |
| article | 31 | imageLarge has no registered file; imageSmall has no registered file |
| article | 32 | imageLarge has no registered file; imageSmall has no registered file |
| article | 33 | imageLarge has no registered file; imageSmall has no registered file |
| article | 34 | imageLarge has no registered file; imageSmall has no registered file |
| article | 35 | imageLarge has no registered file; imageSmall has no registered file |
| article | 36 | imageLarge has no registered file; imageSmall has no registered file |
| article_department | 10:1 | article_id references quarantined article 10 |
| article_department | 11:1 | article_id references quarantined article 11 |
| article_department | 11:3 | article_id references quarantined article 11 |
| article_department | 11:4 | article_id references quarantined article 11 |
| article_department | 12:1 | article_id references quarantined article 12 |
| article_department | 12:3 | article_id references quarantined article 12 |
| article_department | 12:4 | article_id references quarantined article 12 |
| article_department | 12:5 | article_id references quarantined article 12 |
| article_department | 13:1 | article_id references quarantined article 13 |
| article_department | 13:3 | article_id references quarantined article 13 |
| article_department | 13:4 | article_id references quarantined article 13 |
| article_department | 13:5 | article_id references quarantined article 13 |
| article_department | 15:1 | article_id references quarantined article 15 |
| article_department | 15:3 | article_id references quarantined article 15 |
| article_department | 15:4 | article_id references quarantined article 15 |
| article_department | 15:5 | article_id references quarantined article 15 |
| article_department | 16:1 | article_id references quarantined article 16 |
| article_department | 16:3 | article_id references quarantined article 16 |
| article_department | 16:4 | article_id references quarantined article 16 |
| article_department | 16:5 | article_id references quarantined article 16 |
| article_department | 17:1 | article_id references quarantined article 17 |
| article_department | 17:3 | article_id references quarantined article 17 |
| article_department | 17:4 | article_id references quarantined article 17 |
| article_department | 17:5 | article_id references quarantined article 17 |
| article_department | 18:1 | article_id references quarantined article 18 |
| article_department | 18:3 | article_id references quarantined article 18 |
| article_department | 18:4 | article_id references quarantined article 18 |
| article_department | 18:5 | article_id references quarantined article 18 |
| article_department | 19:1 | article_id references quarantined article 19 |
| article_department | 19:3 | article_id references quarantined article 19 |
| article_department | 19:4 | article_id references quarantined article 19 |
| article_department | 19:5 | article_id references quarantined article 19 |
| article_department | 20:1 | article_id references quarantined article 20 |
| article_department | 21:1 | article_id references quarantined article 21 |
| article_department | 25:6 | article_id references quarantined article 25 |
| article_department | 26:1 | article_id references quarantined article 26 |
| article_department | 28:1 | article_id references quarantined article 28 |
| article_department | 28:3 | article_id references quarantined article 28 |
| article_department | 28:4 | article_id references quarantined article 28 |
| article_department | 28:5 | article_id references quarantined article 28 |
| article_department | 28:6 | article_id references quarantined article 28 |
| article_department | 29:6 | article_id references quarantined article 29 |
| article_department | 30:1 | article_id references quarantined article 30 |
| article_department | 31:1 | article_id references quarantined article 31 |
| article_department | 32:1 | article_id references quarantined article 32 |
| article_department | 33:4 | article_id references quarantined article 33 |
| article_department | 35:1 | article_id references quarantined article 35 |
| article_department | 36:1 | article_id references quarantined article 36 |
| article_department | 36:3 | article_id references quarantined article 36 |
| social_event | 4 | endTime is not after startTime |

## Collapsed semesters

None.

## Missing files (42 distinct)

| File            | Area                  | Table   | Id  | Field         |
| --------------- | --------------------- | ------- | --- | ------------- |
| missing-file-27 | images/article_images | article | 14  | imageLarge    |
| missing-file-38 | images/article_images | article | 14  | imageSmall    |
| missing-file-23 | images/article_images | article | 15  | imageLarge    |
| missing-file-36 | images/article_images | article | 15  | imageSmall    |
| missing-file-22 | images/article_images | article | 16  | imageLarge    |
| missing-file-35 | images/article_images | article | 16  | imageSmall    |
| missing-file-34 | images/article_images | article | 17  | imageLarge    |
| missing-file-33 | images/article_images | article | 17  | imageSmall    |
| missing-file-41 | images/article_images | article | 18  | imageLarge    |
| missing-file-37 | images/article_images | article | 18  | imageSmall    |
| missing-file-18 | images/article_images | article | 19  | imageLarge    |
| missing-file-17 | images/article_images | article | 19  | imageSmall    |
| missing-file-21 | images/article_images | article | 20  | imageLarge    |
| missing-file-32 | images/article_images | article | 20  | imageSmall    |
| missing-file-25 | images/article_images | article | 21  | imageLarge    |
| missing-file-31 | images/article_images | article | 21  | imageSmall    |
| missing-file-41 | images/article_images | article | 22  | imageLarge    |
| missing-file-39 | images/article_images | article | 22  | imageSmall    |
| missing-file-24 | images/article_images | article | 24  | imageLarge    |
| missing-file-29 | images/article_images | article | 24  | imageSmall    |
| missing-file-41 | images/article_images | article | 25  | imageLarge    |
| missing-file-26 | images/article_images | article | 25  | imageSmall    |
| missing-file-20 | images/article_images | article | 26  | imageLarge    |
| missing-file-29 | images/article_images | article | 26  | imageSmall    |
| missing-file-41 | images/article_images | article | 27  | imageLarge    |
| missing-file-41 | images/article_images | article | 27  | imageSmall    |
| missing-file-42 | images/article_images | article | 28  | imageLarge    |
| missing-file-42 | images/article_images | article | 28  | imageSmall    |
| missing-file-41 | images/article_images | article | 29  | imageLarge    |
| missing-file-39 | images/article_images | article | 29  | imageSmall    |
| missing-file-19 | images/article_images | article | 30  | imageLarge    |
| missing-file-30 | images/article_images | article | 30  | imageSmall    |
| missing-file-19 | images/article_images | article | 31  | imageLarge    |
| missing-file-30 | images/article_images | article | 31  | imageSmall    |
| missing-file-41 | images/article_images | article | 32  | imageLarge    |
| missing-file-40 | images/article_images | article | 32  | imageSmall    |
| missing-file-28 | images/article_images | article | 33  | imageLarge    |
| missing-file-28 | images/article_images | article | 33  | imageSmall    |
| missing-file-14 | images/article_images | article | 34  | imageLarge    |
| missing-file-13 | images/article_images | article | 34  | imageSmall    |
| missing-file-12 | images/article_images | article | 35  | imageLarge    |
| missing-file-11 | images/article_images | article | 35  | imageSmall    |
| missing-file-16 | images/article_images | article | 36  | imageLarge    |
| missing-file-15 | images/article_images | article | 36  | imageSmall    |
| missing-file-6  | images/Logo images    | sponsor | 1   | logoImagePath |
| missing-file-7  | images/Logo images    | sponsor | 4   | logoImagePath |
| missing-file-8  | images/Logo images    | sponsor | 5   | logoImagePath |
| missing-file-1  | images/Logo images    | sponsor | 6   | logoImagePath |
| missing-file-9  | images/Logo images    | sponsor | 7   | logoImagePath |
| missing-file-4  | images/Logo images    | sponsor | 9   | logoImagePath |
| missing-file-5  | images/Logo images    | sponsor | 14  | logoImagePath |
| missing-file-3  | images/Logo images    | sponsor | 17  | logoImagePath |
| missing-file-2  | images/Logo images    | sponsor | 18  | logoImagePath |
| missing-file-10 | images/Logo images    | sponsor | 19  | logoImagePath |

## Broken references

| Table | Id | Field | Kind | Target | Target id |
| --- | --- | --- | --- | --- | --- |
| article | 10 | imageLarge | not-a-legacy-file | public_file |  |
| article | 10 | imageSmall | not-a-legacy-file | public_file |  |
| article | 11 | imageLarge | not-a-legacy-file | public_file |  |
| article | 11 | imageSmall | not-a-legacy-file | public_file |  |
| article | 12 | imageLarge | not-a-legacy-file | public_file |  |
| article | 12 | imageSmall | not-a-legacy-file | public_file |  |
| article | 13 | imageLarge | not-a-legacy-file | public_file |  |
| article | 13 | imageSmall | not-a-legacy-file | public_file |  |
| article_department | 10:1 | article_id | quarantined-row | article | 10 |
| article_department | 11:1 | article_id | quarantined-row | article | 11 |
| article_department | 11:3 | article_id | quarantined-row | article | 11 |
| article_department | 11:4 | article_id | quarantined-row | article | 11 |
| article_department | 12:1 | article_id | quarantined-row | article | 12 |
| article_department | 12:3 | article_id | quarantined-row | article | 12 |
| article_department | 12:4 | article_id | quarantined-row | article | 12 |
| article_department | 12:5 | article_id | quarantined-row | article | 12 |
| article_department | 13:1 | article_id | quarantined-row | article | 13 |
| article_department | 13:3 | article_id | quarantined-row | article | 13 |
| article_department | 13:4 | article_id | quarantined-row | article | 13 |
| article_department | 13:5 | article_id | quarantined-row | article | 13 |
| article_department | 15:1 | article_id | quarantined-row | article | 15 |
| article_department | 15:3 | article_id | quarantined-row | article | 15 |
| article_department | 15:4 | article_id | quarantined-row | article | 15 |
| article_department | 15:5 | article_id | quarantined-row | article | 15 |
| article_department | 16:1 | article_id | quarantined-row | article | 16 |
| article_department | 16:3 | article_id | quarantined-row | article | 16 |
| article_department | 16:4 | article_id | quarantined-row | article | 16 |
| article_department | 16:5 | article_id | quarantined-row | article | 16 |
| article_department | 17:1 | article_id | quarantined-row | article | 17 |
| article_department | 17:3 | article_id | quarantined-row | article | 17 |
| article_department | 17:4 | article_id | quarantined-row | article | 17 |
| article_department | 17:5 | article_id | quarantined-row | article | 17 |
| article_department | 18:1 | article_id | quarantined-row | article | 18 |
| article_department | 18:3 | article_id | quarantined-row | article | 18 |
| article_department | 18:4 | article_id | quarantined-row | article | 18 |
| article_department | 18:5 | article_id | quarantined-row | article | 18 |
| article_department | 19:1 | article_id | quarantined-row | article | 19 |
| article_department | 19:3 | article_id | quarantined-row | article | 19 |
| article_department | 19:4 | article_id | quarantined-row | article | 19 |
| article_department | 19:5 | article_id | quarantined-row | article | 19 |
| article_department | 20:1 | article_id | quarantined-row | article | 20 |
| article_department | 21:1 | article_id | quarantined-row | article | 21 |
| article_department | 25:6 | article_id | quarantined-row | article | 25 |
| article_department | 26:1 | article_id | quarantined-row | article | 26 |
| article_department | 28:1 | article_id | quarantined-row | article | 28 |
| article_department | 28:3 | article_id | quarantined-row | article | 28 |
| article_department | 28:4 | article_id | quarantined-row | article | 28 |
| article_department | 28:5 | article_id | quarantined-row | article | 28 |
| article_department | 28:6 | article_id | quarantined-row | article | 28 |
| article_department | 29:6 | article_id | quarantined-row | article | 29 |
| article_department | 30:1 | article_id | quarantined-row | article | 30 |
| article_department | 31:1 | article_id | quarantined-row | article | 31 |
| article_department | 32:1 | article_id | quarantined-row | article | 32 |
| article_department | 33:4 | article_id | quarantined-row | article | 33 |
| article_department | 35:1 | article_id | quarantined-row | article | 35 |
| article_department | 36:1 | article_id | quarantined-row | article | 36 |
| article_department | 36:3 | article_id | quarantined-row | article | 36 |

## Rich text

References rewritten to `/filer/{key}`: 0.

Rows whose markup the sanitizer changed (RULE-133 replacement):

| Table          | Id  |
| -------------- | --- |
| article        | 10  |
| article        | 11  |
| article        | 12  |
| article        | 13  |
| article        | 14  |
| article        | 15  |
| article        | 16  |
| article        | 17  |
| article        | 18  |
| article        | 19  |
| article        | 20  |
| article        | 21  |
| article        | 22  |
| article        | 24  |
| article        | 25  |
| article        | 26  |
| article        | 27  |
| article        | 28  |
| article        | 29  |
| article        | 30  |
| article        | 31  |
| article        | 32  |
| article        | 33  |
| article        | 34  |
| article        | 35  |
| article        | 36  |
| static_content | 1   |
| static_content | 2   |
| static_content | 8   |
| static_content | 9   |
| static_content | 10  |
| static_content | 11  |
| static_content | 12  |
| static_content | 13  |
| static_content | 14  |
| static_content | 15  |
| static_content | 21  |
| static_content | 22  |
| static_content | 23  |
| static_content | 24  |
| static_content | 25  |
| static_content | 26  |
| static_content | 27  |
| static_content | 28  |
| static_content | 29  |
| static_content | 30  |
| static_content | 31  |
| static_content | 32  |
| static_content | 33  |
| static_content | 34  |
| static_content | 35  |
| static_content | 36  |
| static_content | 37  |
| static_content | 38  |
| static_content | 39  |
| static_content | 40  |
| static_content | 41  |
| static_content | 42  |
| static_content | 43  |
| static_content | 44  |

## Files

Registered public files: 0. Legacy paths whose bytes equal an earlier path (no redirect row of their own): 0.

## Normalisations

None.

## Dropped legacy columns

| Legacy table | Column | Reason |
| --- | --- | --- |
| event | role_id | RULE-188: the sign-up role was never enforced |
| article | updated | not part of the Phase 1 article model |
| AdmissionPeriod | infoMeeting_id | info meetings belong to Phase 3 |
| static_content | id | the block is keyed by html_id |
