// Run with `node --test`: Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";

import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noImplicitDateTimeZoneRule } from "./no-implicit-date-time-zone.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const implicitZone = [{ messageId: "implicitDateTimeZone" }];

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "no-implicit-date-time-zone",
  noImplicitDateTimeZoneRule,
  {
    valid: [
      // Negative controls: real named zones for both presentation and UTC calendar dates.
      'const oslo = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo" })',
      'const utc = Intl.DateTimeFormat("nb-NO", { dateStyle: "medium", timeZone: "UTC" })',
      'new Date(at).toLocaleDateString("nb-NO", { timeZone: "Europe/Oslo" })',
      'new Date(at).toLocaleTimeString("nb-NO", { timeZone: chosenZone })',
      'new Date(at).toLocaleString("nb-NO", { timeZone: "UTC" })',
      // A number's locale formatting is unrelated to calendar time zones.
      '(1234).toLocaleString("nb-NO")',
      'new Intl.NumberFormat("nb-NO").format(1234)',
      "DateTime.formatUtc(at)",
    ],
    invalid: [
      { code: 'new Intl.DateTimeFormat("nb-NO")', errors: implicitZone },
      {
        code: 'new Intl.DateTimeFormat("nb-NO", { dateStyle: "long" })',
        errors: implicitZone,
      },
      {
        code: 'new Intl.DateTimeFormat("nb-NO", { timeZone: undefined })',
        errors: implicitZone,
      },
      { code: 'Intl.DateTimeFormat("nb-NO", {})', errors: implicitZone },
      {
        code: 'new Date(at).toLocaleDateString("nb-NO")',
        errors: implicitZone,
      },
      {
        code: 'new Date(at).toLocaleTimeString("nb-NO")',
        errors: implicitZone,
      },
      { code: 'new Date(at).toLocaleString("nb-NO")', errors: implicitZone },
    ],
  }
);
