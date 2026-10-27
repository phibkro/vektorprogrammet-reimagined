# @vektorprogrammet/effx-conformance

Spec 0007d (ADR 0009). The kernel exports each domain as an effx `DomainDescription` (`Effx.describe`, `packages/domain/src/kernel/effx.ts`, a pure function of the declarations). effx turns each description into conformance vectors: for every world up to its scope, which principal may run which command about which target, and which transition of each machine is enabled in which state. The tests here ask the kernel's own `authorize` and machine tables every row of those vectors. effx is not a dependency (its packages are not published, ADR 0009); what crosses is files.

## What is committed

`packages/domain/conformance/`:

| File | What it is | Made by |
| --- | --- | --- |
| `<domain>.description.json` | the export of a domain's declarations; a domain with nothing effx can state (`contact`) has none | `bun run description` |
| `gaps.json` | what effx cannot state, as typed values (`Effx.Gap`) | `bun run description` |
| `<domain>.vectors.json.gz` | effx's vectors of that description (128 MB of JSON for `teams`, 2 MB compressed; every other domain under 10 KB) | `bun run description:regenerate` |
| `provenance.json` | the effx commit, Alloy's version and executable, per domain the digest of its description and of its vectors, scope, steps, the rows compared, and effx's assertion results | `bun run description:regenerate` |
| `effx.pin.json` | the effx commit and the Alloy version that the vectors are made with | by hand: moving it is a decision |

The files are generated: the formatter leaves them alone (`vite.config.ts`), and nobody edits one.

## When a grant, a subject set or a machine changes

```sh
devenv shell -- bun run description                 # the descriptions and the register of gaps; no effx, a few seconds
EFFX_DIR=… devenv shell -- bun run description:regenerate   # the vectors and the provenance; effx, Nix, 1.5 to 2.5 minutes
```

`EFFX_DIR` is a clean checkout of `phibkro/effx` at the commit of `effx.pin.json`, with its dependencies installed:

```sh
git clone https://github.com/phibkro/effx "$EFFX_DIR" && git -C "$EFFX_DIR" checkout "$(jq -r .commit packages/domain/conformance/effx.pin.json)"
(cd "$EFFX_DIR" && bun install --frozen-lockfile --ignore-scripts)
```

`description:regenerate` makes a scratch project for each description from the `generator` of `src/artefacts.ts` (a config module around the description, and the checkout's `node_modules`), runs effx's `build` and `models check` in it (pinned Alloy 6.2.0 through `nix shell "$EFFX_DIR#alloy6"`), and writes the committed files only when effx accepts every description and every assertion passes (A1 to A7, effx spec 0032); a failing run leaves them as they were. The `generator`, files and commands, is recorded in `provenance.json`, so the way that the vectors were made can be read and replayed from the committed files, and a change to it fails a test until they are made again. It refuses an `EFFX_DIR` whose `HEAD` is not the pin, or that has local changes. Measured on 32 threads in three runs: 2 minutes 16 seconds and 7 CPU-minutes, 1 minute 38 seconds and 4 CPU-minutes, then 1 minute 46 seconds and 7 CPU-minutes; check the machine's headroom first. Runs on one commit write byte-identical files. Commit the regenerated files with the declaration that changed them.

## Does effx still make these vectors? (gate G2)

effx moves on its own. `bun run description:drift` makes the vectors again with the checkout that `EFFX_DIR` names, which may be any commit (effx's `main`, say), writes nothing, and fails when anything in the provenance of a domain differs: the vectors' digest, the instances, the assertion results. It names the first differing line per domain. `.github/workflows/effx-drift.yml` runs it every Monday against `phibkro/effx` `main`, and by hand from the Actions tab. When it fails, set the commit of `effx.pin.json` to effx's `main`, run `description:regenerate` with `EFFX_DIR` at it, read the diff and commit the files; or leave the pin where it is and let the check go red.

## What the tests check (`vp run -r test`)

`test/conformance.test.ts`, spec 0007d falsifiers 1 to 4. No Nix, no JVM and no network: they read files.

1. Every committed description is the export of the declarations now. The failure names the domain and the first line that differs. Negative controls: a grant row deleted, a scope changed and a state renamed in a declaration; a hand edit of a description.
2. The digests and the pin in `provenance.json` are those of the committed files, and the way that the vectors were made (`generator`) is the one that this tool makes them in. Negative controls: one changed character, one flipped byte, another config for effx.
3. The kernel's `authorize` and machine tables answer every row of every vectors file as the vectors say, and the number of rows compared, of each of the three kinds (authorization, transitions, `Machine.can` per command), is the number that the file's own structure asks for. Negative controls, each failing on exactly the rows it changes, and the number of them counted: a grant row removed (1,344 rows), a scope widened (9,648), a guard removed (19,584 transition rows and as many command rows); an empty vectors file.
4. The register of gaps is the export's. Negative control: a subject that effx cannot state adds a gap.

## What the vectors do not cover

effx's default scope is one atom per signature: a world has one person, one team, one department and one target. A defect that is wrong only across two departments or two people (a department check that compares nothing) is not caught here; the kernel's own rule-named tests, with two departments, are what cover it. Spec 0007d records the measurement of scope 2 and the request to effx.
