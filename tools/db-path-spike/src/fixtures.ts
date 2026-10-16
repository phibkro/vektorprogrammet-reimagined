/**
 * Inputs the Worker feeds into the stack and expectations the smoke command compares
 * its answers with. Shared by `worker.ts`, `smoke.ts` and the tests, so the three cannot disagree.
 */

/** Check 7: value samples. The instants straddle both Europe/Oslo clock changes of 2026. */
export interface CodecSample {
  readonly amount: string;
  readonly at: string;
  readonly day: string;
  readonly doc: unknown;
}

export const codecSamples: readonly CodecSample[] = [
  {
    amount: "1234.50",
    at: "2026-03-29T00:59:59.999Z",
    day: "2026-03-29",
    doc: { list: [1, "to", null, true], nested: { æøå: 1.5 } },
  },
  {
    amount: "0.10",
    at: "2026-03-29T01:00:00.000Z",
    day: "2026-03-29",
    doc: [],
  },
  {
    amount: "-0.05",
    at: "2026-10-25T00:59:59.999Z",
    day: "2026-10-25",
    doc: { text: "Høst 2026" },
  },
  {
    amount: "9999999999.99",
    at: "2026-10-25T01:00:00.000Z",
    day: "2000-02-29",
    doc: { big: 12_345_678_901_234, neg: -0.5, text: "Høst 2026" },
  },
  {
    amount: "0.00",
    at: "1970-01-01T00:00:00.000Z",
    day: "1970-01-01",
    doc: {},
  },
];

/** Check 9: payloads the RULE-133 sanitizer must neutralise, with the output Node produces for each. */
export const xssCorpus: readonly (readonly [
  input: string,
  expected: string,
])[] = [
  ["<script>alert(1)</script><p>ok</p>", "<p>ok</p>"],
  ["<img src=x onerror=alert(1)>", '<img src="x" />'],
  ['<a href="javascript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="JaVaScRiPt:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="&#106;avascript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href=" javascript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="jav&#x09;ascript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="vbscript:msgbox(1)">x</a>', "<a>x</a>"],
  [
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    "<a>x</a>",
  ],
  ['<a href="//evil.example/x">x</a>', "<a>x</a>"],
  ['<svg onload="alert(1)"><circle /></svg>', ""],
  ["<svg><script>alert(1)</script></svg>", ""],
  ['<iframe src="https://evil.example"></iframe>', ""],
  ['<object data="evil.swf"></object>', ""],
  ['<embed src="evil.swf">', ""],
  ["<style>@import 'x';</style><p>t</p>", "<p>t</p>"],
  ['<p style="background:url(javascript:alert(1))">x</p>', "<p>x</p>"],
  ['<img src="data:image/png;base64,AAAA">', "<img />"],
  ["<body onload=alert(1)>x</body>", "x"],
  ['<math><mi xlink:href="javascript:alert(1)">x</mi></math>', "x"],
  ['<form action="javascript:alert(1)"><input type="submit"></form>', ""],
  ["<details open ontoggle=alert(1)>x</details>", "x"],
  ["<input onfocus=alert(1) autofocus>", ""],
  ["<scr<script>ipt>alert(1)</scr</script>ipt>", "ipt&gt;alert(1)ipt&gt;"],
  ['<p onclick="steal()">Hei</p>', "<p>Hei</p>"],
  [
    '<img src="https://example.org/a.png" onerror="alert(1)" alt="ok">',
    '<img src="https://example.org/a.png" alt="ok" />',
  ],
  ['<base href="javascript:alert(1)//">', ""],
  ['<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', ""],
  ['<link rel="stylesheet" href="javascript:alert(1)">', ""],
];

/** Check 9: every allowed tag and attribute; the sanitizer must return it unchanged. */
export const allowedRichText =
  "<h2>Tittel</h2><h3>Under</h3><h4>Mindre</h4><p><strong>Fet</strong> <b>b</b> <em>kursiv</em> <i>i</i> <u>u</u> <s>s</s> H<sub>2</sub>O x<sup>2</sup> " +
  '<a href="https://vektorprogrammet.no/om" title="Om">lenke</a> <a href="mailto:post@example.org">e-post</a><br /></p><hr />' +
  "<blockquote>sitat</blockquote><pre>pre</pre><code>kode</code><ul><li>én</li></ul><ol><li>to</li></ol>" +
  '<figure><img src="https://vektorprogrammet.no/filer/abc.png" alt="Bilde" title="T" width="10" height="10" /><figcaption>tekst</figcaption></figure>' +
  '<table><caption>c</caption><thead><tr><th colspan="2" scope="col">A</th></tr></thead><tbody><tr><td rowspan="1">1</td><td>2</td></tr></tbody><tfoot><tr><td>3</td></tr></tfoot></table>';

/**
 * Check 10: a made-up `$2y$12$` hash (PHP's prefix; the legacy site stored these) of
 * `bcryptProbe.right`, made with libxcrypt (`mkpasswd -m bcrypt -R 12`), not with the
 * verifying library. It belongs to no account.
 */
export const bcryptProbe = {
  cost: 12,
  prefix: "$2y$12$",
  right: "vp-spike-0000-not-a-real-input",
  stored: "$2y$12$yhE.mMTqLkzVEIi7gixG2OKSsB2sBThdwbdRlFxxtHuAQV1lmzdvW",
  wrong: "vp-spike-0000-another-input",
} as const;
