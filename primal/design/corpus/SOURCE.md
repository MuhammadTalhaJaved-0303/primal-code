# Vendored palette corpus

`base16/` and `base24/` here are a verbatim copy of the scheme directories of
the **tinted-theming/schemes** repository. They are vendored - not fetched at
build time - so that `primal/theme/buildThemes.ts` works with no network, and
so that a theme regenerated a year from now comes out of exactly the same
palettes it came out of today.

## Provenance

| | |
| --- | --- |
| Upstream | <https://github.com/tinted-theming/schemes> |
| Default branch | `spec-0.11` |
| Commit | `fdca32a0d14ec80ad83a78a9ccb85592ca6cb9e1` |
| Fetched | 2026-09-08 |
| Fetched via | `https://codeload.github.com/tinted-theming/schemes/tar.gz/fdca32a0d14ec80ad83a78a9ccb85592ca6cb9e1` |
| Tarball SHA-256 | `0328a0bb61673dff33ebe11db66abb7fc2f79d5f0a445a0a882a5611c1fbb92b` |
| Licence | MIT - see `LICENSE`, copied unmodified from the same commit |
| Licence SHA-256 | `7edf0999a3912df0383b383f1464e9e97c282051a4de95f651fdaa63dd224231` |

## What was copied, and what was not

Copied: `base16/` (338 files), `base24/` (196 files), `LICENSE`.

Not copied: `README.md`, `BASE16.md`, `.github/`, `scripts/`, and the `tinted8/`
directory. `tinted8` is a fourth scheme system with only four members and no
stable spec at this commit; nothing here reads it.

Nothing in `base16/` or `base24/` was edited. One upstream file is named
`base16/cyberpunk.yml` rather than `.yaml`; that is upstream's spelling and it
is preserved, which is why the reader in `primal/theme/importPalette.ts`
accepts both extensions.

Fixity, so a later reader can prove the tree is unmodified:

    cd primal/design/corpus
    find base16 base24 -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
    # 17490923aaca61d5b97c112438224d07cb32f9f276aaccd8724a1bb3303c969d

## Licence obligations

MIT requires the copyright notice and permission notice to travel with any
substantial portion of the software. `LICENSE` is that notice and it stays in
this directory. `primal/design/ATTRIBUTION.md` - generated, never
hand-maintained - additionally names the individual author of every scheme a
shipped Primal theme is derived from.

Primal never ships a theme under an upstream scheme's name. A palette is
sixteen or twenty-four hex values and MIT covers copying them; a *name* like
Dracula or Nord is a trademark question that no licence answers. See the
`FORBIDDEN_*` tables in `primal/theme/buildThemes.ts` for what is excluded and
why.

## Refreshing

Bump the commit above, re-fetch, re-copy, then re-run:

    node --experimental-strip-types primal/theme/importPalette.ts --check
    node --experimental-strip-types primal/theme/buildThemes.ts --check

The `--check` runs are the only thing that decides whether a refresh is safe:
they re-parse every scheme, regenerate every shipped theme, and diff the result
against what is on disk.
