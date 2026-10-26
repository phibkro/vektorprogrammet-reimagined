---
status: proposed
---

# Interview forms are built in the core, with an own Effect schema and TanStack Form

Interviews are recorded in the core, not in Google Forms. Kinds of questions are code (a tagged union in `packages/domain`); forms are data that the recruitment team drafts and publishes as versions that cannot change. One pure function, `answersSchema(version)`, gives the Effect Schema for a version's answers. The server decodes every response with it. The browser receives the version as data, runs the same function, and passes `Schema.toStandardSchemaV1` of the result to TanStack Form (`@tanstack/react-form-start`). TanStack Form becomes the single form construct in `apps/web`.

Interview answers are personal data about applicants. In the core, access follows the department grants and deletion follows the retention rules. In shared Google Drive folders, both depend on manual work every semester.

## Considered options

- **Google Forms and a CSV import of outcomes.** Cheaper to start, but access and deletion of interview notes are manual.
- **SurveyJS Creator.** Has a form editor, but needs a commercial licence for each developer. The volunteer team changes every year.
- **JSON Forms or react-jsonschema-form.** No editor. They validate with Ajv, which uses `new Function`, which Cloudflare Workers forbid.
- **Send a JSON Schema to the browser** (`Schema.toStandardJSONSchemaV1`). Rejected: the browser needs a second validator, which can disagree with the server.
- **react-hook-form.** Works through a Standard Schema resolver, but has no TanStack Start integration.

## Consequences

- No conditional logic in forms. Re-evaluate SurveyJS if recruitment needs it.
- The hand-written `apps/web/src/components/forms.tsx` is replaced by TanStack Form for every form.
- Standard Schema is the bridge, because TanStack Form has no Effect-specific adapter. The form representation is the schema's Encoded type: the strings that the form holds, with `…FromString` fields. One schema validates the client state and decodes a no-JavaScript `FormData` post (`Schema.fromFormData`). A throwaway spike confirmed this on 2026-10-26 (see the source, §11.11).
- `@tanstack/react-form-start` 1.33.5 declares the peer `@tanstack/react-start ^1.168.27`, which admits the pinned 1.169.2. Check it again in a real build when the first form moves.

Source: `../../../../analysis/vektorprogrammet/INFORMATION_MODEL.md` §10.4, §11.10, §11.11.
