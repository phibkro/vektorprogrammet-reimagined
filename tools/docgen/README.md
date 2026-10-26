# @vektorprogrammet/docgen

The generator reads the domain declarations and the root grant table. It replaces four marked blocks in `docs/system/teams.md`: who does what, the Membership diagram, commands and grants, and subject sets. It preserves text outside the markers.

From the repository root, run:

```sh
devenv shell -- bun run docs        # update the blocks
devenv shell -- bun run check:docs  # fail when the blocks differ
```

The generator refuses incomplete declarations and invalid markers. The check runs in `ready` and CI. Its tests change one generated character and remove one grant row as negative controls.
