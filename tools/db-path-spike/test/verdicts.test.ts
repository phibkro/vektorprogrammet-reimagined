/**
 * What each verdict accepts and refuses (spec 0000, the "Pass means" column). Every pass has
 * a refusal beside it, so no check can pass vacuously.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr } from "effect";

import {
  allowedRichText,
  bcryptProbe,
  codecSamples,
  xssCorpus,
} from "../src/fixtures.ts";
import {
  ClassifiedAlreadyExists,
  ClassifiedDefect,
  ClassifiedInserted,
} from "../src/protocol.ts";
import { failedIds, renderLine, renderSummary } from "../src/smoke/report.ts";
import * as Verdicts from "../src/verdicts.ts";

const connect = {
  database: "vektorprogrammet",
  drizzleOne: 1,
  hyperdriveHost: "0123abcd.hyperdrive.local",
  sqlOne: 1,
  user: "vp_app",
  version: "PostgreSQL 18.6 on aarch64-unknown-linux-gnu",
  workerVersion: "163aed3e-6aa0-41cb-8731-d0fda12cc4b6",
};

const upserted = { row: { id: 7, term: "HOST", year: 2030 } };

const exactCodecReads = Arr.flatMap(codecSamples, (sample, index) =>
  Arr.map(["drizzle", "sql"] as const, (writtenVia, offset) => ({
    drizzle: { ...sample },
    slot: index * 2 + offset,
    sql: { ...sample },
    writtenVia,
  }))
);

describe("check 1: connect", () => {
  it("passes through Hyperdrive as vp_app with both clients answering, and names the Worker version", () => {
    const verdict = Verdicts.connectVerdict(connect);

    assert.isTrue(verdict.pass);
    assert.include(verdict.evidence, connect.workerVersion);
  });

  it("fails on a direct database host, another role, or a silent client", () => {
    for (const changed of [
      { hyperdriveHost: "ep-x.eu-central-1.aws.neon.tech" },
      { user: "neondb_owner" },
      { drizzleOne: 0 },
      { sqlOne: 0 },
    ]) {
      assert.isFalse(Verdicts.connectVerdict({ ...connect, ...changed }).pass);
    }
  });
});

describe("checks 2, 3a, 3b, 4: transactions", () => {
  it("2: the committed row must be visible to a later request", () => {
    assert.isTrue(Verdicts.commitVerdict({ committed: true }, ["commit"]).pass);
    assert.isFalse(Verdicts.commitVerdict({ committed: true }, []).pass);
  });

  it("3a: a typed failure leaves no row", () => {
    const failed = { failure: "SpikeRollback" };

    assert.isTrue(Verdicts.typedRollbackVerdict(failed, []).pass);
    assert.isFalse(Verdicts.typedRollbackVerdict(failed, ["typed"]).pass);
    assert.isFalse(Verdicts.typedRollbackVerdict({ failure: "x" }, []).pass);
  });

  it("3b: the aborted transaction's key must be free and its row absent", () => {
    assert.isTrue(Verdicts.abortVerdict({ free: true }, [], 40).pass);

    const committed = Verdicts.abortVerdict({ free: false }, ["abort"], 20_000);

    assert.isFalse(committed.pass);
    assert.include(committed.evidence, "COMMITTED");
    assert.isFalse(Verdicts.abortVerdict({ free: true }, ["abort"], 40).pass);
  });

  it("4: the outer row stays and the inner row is gone", () => {
    const nested = { failure: "SpikeRollback" };

    assert.isTrue(Verdicts.savepointVerdict(nested, ["outer"]).pass);
    assert.isFalse(Verdicts.savepointVerdict(nested, ["outer", "inner"]).pass);
    assert.isFalse(Verdicts.savepointVerdict(nested, []).pass);
  });
});

describe("checks 5, 6: upsert and unique violation", () => {
  const created = upserted;
  const none = { row: null };

  it("5: DO NOTHING returns the row, then none; DO UPDATE returns the same row twice", () => {
    assert.isTrue(
      Verdicts.upsertVerdict({
        nothing: [created, none],
        update: [created, created],
      }).pass
    );
  });

  it("5: refuses a DO NOTHING that returns the row twice, or a DO UPDATE that returns none", () => {
    assert.isFalse(
      Verdicts.upsertVerdict({
        nothing: [created, created],
        update: [created, created],
      }).pass
    );
    assert.isFalse(
      Verdicts.upsertVerdict({
        nothing: [created, none],
        update: [created, none],
      }).pass
    );
  });

  it("6: only AlreadyExists passes; a defect or a success fails", () => {
    const already = ClassifiedAlreadyExists.make({
      entity: "Semester",
      key: "VAR 2030",
    });

    assert.isTrue(Verdicts.uniqueVerdict({ classified: already }).pass);

    const defect = Verdicts.uniqueVerdict({
      classified: ClassifiedDefect.make({ message: "boom" }),
    });

    assert.isFalse(defect.pass);
    assert.include(defect.evidence, "boom");
    assert.isFalse(
      Verdicts.uniqueVerdict({ classified: ClassifiedInserted.make({}) }).pass
    );
  });
});

describe("check 7: value round trips", () => {
  it("passes when every value comes back unchanged through both clients", () => {
    assert.isTrue(Verdicts.codecVerdict({ reads: exactCodecReads }).pass);
  });

  it("names the changed value, and refuses a missing read", () => {
    const [first, ...rest] = exactCodecReads;

    const shifted = first && {
      ...first,
      sql: { ...first.sql, at: "2026-03-29T00:59:59.998Z" },
    };

    const refused = Verdicts.codecVerdict({
      reads: shifted ? [shifted, ...rest] : [],
    });

    assert.isFalse(refused.pass);
    assert.include(
      refused.evidence,
      "at written through drizzle, read through sql"
    );
    assert.isFalse(Verdicts.codecVerdict({ reads: rest }).pass);
  });
});

describe("check 8: the 20-way race", () => {
  const race = {
    callers: 20,
    failures: [],
    ids: Arr.replicate(5, 20),
    rows: 1,
  };

  it("passes with one row and one id for every caller", () => {
    assert.isTrue(Verdicts.raceVerdict(race).pass);
  });

  it("fails on any failed request, a second id, or a second row", () => {
    assert.isFalse(
      Verdicts.raceVerdict({
        ...race,
        failures: ["prepared statement does not exist"],
      }).pass
    );
    assert.isFalse(Verdicts.raceVerdict({ ...race, ids: [5, 6] }).pass);
    assert.isFalse(Verdicts.raceVerdict({ ...race, rows: 2 }).pass);
  });
});

describe("check 9: the sanitizer in workerd", () => {
  const neutralised = {
    allowed: allowedRichText,
    outputs: Arr.map(xssCorpus, ([, expected]) => expected),
  };

  it("passes when every payload is neutralised as in Node and the allowed tags survive", () => {
    assert.isTrue(Verdicts.sanitizeVerdict(neutralised).pass);
  });

  it("fails on a surviving script, or a stripped allowed tag", () => {
    const leaky = {
      ...neutralised,
      outputs: [
        "<script>alert(1)</script><p>ok</p>",
        ...neutralised.outputs.slice(1),
      ],
    };

    assert.isFalse(Verdicts.sanitizeVerdict(leaky).pass);
    assert.isFalse(
      Verdicts.sanitizeVerdict({ ...neutralised, allowed: "<p>x</p>" }).pass
    );
    assert.isFalse(
      Verdicts.sanitizeVerdict({ ...neutralised, outputs: [] }).pass
    );
  });

  it("refuses output that is active even if the corpus expected it", () => {
    const outputs = Arr.map(neutralised.outputs, (output, index) =>
      index === 0 ? '<p onclick="x()">ok</p>' : output
    );

    assert.isFalse(Verdicts.sanitizeVerdict({ ...neutralised, outputs }).pass);
  });
});

describe("check 10: bcrypt", () => {
  const verified = {
    baselineMillis: 30,
    right: {
      cost: bcryptProbe.cost,
      prefix: bcryptProbe.prefix,
      verified: true,
    },
    rightMillis: 290,
    wrong: {
      cost: bcryptProbe.cost,
      prefix: bcryptProbe.prefix,
      verified: false,
    },
  };

  it("passes when the hash verifies and a wrong input does not, and reports the time above baseline", () => {
    const passed = Verdicts.bcryptVerdict(verified);

    assert.isTrue(passed.pass);
    assert.include(passed.evidence, "at most 260 ms of CPU");
  });

  it("fails when the right input is refused or the wrong one accepted", () => {
    assert.isFalse(
      Verdicts.bcryptVerdict({
        ...verified,
        right: { ...verified.right, verified: false },
      }).pass
    );
    assert.isFalse(
      Verdicts.bcryptVerdict({
        ...verified,
        wrong: { ...verified.wrong, verified: true },
      }).pass
    );
  });

  it("recognises a Workers CPU-limit refusal", () => {
    assert.include(
      Verdicts.describeRefusal(503, "error code: 1102"),
      "CPU limit"
    );
    assert.notInclude(Verdicts.describeRefusal(500, "boom"), "CPU limit");
  });
});

describe("check 11: the Hyperdrive cache", () => {
  it("passes when every read returns the value just written, and names a stale read", () => {
    const fresh = Arr.map(Arr.range(1, 10), (n) => ({ read: n, wrote: n }));

    assert.isTrue(Verdicts.cacheVerdict(fresh).pass);

    const stale = Verdicts.cacheVerdict([...fresh, { read: 3, wrote: 11 }]);

    assert.isFalse(stale.pass);
    assert.include(stale.evidence, "after writing 11 returned 3");
    assert.isFalse(Verdicts.cacheVerdict([]).pass);
  });
});

describe("the report", () => {
  const passing = {
    id: "1",
    title: "connect",
    verdict: { evidence: "ok", pass: true },
  };

  const failing = {
    id: "3b",
    title: "abort",
    verdict: { evidence: "committed", pass: false },
  };

  it("prints PASS and FAIL lines with the evidence beneath, and counts the failures", () => {
    assert.strictEqual(renderLine(passing), "PASS  1   connect\n          ok");
    assert.strictEqual(
      renderLine(failing),
      "FAIL  3b  abort\n          committed"
    );
    assert.deepStrictEqual(failedIds([passing, failing]), ["3b"]);
    assert.strictEqual(
      renderSummary([passing, failing]),
      "1 of 2 checks passed; failed: 3b"
    );
    assert.strictEqual(renderSummary([passing]), "1 of 1 checks passed");
  });
});
