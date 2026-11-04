# Content model

This package declares Portable Text and the five site-content collections, together with the `CmsClient` published-read and `ContentEditor` draft/publish services. `@vektorprogrammet/db` implements these services on PostgreSQL; the application provides that layer with its request database. Public reads use only the published snapshot. Draft edits do not change it until publication.

The legacy importer creates missing entries without overwriting existing content, preserving their original creation and publication dates. Run it against an explicitly configured `DATABASE_URL` and `LEGACY_MYSQL_URL`.
