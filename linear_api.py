"""Talking to Linear from the server: its GraphQL API, with a personal key.

What this file does, in plain English. Linear (linear.app) is the outside
issue tracker the Linear room works in. Agent sessions reach it through the
`linear` MCP server, but that login lives inside Claude's own config and the
web server can't borrow it. So for the room's page to show Linear and change
it, the server calls Linear's public GraphQL API (https://api.linear.app/graphql)
itself, with a personal API key the owner made in Linear and pasted into the
page (config.linear_api_key).

Everything that crosses the wire goes through `_post`, the one seam: the
tests replace it, so no test ever reaches Linear. Nothing read here is copied
into exo.db. The board is read live, with a half-minute cache in this process
that every write clears.

The key never leaves this file except as the Authorization header. It isn't
logged, isn't put in an error message, and isn't returned to the page.

Touches: config.py (the key and the team), routes/linear_room.py (the only
caller).
"""
import json
import time
import urllib.error
import urllib.request

import config

API_URL = "https://api.linear.app/graphql"
_TIMEOUT_SECONDS = 20
# How long a board read is reused before Linear is asked again.
_BOARD_TTL_SECONDS = 30
# How many issues the board reads: the most recently updated ones.
_BOARD_ISSUE_LIMIT = 100


class LinearError(Exception):
    """Linear answered, but with an error, or couldn't be reached."""


class LinearAuthError(LinearError):
    """Linear refused the key: it's missing, revoked or mistyped."""


def _post(query, variables, key):
    """Send one GraphQL request and return its `data`. This is the only
    function that talks to Linear. Personal keys go in the Authorization
    header bare, without "Bearer"."""
    body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    request = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": key,
        "User-Agent": "exocortex/linear-room",
    })
    # Turn every failure into a LinearError with Linear's own words. An HTTP
    # error still carries a JSON body saying what went wrong.
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (ValueError, OSError):
            payload = {}
        if error.code == 401 or _is_auth_failure(payload):
            raise LinearAuthError("Linear refused the API key.") from None
        raise LinearError(_error_text(payload) or f"Linear answered {error.code}.") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise LinearError(f"Couldn't reach Linear ({type(error).__name__}).") from None
    if payload.get("errors"):
        if _is_auth_failure(payload):
            raise LinearAuthError("Linear refused the API key.")
        raise LinearError(_error_text(payload))
    return payload.get("data") or {}


def _is_auth_failure(payload):
    """Did Linear say the key itself is the problem?"""
    for error in payload.get("errors") or []:
        code = ((error.get("extensions") or {}).get("code") or "").upper()
        if "AUTHENTICATION" in code or "authenticat" in (error.get("message") or "").lower():
            return True
    return False


def _error_text(payload):
    """Linear's error messages, joined into one line for the page."""
    messages = [e.get("message") for e in payload.get("errors") or [] if e.get("message")]
    return "; ".join(messages)[:300]


def _call(query, variables=None, key=None):
    """Run a query with the configured key. If there's no key, fail as an
    auth error, the same as a bad one: either way the page asks for a key."""
    key = key if key is not None else config.linear_api_key()
    if not key:
        raise LinearAuthError("No Linear API key is set.")
    return _post(query, variables or {}, key)


# --- Reading ----------------------------------------------------------------

def viewer(key=None):
    """Who the key belongs to. Used to check a pasted key before saving it."""
    return _call("query { viewer { id name displayName email } }", key=key)["viewer"]


# The board is read in two queries, because Linear prices a query by how
# many things it could return, counting each nested list at its page size
# (50 when none is given). One query for the team and its issues and each
# issue's links went over Linear's limit ("Query too complex"). So: the team
# first, then its issues, with every nested list given a small page size.
_TEAM_QUERY = """
query BoardTeam($teamFilter: TeamFilter) {
  viewer { id name displayName }
  teams(filter: $teamFilter, first: 1) {
    nodes {
      id key name triageEnabled
      states(first: 50) { nodes { id name type position color } }
      members(first: 50) { nodes { id name displayName active } }
    }
  }
}
"""

_ISSUES_QUERY = """
query BoardIssues($teamId: ID!, $issueLimit: Int!) {
  issues(filter: { team: { id: { eq: $teamId } } }, first: $issueLimit, orderBy: updatedAt) {
    nodes {
      id identifier title url updatedAt
      state { id name type }
      assignee { id name displayName }
      project { id name }
      projectMilestone { id name }
      relations(first: 10) { nodes { type relatedIssue { identifier title state { type } } } }
      inverseRelations(first: 10) { nodes { type issue { identifier title state { type } } } }
    }
  }
}
"""

# A cache that expires after half a minute: (time read, board).
_board_cache = {"at": 0.0, "board": None}


def board(fresh=False):
    """The team's workflow states, its members, its recent issues, and who
    the key belongs to, all raw from Linear. `fresh` skips the cache."""
    now = time.monotonic()
    if not fresh and _board_cache["board"] is not None \
            and now - _board_cache["at"] < _BOARD_TTL_SECONDS:
        return _board_cache["board"]
    team_filter = {"key": {"eq": config.LINEAR_TEAM_KEY}} if config.LINEAR_TEAM_KEY else None
    data = _call(_TEAM_QUERY, {"teamFilter": team_filter})
    teams = (data.get("teams") or {}).get("nodes") or []
    team = teams[0] if teams else None
    # The team's issues, hung on the team the way the board reads them.
    if team:
        issues = _call(_ISSUES_QUERY, {"teamId": team["id"], "issueLimit": _BOARD_ISSUE_LIMIT})
        team["issues"] = issues.get("issues") or {"nodes": []}
    result = {"viewer": data.get("viewer") or {}, "team": team}
    _board_cache.update(at=now, board=result)
    return result


def forget_board():
    """Drop the cached board, so the next read shows a write that just
    happened."""
    _board_cache.update(at=0.0, board=None)


_ISSUE_QUERY = """
query Issue($id: String!) {
  issue(id: $id) {
    id identifier title description url
    state { name }
    assignee { name displayName }
    project { name }
    projectMilestone { name }
    comments(first: 10) { nodes { body createdAt user { name displayName } } }
  }
}
"""


def issue(issue_id):
    """One issue in full: its description and latest comments too. This is
    what a "Work on this" session is briefed with."""
    return _call(_ISSUE_QUERY, {"id": issue_id}).get("issue")


# --- Writing ----------------------------------------------------------------

def update_issue(issue_id, changes):
    """Change an issue's fields. The routes only ever pass `stateId` or
    `assigneeId`."""
    data = _call("""
      mutation Update($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }""", {"id": issue_id, "input": changes})
    forget_board()
    if not (data.get("issueUpdate") or {}).get("success"):
        raise LinearError("Linear didn't accept the change.")


def add_comment(issue_id, body):
    """Post a comment on an issue, as the key's owner."""
    data = _call("""
      mutation Comment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }""", {"input": {"issueId": issue_id, "body": body}})
    forget_board()
    if not (data.get("commentCreate") or {}).get("success"):
        raise LinearError("Linear didn't accept the comment.")


def create_issue(team_id, title, description, state_id):
    """Make a new issue in a team, in the given status. Returns its
    identifier and link."""
    issue_input = {"teamId": team_id, "title": title, "stateId": state_id}
    if description:
        issue_input["description"] = description
    data = _call("""
      mutation Create($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier url } }
      }""", {"input": issue_input})
    forget_board()
    created = data.get("issueCreate") or {}
    if not created.get("success") or not created.get("issue"):
        raise LinearError("Linear didn't create the issue.")
    return created["issue"]
