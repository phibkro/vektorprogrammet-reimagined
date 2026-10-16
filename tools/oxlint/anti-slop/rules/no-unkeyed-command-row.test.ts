// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";

import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noUnkeyedCommandRowRule } from "./no-unkeyed-command-row.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const unkeyed = [{ messageId: "unkeyedCommandRow" }];

new RuleTester().run("no-unkeyed-command-row", noUnkeyedCommandRowRule, {
  valid: [
    // Negative controls: keyed rows, rows without entry messages, and maps that render no element.
    'entries.map((entry) => h.li([h.Key(String(entry.articleId)), h.Class("row")], [h.button([h.OnClick(SelectedArticle({ articleId: entry.articleId }))], ["Velg"])]))',
    'entries.map((entry) => h.keyed("li")(String(entry.articleId), [], [h.button([h.OnClick(SelectedArticle({ articleId: entry.articleId }))], ["Velg"])]))',
    'entries.map((entry) => h.li([h.DataAttribute("article-id", String(entry.articleId))], [entry.title]))',
    "entries.map((entry) => h.li([], [h.button([h.OnClick(RetriedWorkspace({ scope: model.scope }))], [entry.title])]))",
    "entries.map((entry) => h.li([], [h.button([h.OnClick(DeselectedArticle())], [entry.title])]))",
    "departments.map((department) => h.option([h.Value(DepartmentId.make(department.departmentId))], [department.name]))",
    "Effect.map((board) => SucceededLoadBoard({ requestId, board }))",
    // A handler parameter that shadows the entry is not the entry.
    "values.map((value) => h.li([], [h.input([h.OnInput((value) => EditedField({ value }))])]))",
    // A local that does not derive from the entry is not the entry.
    "items.map((item) => { const scope = model.scope; return h.li([], [h.button([h.OnClick(Refreshed({ scope }))], [item.title])]); })",
    // An unresolved helper, and helpers that key the row or build no message from the entry.
    "rows.map((row) => candidateRow(model, row, h))",
    'const candidateRow = (model, candidate, h) => h.tr([h.Key(candidate.applicationId)], [button("Tildel", OpenedAssignment({ applicationId: candidate.applicationId }))]); rows.map((row) => candidateRow(model, row, h))',
    "function linkView(model, link, h) { return h.li([], [button(link.label, Navigated({ busy: model.busy }))]); } links.map((link) => linkView(model, link, h))",
  ],
  invalid: [
    // The hosted failure: a reload reordered the rows and the held control published the other article.
    {
      code: 'entries.map((entry) => h.li([h.Class("row"), h.DataAttribute("article-id", String(entry.articleId))], [h.button([h.OnClick(SubmittedPublish({ commandId: `publish-${entry.articleId}`, articleId: entry.articleId }))], ["Publiser"])]))',
      errors: unkeyed,
    },
    {
      code: 'delegations.map((delegation) => h.tr([], [h.td([], [button("Velg", Selected({ id: delegation.delegationId }))])]))',
      errors: unkeyed,
    },
    {
      code: 'departments.map(({ departmentId, name }) => h.div([h.Class("option")], [h.input([h.OnChange((checked) => ChangedDepartmentSelection({ departmentId, checked: checked === "on" }))]), name]))',
      errors: unkeyed,
    },
    {
      code: "alternatives.map((value, alternative) => h.div([], [button(`Fjern ${alternative + 1}`, RemovedAlternative({ index, alternative }))]))",
      errors: unkeyed,
    },
    {
      code: 'items.map((item) => { const id = item.id; return item.open ? h.li([], [h.button([h.OnClick(Opened({ id }))], ["Åpne"])]) : h.li([], [item.title]); })',
      errors: unkeyed,
    },
    // Rows that a same-file helper renders for the entry.
    {
      code: 'const candidateRow = (model, candidate, h) => h.tr([h.DataAttribute("application-id", candidate.applicationId)], [button("Tildel", OpenedAssignment({ applicationId: candidate.applicationId }))]); board.candidates.map((candidate) => candidateRow(model, candidate, h))',
      errors: unkeyed,
    },
    {
      code: 'function rowView(model, entry, h) { const id = entry.id; return h.li([], [h.button([h.OnClick(Opened({ id }))], ["Åpne"])]); } entries.map((entry) => rowView(model, entry, h))',
      errors: unkeyed,
    },
  ],
});
