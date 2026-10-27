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
EFFX_DIR=… devenv shell -- bun run description:regenerate   # the vectors and the provenance; effx, Nix, about 2.5 minutes
```

`EFFX_DIR` is a clean checkout of `phibkro/effx` at the commit of `effx.pin.json`, with its dependencies installed:

```sh
git clone https://github.com/phibkro/effx "$EFFX_DIR" && git -C "$EFFX_DIR" checkout "$(jq -r .commit packages/domain/conformance/effx.pin.json)"
(cd "$EFFX_DIR" && bun install --frozen-lockfile --ignore-scripts)
```

`description:regenerate` runs effx's `build` and `models check` on each description in a scratch project (pinned Alloy 6.2.0 through `nix shell "$EFFX_DIR#alloy6"`), and writes the committed files only when effx accepts every description and every assertion passes (A1 to A7, effx spec 0032); a failing run leaves them as they were. It refuses an `EFFX_DIR` whose `HEAD` is not the pin, or that has local changes. Measured on 32 threads: 2 minutes 16 seconds, 7 CPU-minutes; check the machine's headroom first. Commit the regenerated files with the declaration that changed them.

## What the tests check (`vp run -r test`)

`test/conformance.test.ts`, spec 0007d falsifiers 1 to 4. No Nix, no JVM and no network: they read files.

1. Every committed description is the export of the declarations now. The failure names the domain and the first line that differs. Negative controls: a grant row deleted, a scope changed and a state renamed in a declaration; a hand edit of a description.
2. The digests and the pin in `provenance.json` are those of the committed files. Negative control: one changed character, one flipped byte.
3. The kernel's `authorize` and machine tables answer every row of every vectors file as the vectors say, and the number of rows compared is the number that the file's own structure asks for. Negative controls, each failing on exactly the rows it changes: a grant row removed, a scope widened, a guard removed; an empty vectors file.
4. The register of gaps is the export's. Negative control: a subject that effx cannot state adds a gap.

## What the vectors do not cover

effx's default scope is one atom per signature: a world has one person, one team, one department and one target. A defect that is wrong only across two departments or two people (a department check that compares nothing) is not caught here; the kernel's own rule-named tests, with two departments, are what cover it. Spec 0007d records the measurement of scope 2 and the request to effx.
