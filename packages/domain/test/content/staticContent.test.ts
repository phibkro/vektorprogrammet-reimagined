import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  EDITOR_ID_REQUIRED_MESSAGE,
  SanitizedHtml,
  SanitizedHtmlFromString,
  StaticContentKey,
  anonymous,
  getStaticContent,
  sanitizeRichText,
  updateStaticContent,
} from "../../src/index.ts";
import {
  TestServices,
  admin,
  asActor,
  boardMember,
  failureTag,
  table,
  teamLeaderTrondheim,
} from "../support/inMemory.ts";

const ABOUT_INTRO = StaticContentKey.make("about-intro");

describe("C4 static content", () => {
  it.effect("RULE-296: a team leader who is not on the executive board is denied", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        asActor(teamLeaderTrondheim)(
          updateStaticContent({ editorId: "about-intro", html: "<p>Ny</p>" }),
        ),
      );
      assert.strictEqual(failureTag(exit), "Forbidden");
      const anonymousExit = yield* Effect.exit(
        asActor(anonymous)(updateStaticContent({ editorId: "about-intro", html: "<p>Ny</p>" })),
      );
      assert.strictEqual(failureTag(anonymousExit), "Forbidden");
      assert.deepStrictEqual(yield* table((db) => db.staticContent), []);
      assert.deepStrictEqual(yield* table((db) => db.audit), []);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-296: an admin's post creates the missing block, then replaces it", () =>
    Effect.gen(function* () {
      yield* asActor(admin)(updateStaticContent({ editorId: "about-intro", html: "<p>Først</p>" }));
      const replaced = yield* asActor(admin)(
        updateStaticContent({ editorId: "about-intro", html: "<p>Deretter</p>" }),
      );
      assert.strictEqual(replaced.html, "<p>Deretter</p>");
      const stored = yield* asActor(admin)(getStaticContent(ABOUT_INTRO));
      assert.deepStrictEqual(
        Option.map(stored, (block) => block.html),
        Option.some("<p>Deretter</p>"),
      );
      assert.strictEqual((yield* table((db) => db.staticContent)).length, 1);
      const audit = yield* table((db) => db.audit);
      assert.deepStrictEqual(
        audit.map((e) => [e.action, e.entityKey]),
        [
          ["staticContent.updated", "about-intro"],
          ["staticContent.updated", "about-intro"],
        ],
      );
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-296: an executive-board member may edit", () =>
    Effect.gen(function* () {
      const saved = yield* asActor(boardMember)(
        updateStaticContent({ editorId: "parents", html: "<p>Hei</p>" }),
      );
      assert.strictEqual(saved.key, "parents");
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-296: a post without editorID is ValidationFailed and nothing is saved", () =>
    Effect.gen(function* () {
      for (const input of [
        { html: "<p>x</p>" },
        { editorId: "", html: "<p>x</p>" },
        { editorId: "   " },
      ]) {
        const error = yield* Effect.flip(asActor(admin)(updateStaticContent(input)));
        assert.strictEqual(error._tag, "ValidationFailed");
        if (error._tag === "ValidationFailed") {
          assert.deepStrictEqual(error.issues, [
            { path: ["editorId"], message: EDITOR_ID_REQUIRED_MESSAGE },
          ]);
        }
      }
      assert.deepStrictEqual(yield* table((db) => db.staticContent), []);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-133: static content HTML is sanitized on save", () =>
    Effect.gen(function* () {
      const saved = yield* asActor(admin)(
        updateStaticContent({
          editorId: "about-intro",
          html: '<p onclick="steal()">Hei<script>alert(1)</script><a href="javascript:alert(1)">x</a></p>',
        }),
      );
      assert.strictEqual(saved.html, "<p>Hei<a>x</a></p>");
    }).pipe(Effect.provide(TestServices)),
  );
});

describe("RULE-133 rich-text sanitizer (replacement: maintained allowlist)", () => {
  const xss: ReadonlyArray<readonly [string, string]> = [
    ["<script>alert(1)</script><p>ok</p>", "<p>ok</p>"],
    ['<img src="x" onerror="alert(1)">', '<img src="x" />'],
    ['<a href="javascript:alert(1)">x</a>', "<a>x</a>"],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', "<a>x</a>"],
    ['<svg onload="alert(1)"><circle /></svg>', ""],
    ['<object data="evil.swf"></object>', ""],
    ['<iframe src="https://evil.example"></iframe>', ""],
    ['<p style="background:url(javascript:alert(1))">x</p>', "<p>x</p>"],
    ['<img src="data:image/png;base64,AAAA">', "<img />"],
    ['<a href="//evil.example/x">x</a>', "<a>x</a>"],
  ];

  it("RULE-133: strips scripts, event handlers, javascript: URLs, svg, object, iframe and styles", () => {
    for (const [input, expected] of xss)
      assert.strictEqual(sanitizeRichText(input), expected, input);
  });

  it("RULE-133: keeps editor tags, http/https/mailto links, images and tables", () => {
    const html =
      '<h2>Tittel</h2><p><strong>Fet</strong> <em>kursiv</em> <a href="https://vektorprogrammet.no/om">lenke</a> ' +
      '<a href="mailto:post@example.org">e-post</a></p><ul><li>én</li></ul>' +
      '<img src="/filer/abc.png" alt="Bilde" />' +
      '<table><thead><tr><th colspan="2">A</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
    assert.strictEqual(sanitizeRichText(html), html);
  });

  it("RULE-133: sanitizing is idempotent, so stored HTML decodes as SanitizedHtml", () => {
    for (const [input] of xss) {
      const once = sanitizeRichText(input);
      assert.strictEqual(sanitizeRichText(once), once);
      assert.isTrue(Schema.is(SanitizedHtml)(once));
    }
    assert.isFalse(Schema.is(SanitizedHtml)("<script>x</script>"));
  });

  it("RULE-133: stored rich text is re-sanitized when decoded (the render-time half)", () => {
    const decoded = Schema.decodeUnknownSync(SanitizedHtmlFromString)(
      '<p onmouseover="x()">Hei</p>',
    );
    assert.strictEqual(decoded, "<p>Hei</p>");
  });
});
