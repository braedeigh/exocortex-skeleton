"""The to-do <-> buy-list bridge.

A shopping item can live as BOTH a to-do (subtask or standalone) and a buy-list
item, linked by a {'parent','sub'} ref on the buy item. Checking the to-do off
graduates the buy item into owned active_inventory
(routes.todos._graduate_linked_buy -> routes.inventory.graduate_buy_item); marking
the buy item bought ticks the linked to-do done
(routes.inventory._mark_linked_todo_done). Both directions verified at the store
layer against an isolated tmp data dir (the `data_dir` fixture).
"""
import store
from routes.inventory import graduate_buy_item, _mark_linked_todo_done
from routes.todos import _graduate_linked_buy


def _seed(buy=None, todos=None, active=None):
    store.write("buy_list.json", {"items": buy or []})
    store.write("todos", todos or {})
    store.write("active_inventory.json", {"items": active or []})


def test_graduate_moves_buy_item_into_active(data_dir):
    _seed(buy=[{"name": "Broom", "category": "new apartment", "cost": "~$15",
               "todo": {"parent": "moveinsup", "sub": "s_broom"}}])
    item = graduate_buy_item("Broom")
    assert item is not None and item["todo"] == {"parent": "moveinsup", "sub": "s_broom"}
    assert store.read("buy_list.json")["items"] == []          # left the buy list
    active = store.read("active_inventory.json")["items"]
    assert [i["name"] for i in active] == ["Broom"]            # landed in owned
    assert active[0]["status"] == "in_use"


def test_graduate_missing_name_returns_none(data_dir):
    _seed(buy=[])
    assert graduate_buy_item("Nope") is None


def test_mark_linked_todo_done_ticks_a_subtask(data_dir):
    _seed(todos={"now": {"items": [
        {"id": "moveinsup", "text": "Move-in", "done": False,
         "subtasks": [{"id": "s_broom", "text": "Broom", "done": False}]}]}})
    _mark_linked_todo_done({"parent": "moveinsup", "sub": "s_broom"})
    assert store.read("todos")["now"]["items"][0]["subtasks"][0]["done"] is True


def test_mark_linked_todo_done_ticks_a_standalone(data_dir):
    _seed(todos={"later": {"items": [{"id": "vacuumbuy", "text": "Vacuum", "done": False}]}})
    _mark_linked_todo_done({"parent": "vacuumbuy", "sub": None})
    item = store.read("todos")["later"]["items"][0]
    assert item["done"] is True and item["done_at"]


def test_mark_linked_todo_done_noop_when_unlinked(data_dir):
    _seed(todos={"now": {"items": [{"id": "x", "text": "x", "done": False}]}})
    _mark_linked_todo_done(None)          # must not raise
    _mark_linked_todo_done({})            # must not raise
    assert store.read("todos")["now"]["items"][0]["done"] is False


def test_check_subtask_graduates_its_linked_buy(data_dir):
    _seed(
        buy=[{"name": "Broom", "todo": {"parent": "moveinsup", "sub": "s_broom"}}],
        todos={"now": {"items": [
            {"id": "moveinsup", "text": "Move-in",
             "subtasks": [{"id": "s_broom", "text": "Broom", "done": True}]}]}},
    )
    _graduate_linked_buy("moveinsup", "s_broom")
    assert store.read("buy_list.json")["items"] == []
    assert [i["name"] for i in store.read("active_inventory.json")["items"]] == ["Broom"]


def test_graduate_linked_buy_noop_when_no_match(data_dir):
    _seed(buy=[{"name": "Broom", "todo": {"parent": "other", "sub": "z"}}])
    _graduate_linked_buy("moveinsup", "s_broom")   # no link matches
    assert [i["name"] for i in store.read("buy_list.json")["items"]] == ["Broom"]
