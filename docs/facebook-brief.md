# Brief: Facebook chats in Recall

Steve can find a Facebook conversation by person, date or words, then read the original exchange in order. The archive stays distinct from coding sessions inside the existing Recall database.

## Scope

- Import the newest personal archive and the structured older export.
- Preserve wording, names, timestamps, attachment references and source locations.
- Keep exports as separate snapshots; search the newest by default.
- Re-importing the same files adds nothing.
- Keep the original archive files intact; never fetch external links.

## Decisions

- Dedicated Facebook tables in Recall's existing database: Steve agrees.
- Build the importer and search support: Steve authorizes the start on November 5, 2026.
- Live import and deployment: pending a tested implementation and Steve's approval.

## Where things stand

- The local archive is unpacked and inspected.
- Implementation and isolated verification follow this brief.
