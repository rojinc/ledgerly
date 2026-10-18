# Ledgerly

> **Ledgerly** is a working name. Renaming it is one search-and-replace plus a GitHub repo rename.

Ledgerly keeps track of money between people:

- **Gig work**: shifts for an employer, extra hours, expenses, payments and month-end invoices.
- **Shared houses**: rent, electricity, water and groceries split between housemates, with a monthly divide.
- **Personal bills**: rent, subscriptions and reminders, plus a spending overview.
- **Lend and borrow**: money lent to or borrowed from one person, even someone who never signs up.

All four use **one ledger**. Every number on a calendar, balance, invoice or report comes from the same records, so they never disagree.

## How these docs are organised

| Section | Read it when you need to know… |
| --- | --- |
| [Product](product/vision.md) | what we are building, for whom, and what is out of scope |
| [Architecture](architecture/overview.md) | how the system works and why it was designed that way |
| [Engineering](engineering/repo-structure.md) | how to write, test and ship code in this repo |
| [Collaboration](collaboration/multi-agent-workflow.md) | how people and AI agents pick up and hand off work |
| [Planning](planning/roadmap.md) | what we are building next |

## Reading order for a new contributor or agent

1. [Multi-agent workflow](collaboration/multi-agent-workflow.md): the rules of working here.
2. [System overview](architecture/overview.md): the big picture in one page.
3. [The ledger](architecture/ledger.md): the money model. Everything else builds on it.
4. [Data model](architecture/data-model.md): every table, column and index.
5. The docs listed in the GitHub issue you are working on.

## Current status

Design is complete. Code has not started. The first milestone is **M0 Foundation**; see the [roadmap](planning/roadmap.md).
