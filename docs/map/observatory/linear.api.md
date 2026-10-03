---
id: linear.api
name: Linear API client
kind: module
parent: linear
sources:
  - linear_api.py
fingerprint: 833b0ab9ef73
written: 2026-10-02
---

This module calls Linear's GraphQL API from the server, with the personal key. One function sends every request, so the tests can replace it. The board is read live with a short cache, and nothing of it is stored.
