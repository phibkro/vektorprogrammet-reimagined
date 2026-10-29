# ttsc-edges (spike, spec 0023)

A check-stage `ttsc` plugin in Go: it loads the project's Program and writes every module resolution (containing file, specifier, resolved file, loaded target) to the file named by `TTSC_EDGES_OUT`. Kept on the branch `spike/ttsc`; not meant to be merged.

Reproduce (from the repository root, inside `devenv shell`):

```sh
# one tsconfig per unit that turns off the language-service entry (ttsc refuses a plugin entry with no "transform")
# and adds this plugin
jq '.compilerOptions.plugins[0].enabled=false | .compilerOptions.plugins += [{"transform":"./tools/ttsc-edges/plugin.ts"}]' \
  tsconfig.json > tsconfig.ttscedges.json
jq '.extends="../../tsconfig.ttscedges.json"' packages/domain/tsconfig.json > packages/domain/tsconfig.ttscedges.json
TTSC_EDGES_OUT=/tmp/edges.json bunx ttsc --noEmit -p packages/domain/tsconfig.ttscedges.json
```

The first run builds the plugin with ttsc's bundled Go (60 s with an empty Go cache on 32 threads). The comparison scripts are in `docs/specs/0023-ts71-compiler-edges-spike.md`, appendix B.
