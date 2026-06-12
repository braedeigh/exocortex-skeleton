"""Kitchen routes, split by concern.

The kitchen grew into the app's biggest feature, so it's a package rather than
one module. Each submodule owns one concern and exposes the usual register(app):

  groceries — the active grocery list + pantry, categories/aisles, the item
              catalog (category_map, purchase_counts, notes), meal notes, trips
  meals     — weekly meal-prep defaults and generate-list (meal plan → list)
  receipts  — receipt photo upload → Claude-in-tmux parse → review → import
  recipes   — recipe URL/photo parse pipeline + saved-recipe CRUD + to-grocery
  shared    — helpers used across submodules (tmux agent sessions, slugs,
              grocery categorization rules)

server.py keeps calling kitchen.register(app) exactly as before.
"""
from . import groceries, meals, receipts, recipes


def register(app):
    groceries.register(app)
    meals.register(app)
    receipts.register(app)
    recipes.register(app)
