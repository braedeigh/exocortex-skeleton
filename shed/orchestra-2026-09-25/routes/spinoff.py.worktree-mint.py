# Shed 2026-09-25 from routes/spinoff.py, open_spinoff() — see ../SHED.md.
# This is the block as it stood before the cut: the room check, and the
# worktree mint that gave every Orchestra spinoff its own copy. It also
# wrote `worktree_failed` onto the entry and the reply when the mint failed,
# and open_spinoff() took a `worktree=None` argument (`worktree: false` on
# the route, `--no-worktree` on scripts/spinoff_open.py) to opt out.

    # The room decides where the child is rooted — the app checkout for Coding,
    # the parent of both repos for Personal, its OWN copy of the checkout for
    # Orchestra — and cwd is the one thing a session can never change
    # afterwards, which is why it's settled here at birth.
    room = lane or _inherit_lane(snapshot)
    if branch is not None and (room != "orchestra" or worktree is False):
        # Adoption IS a worktree on that branch — there is no shared-checkout
        # version of standing on a branch, so the combination is a caller bug,
        # refused loudly rather than quietly ignored.
        return {"error": "adopting a branch needs the orchestra room "
                         "and its worktree"}, 400
    profile = _lane_profile(room)
    cwd, wt_path, wt_branch, wt_error = profile["cwd"], None, None, None
    if room == "orchestra" and worktree is not False:
        try:
            wt_path, wt_branch = (worktrees.adopt(slug, branch) if branch
                                  else worktrees.mint(slug))
            cwd = str(wt_path)
        except (worktrees.WorktreeError, OSError, subprocess.SubprocessError) as e:
            if branch:
                # Adopt-mode refuses instead of degrading — see the docstring.
                return {"error": f"couldn't stand on {branch}: {e}"}, 409
            # A spinoff that couldn't get its own copy still runs, in the shared
            # checkout — the same "degraded is still usable" call _launch_runner
            # makes. But it is NOT silent: the flag rides on the entry so the
            # card can say so, because the whole point of the copy is that
            # nobody has to remember which sessions are sharing a tree.
            wt_error = f"{type(e).__name__}: {e}"
