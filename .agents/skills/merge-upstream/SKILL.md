---
name: merge-upstream
description: Merge a fresh upstream T3 Code nightly into the Beknown fork — sync the pure mirror, measure the conflict surface, resolve conflicts (optionally fanned out across subagents), fix the predictable post-merge CI failures, and keep the PR current. Use whenever pulling upstream changes into expbkmain/bkmain, when asked how conflicted an upstream merge would be, or when an upstream merge PR goes red or falls behind its base.
---

# Merge upstream into the fork

This fork tracks a fast-moving upstream (`pingdotgg/t3code`, ~190 commits/week).
This skill is the end-to-end procedure plus the failure modes that have actually
bitten, so each merge costs hours instead of a day.

Read [`AGENTS.md`](../../../AGENTS.md) § "Building features that survive upstream
merges" and [expbkt3 customization boundaries](../../../docs/operations/expbkt3-customizations.md)
first — this skill assumes those rules and does not restate them.

**Merge weekly.** Conflict pain grows faster than linearly with drift: one week of
upstream (189 commits) produced 53 conflicted files. Two weeks does not produce
106 — it produces worse ones, because each conflict is reasoned about with more
surrounding drift and upstream gets time to delete files the fork has edited.

## Branch topology (get this wrong and you poison a branch)

| Branch      | What it is                                        | Merge upstream into it?                     |
| ----------- | ------------------------------------------------- | ------------------------------------------- |
| `main`      | Byte-pure mirror of upstream. Deploys nothing.    | Push upstream commits here directly         |
| `t3main`    | `main` + fork-owned deploy files. Deploys t3.dev. | Merge `origin/main` in                      |
| `bkmain`    | Production fork. Deploys bkt3.                    | Only via `expbkmain` promotion              |
| `expbkmain` | Staging fork. Deploys expbkt3.                    | Yes — every upstream merge lands here first |

**Fork branches merge from `origin/main`, never from `t3main`.** `t3main` carries
fork-owned deploy files (`.github/workflows/deploy-t3.yml`, a `.gitmodules`
gitlink) that must never enter `bkmain` lineage.

**Never rebase** these long-lived branches. Merging preserves how each conflict was
resolved; rebasing re-inflicts every conflict and rewrites published history.

## Step 1 — sync the pure mirror

The `upstream` remote exists only in the standalone clone `/home/ubuntu/repos/t3code`;
fork worktrees have `origin` only. SSH to upstream may be unavailable — fall back to
HTTPS, which needs no credentials for a public repo:

```bash
git -C /home/ubuntu/repos/t3code fetch \
  https://github.com/pingdotgg/t3code.git main:refs/remotes/upstream/main --tags
```

**Sync to a nightly-tagged commit, not the raw tip**, so the source SHA and the
displayed version move together. The tip usually has no tag yet — walk back to the
newest tagged ancestor rather than waiting or syncing an untagged commit:

```bash
cd /home/ubuntu/repos/t3code
for t in $(git tag --list 'v*-nightly.*' --sort=-version:refname | head -5); do
  sha=$(git rev-list -1 "$t")
  if git merge-base --is-ancestor "$sha" upstream/main; then echo "$t -> $sha"; break; fi
done
```

Then refresh the mirror and `t3main` (pushing `main` deploys nothing):

```bash
git push origin <nightly-sha>:refs/heads/main
git -C /home/ubuntu/repos/t3code checkout t3main
git -C /home/ubuntu/repos/t3code merge origin/main   # never force-push t3main
git -C /home/ubuntu/repos/t3code push origin t3main
```

> **Check both branches before assuming a sync happened.** These two steps are
> routinely half-done: someone merges upstream into `t3main` through the GitHub UI
> and the mirror `main` is left days behind. `t3main` being current does **not**
> mean `main` is. Verify with `git merge-base --is-ancestor <nightly-sha> origin/main`.

## Step 2 — measure before committing to the work

Always run the merge on a throwaway branch off `expbkmain` first and count the
damage. This is cheap and tells you how to staff the resolution.

```bash
git fetch origin
git checkout -b temp/upstream-merge-$(date +%Y%m%d) origin/expbkmain
git merge --no-ff --no-commit origin/main
git diff --name-only --diff-filter=U | tee /tmp/conflicts.txt | wc -l
```

Useful measurements:

```bash
# conflict hunks per file — this is your priority queue
while read f; do [ -f "$f" ] && echo "$(grep -c '^<<<<<<<' "$f") $f"; done \
  < /tmp/conflicts.txt | sort -rn

# which conflicts are legacy debt vs new
while read f; do grep -q "\"$f\"" scripts/fork-marker-baseline.json && echo "BASELINE: $f"; done \
  < /tmp/conflicts.txt

# structural cases needing special handling (not the usual 1/2/3 stages)
for f in $(cat /tmp/conflicts.txt); do
  s=$(git ls-files -u -- "$f" | awk '{print $3}' | tr '\n' ' ')
  [ "$s" != "1 2 3 " ] && echo "$f: stages=$s"   # "1 2" = upstream deleted it
done
```

`git merge --abort` restores the tree; `rerere` keeps the recorded preimages, so a
measured merge is never wasted work.

**Calibration from 2026-08-13** (189 commits, one week of drift): 665 upstream files
changed, 289 touched by both sides, **236 auto-merged (82%)**, 53 conflicted with
141 hunks. ~30 of the 53 were baseline files — the pre-ratchet inline-edit debt in
`contracts/orchestration.ts`, `ProjectionSnapshotQuery.ts`, `server.ts`, `ws.ts`,
`ChatView.tsx`. Expect that same hot set every time.

## Step 3 — resolve

**The default resolution is "keep both sides."** Around 90% of hunks are both sides
appending at the same spot — import lists, SQL column lists, schema field blocks,
route registrations. Upstream added `defaultThreadEnvMode`/`faviconPath`/`pinOrderKey`
right where the fork added `threadCreationDefaults`/`ownerUserId`/`titleManuallySet`.

Rules, in priority order:

1. Never drop an upstream change. Never drop a marked fork edit — unless upstream now
   implements the equivalent behavior, in which case prefer upstream's and say so.
2. Keep every `T3-CUSTOM(expbkt3)` comment; restore one on any fork line whose marker
   the conflict displaced.
3. Minimal diffs. No reformatting, no reordering, no opportunistic refactors.
4. Follow renames: if upstream renamed a symbol a fork line references, update the
   fork line.
5. Keep SQL coherent: a column added to a SELECT must appear in the row type and the
   mapper — for both field families.

### Fanning out across subagents

A 50-file merge splits cleanly. Group **by subsystem** so each agent holds coherent
context, and give every agent a disjoint, explicit file list:

orchestration · persistence · server-core+provider · contracts · web-chat ·
sidebar/settings · mobile

Every brief must carry these constraints, because agents share one worktree:

- No state-changing git commands (`add`/`commit`/`checkout`/`restore`/`stash`/`reset`/`rm`).
- No builds, installs, typechecks, or test runs — shared dev box, and the tree is
  mid-merge anyway.
- Touch only the listed files; **describe**, don't make, changes needed in another
  agent's file.
- Finish with zero conflict markers, then report per file: how each hunk was resolved,
  fork behavior preserved, anything dropped, uncertainty flags with `file:line`.

Give them the merge coordinates (`HEAD` = fork, `origin/main` = upstream, merge base)
and the read-only investigation commands:

```bash
git log --oneline <base>..origin/main -- <file>   # what upstream did
git diff <base> origin/main -- <file>             # upstream's side
git diff <base> origin/expbkmain -- <file>        # the fork's side
git show origin/main:<file>                       # whole upstream version
```

Agents get killed by account session limits mid-merge. That is recoverable: resume
each from its transcript with a **freshly measured** remaining-hunk list rather than
restarting it. If an agent dies after editing but before reporting, verify its files
against the tree yourself instead of trusting or re-running it.

### Special cases

**Upstream deleted a file the fork edited** (`stages=1 2`). Extract the fork's edits
with `git diff <base> origin/expbkmain -- <file>`, find the surface that replaced it,
port each still-meaningful behavior there with markers, then `git rm` the file and
`grep` for dangling references. In this merge, `SidebarV2.tsx` and
`BetaSettingsPanel.tsx` died when sidebar v2 became the default; their edits moved to
`Sidebar.tsx`/`AppSidebarLayout.tsx`. Editing a fast-churning upstream beta surface
inline is what creates this — prefer a wrapper next time.

**Migrations** (`apps/server/src/persistence/Migrations.ts`). Fork migrations live at
1000+; upstream keeps low numbers; **33–42 is a frozen legacy block that must never be
renumbered** (applied migrations are keyed `${id}_${name}`, so renumbering re-runs them
on live data). Register upstream's genuinely new migrations at the next free 1000-lane
ids, keeping upstream's file names. Drop upstream registry entries for files the fork
already remapped — otherwise they register twice. Then fix the tests: **upstream's
merge-added migration tests hardcode upstream ids** (`toMigrationInclusive: 39`) and
must be remapped to the fork's lane, with a marker.

**Structural mis-alignment.** Git sometimes puts the fork's block _after_ the
`>>>>>>>` marker while upstream's complete block sits inside the conflict — both
"sides" then look wrong. Rebuild those by hand from `git show` of each parent, and
flag them for extra scrutiny in CI. Two `ProjectionSnapshotQuery.ts` functions needed
this.

**`pnpm-lock.yaml`.** Never hand-resolve. Take upstream's and regenerate:

```bash
git checkout origin/main -- pnpm-lock.yaml
pnpm install --lockfile-only
```

## Step 4 — audit before committing

```bash
# no markers left anywhere
git grep -n '^<<<<<<< \|^>>>>>>> ' -- '*.ts' '*.tsx' '*.json' '*.yaml'

# fork behavior: per-file marker counts, merged vs pre-merge fork
git grep -c 'T3-CUSTOM' origin/expbkmain -- '*.ts' '*.tsx' | sed 's|^origin/expbkmain:||' | sort > /tmp/fm.txt
git grep -c 'T3-CUSTOM' -- '*.ts' '*.tsx' | sort > /tmp/mm.txt
join -t: -j1 <(cut -d: -f1,2 /tmp/fm.txt) <(cut -d: -f1,2 /tmp/mm.txt) \
  | awk -F: '$2>$3 {print $1": fork="$2" merged="$3}'          # investigate each
comm -23 <(cut -d: -f1 /tmp/fm.txt|sort -u) <(cut -d: -f1 /tmp/mm.txt|sort -u)  # vanished files
```

The total should _rise_ (agents mark previously unmarked lines). A per-file drop is
not automatically a bug — a `BEGIN`/`END` pair collapsing to a one-line marker looks
like a loss — but every one must be explained. Vanished files must be exactly the
ones upstream deleted.

## Step 5 — CI is the validation gate

Do **not** run repo-wide suites, builds, or typechecks on the dev server; they have
OOM-crashed it. Push the branch, open a **draft PR into `expbkmain`**, and let cloud
CI (Blacksmith) run everything. Scoped single-file runs are fine and often worth it:

```bash
cd apps/server && nice -n 10 npx vitest run <one-test-file> --maxWorkers=2
```

### The predictable post-merge failures

Every failure in the 2026-08-13 merge was one of these — **not** a bad resolution:

| Symptom                                                 | Cause                                                                                                                   | Fix                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `markers` fails: "these files are now fully marked"     | The check diffs against `merge-base(HEAD, origin/main)`, which the merge moved forward, so baselined files became clean | `node scripts/check-fork-markers.ts --write-baseline` (**never** `--force`: without it the ratchet can only shrink). Expected, not a defect |
| `TS2769 No overload matches` in an upstream test        | Upstream added a test that omits a **fork-required prop** (e.g. `isStopPending`)                                        | Pass the prop in the test, marked. Do not loosen the fork's contract                                                                        |
| `TS2739 missing properties` in an upstream test fixture | Fixture lacks fork-required schema fields (`ownerUserId`, `memberUserIds`)                                              | Add them to the fixture, marked                                                                                                             |
| `expected 133 to be 116`                                | A hardcoded count of a **derived** surface (`WEB_UI_VIRTUAL_TOOL_COUNT`) that upstream grew                             | Update it — but see below                                                                                                                   |
| Version/id assertion mismatch                           | Hardcoded app version or migration id the merge moved                                                                   | Update the assertion                                                                                                                        |

**Before bumping a derived count, prove the growth is real.** The hardcoded count is
usually the _first_ assertion in the test, so it aborts before the uniqueness and
schema-completeness checks that would catch duplicate registration. Update the number,
then run that test file locally and confirm the remaining assertions pass.

The generalisation worth remembering: **a merge-added upstream test cannot know about
fork requirements.** Expect a round of these, and fix the test rather than weakening
the fork.

Note that a first red run can mask later failures — a typecheck failure stops the job
before tests run. Budget for two or three CI rounds.

## Step 6 — keep the PR current

`expbkmain` moves while the merge is in review. Merge it back in rather than rebasing:

```bash
git fetch origin && git merge --no-ff --no-commit origin/expbkmain
```

`scripts/fork-marker-baseline.json` conflicts almost every time, because both sides
ratcheted it. Do not pick a side — one loosens the ratchet, the other falsely claims
files are clean. Write the **union**, then let the script compute the truth:

```bash
# resolve the file to the union of both lists (valid JSON), then:
node scripts/check-fork-markers.ts --write-baseline
node scripts/check-fork-markers.ts
```

After merging, GitHub reports `CONFLICTING` for a minute before it recomputes; wait
for `MERGEABLE` rather than re-resolving.

## Step 7 — deploy path

`expbkmain` → verify at expbkt3.dev.beknown.live → **only then** promote to `bkmain`.
bkt3 hosts the team's live sessions; the failure modes that matter (migrations meeting
an existing database, startup ordering, provider processes) only appear on a real
deploy. Reset `expbkmain` from `bkmain` after the promotion merges.

## Reducing next merge's cost

The 53-file conflict list _is_ the prioritised refactor queue — those files conflict
every single week. Highest-value moves, all behavior-preserving:

- `contracts/orchestration.ts` (80 markers): move fork schema fields into a fork-owned
  module and spread them into upstream `Schema.Struct`s at one marked line each.
- Projection SQL: extract fork columns into fork-owned SQL fragment constants plus row
  decorators, referenced once per query.
- `server.ts`/`ws.ts`: collapse fork route/handler registration into a single call site.
- `ChatView.tsx`/sidebar: move fork logic into `useForkX()` hooks in fork files.

Consider a scheduled CI job that dry-runs `git merge --no-commit origin/main` into
`bkmain` and reports the conflict count. It would have flagged the sidebar-v2 deletion
days early, at zero cost to the dev box.
