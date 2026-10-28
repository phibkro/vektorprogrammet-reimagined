# @vektorprogrammet/docgen

The generator reads the domain declarations, code policy and root grant table. It updates the marked teams and accounts reference blocks, and renders `docs/system/commands.md`: every command of every domain under the resource it acts on, with its method (ADR 0010, spec 0007c). It also renders `docs/system/store-guarantees.md` from `StoreGuarantees` and `TransactionModes` (ADR 0014 stage 2, spec 0018): each store guarantee as a property, with its strength, and the transaction mode of every port method. It preserves text outside the markers.

From the repository root, run:

```sh
devenv shell -- bun run docs        # update the blocks
devenv shell -- bun run check:docs  # fail when the blocks differ
```

The generator refuses incomplete declarations (`Domain.allProblems`: a command without its resource and method, a name or a transition that contradicts them, a tag or a pair that two commands share) and invalid markers. The check runs in `ready` and CI. Its tests change one generated character, remove one grant row and move one command to another resource without regenerating as negative controls.
