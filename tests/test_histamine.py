"""Reading the SIGHI low-histamine list and matching USDA foods to it (histamine.py).

The sample below copies the list's layout (pdftotext -layout): rating in the
left column, reason flags, the name, a remark after a wide gap. Checks the
promises the page makes: a USDA name is tried as "second first", then "first
second", then "first"; synonyms after commas match; where one name carries
several ratings the worst is kept; canned / smoked / cured food is "avoid"
whatever the base food; a food not on the list comes back unrated (None).
"""
import histamine

SAMPLE = """\
 Animal foods
  Eggs
        2         L   egg white                                                         Mast cell activating
        0             egg yolk
   Dairy products
        2   H A       cheddar cheese
        1   H     ?   milk, lactosefree                                                 Sometimes well tolerated,
                                                                                        sometimes not.
        0      ?      milk, pasteurised
   Meat
        0 H!          beef (fresh)
        0             cream cheeses (means: very young cheeses), plain, without
                      additives
"""


def _names():
    return histamine.index(histamine.parse(SAMPLE))


def test_parse_reads_rating_flags_name_and_category():
    entry = histamine.parse(SAMPLE)[0]
    assert (entry["rating"], entry["flags"], entry["name"], entry["category"]) == ("2", ["L"], "egg white", "Eggs")


def test_parse_joins_a_remark_that_runs_onto_the_next_line():
    milk = next(e for e in histamine.parse(SAMPLE) if e["name"] == "milk, lactosefree")
    assert milk["remark"] == "Sometimes well tolerated, sometimes not."


def test_parse_joins_a_name_that_runs_onto_the_next_line():
    assert histamine.parse(SAMPLE)[-1]["name"].endswith("plain, without additives")


def test_second_segment_first_matches_cheddar_cheese():
    assert histamine.rate(_names(), "Cheese, cheddar")["rating"] == "2"


def test_first_segment_alone_matches_beef():
    assert histamine.rate(_names(), "Beef, chuck, pot roast, cooked")["verdict"] == "low"


def test_first_then_second_matches_egg_yolk():
    assert histamine.rate(_names(), "Egg, yolk, raw, fresh")["sighi_name"] == "egg yolk"


def test_one_name_with_two_ratings_keeps_the_worst():
    assert histamine.rate(_names(), "Milk, whole, 3.25% milkfat")["rating"] == "1"


def test_canned_food_is_avoid_whatever_the_base_food():
    assert histamine.rate(_names(), "Beef, canned")["verdict"] == "avoid"


def test_a_food_not_on_the_list_is_unrated():
    assert histamine.rate(_names(), "Kale, raw") is None


def test_no_list_fetched_means_no_names(data_dir):
    assert histamine.names() == {}


def test_organ_meat_is_rated_as_innards_not_fresh_meat():
    entries = histamine.parse(SAMPLE) + [{"name": "innards", "rating": "2", "flags": ["H!", "L"], "remark": "",
                                          "category": "Meat"}]
    assert histamine.rate(histamine.index(entries), "Beef, variety meats and by-products, liver")["rating"] == "2"


def test_kimchi_is_avoid_though_its_name_says_cabbage():
    assert histamine.rate(_names(), "Cabbage, kimchi")["verdict"] == "avoid"
