# Changelog

All notable changes to `@twovmodules/n8n-nodes-sourcetodocs` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-11-06

### Changed

- **Optional fields are now under Options.** On Document → Generate, **Additional Data Sets**,
  **Deliver to**, **Idempotency Key**, **Max Wait**, **Poll Every**, **Unknown Fields** and
  **Wait for Completion** moved into an **Options** collection; on Run → Get, **Max Wait** and
  **Summary Only** did too. They behave as before, an empty Options collection is the same as the
  old defaults, and it applies to node versions 1 and 1.1 (Run → Get's Max Wait exists from 1.1).
  A workflow saved with 1.0.0 loses the values it held for these fields when it is opened or run,
  because n8n drops the old top-level values without an error. A node with Wait for Completion off
  waits again, a node with its own Idempotency Key switches to the automatic key, a Deliver to
  subset becomes every enabled distribution, an Unknown Fields of Refuse goes back to Drop, and
  Additional Data Sets are lost. Set them again under Options.
- **The Document picker lists the whole workspace.** From List shows every document as
  `Project / Document`, and typing matches that whole name. The Project filter of Document → Get and
  Generate is now optional and sits under **Options**: leave it out to list every document, or pick a
  project to narrow the list. It only filters the list and is never sent. A workflow that had a
  top-level Project set loses it, with no other effect. Document → Get Many still requires its
  Project. This needs a SourceToDocs backend that lists the workspace's documents. Projects that
  share a name show the first four characters of their ID after the name, such as `Sales · 3f2a`.
- **Simplified output keeps ten fields.** At node version 1.1, Simplified on Generate and Run → Get
  returns `run_id`, `status`, `file_url`, `file_name`, `split_key`, `file_count`, `deliveries`,
  `warnings`, `error_code` and `error_message` (a batch's files also keep `batch_run_id`). `kind`,
  `page_count`, `progress`, `folder_url`, `generation_stats`, `document_id` and the timestamps are
  in Raw and Selected Fields. Node version 1's output is unchanged. A node saved with 1.0.0 at
  version 1.1 no longer gets `kind`, `progress`, `folder_url`, `page_count`, `generation_stats`,
  `document_id`, `processing_started_at` or `finished_at` under Simplified, and an expression that
  reads one of them gets nothing: set Output to Raw.
- **Document → Get has an Output option** (node version 1.1): Simplified, the default, Raw and
  Selected Fields. Simplified turns a Data Set's columns into a list of names and leaves out their
  `choices`. A Document → Get saved with 1.0.0 at version 1.1 now returns Simplified instead of the
  full document, so an expression such as `data_sets[0].columns[0].name` changes: set Output to Raw.
- **A hint warns that Generate starts one run for all input items.** It shows before execution when
  Rows Come From is Connected Data Sources and more than one item arrives, and points to Loop Over
  Items for one document per item.
- **Tooltips are shorter,** the long explanations moved to the README, and **Wait for Completion**
  and **Deliver to** follow n8n's title case.

## [1.0.0] - 2026-10-13

First public release.

### Added

- **The SourceToDocs node** (node versions 1 and 1.1; 1.1 is the default for a node you add), with a
  **SourceToDocs API** credential: an API Token and a Base URL, with a Test button.
- **Document → Generate.** One request per execution, however many items arrive. Rows come from the
  Document's connected data sources, from this workflow as JSON, or from this workflow through
  **Map Columns** (n8n's column mapper, Map Each Column Manually or Map Automatically). Rows for
  other Data Sets go in **Additional Data Sets**. **Unknown Fields** drops, or refuses, row fields
  that are not one of the Data Set's columns, and reports what it dropped as `dropped_keys`.
- **Deliver To** picks a subset of the Document's destinations; a split Document produces one file
  per key, listed one item per file.
- **Wait For Completion** with **Max Wait** and **Poll Every**; a run that is still going when
  Max Wait ends comes back as an item with `timed_out: true` and the run's ID, to poll later with
  Run → Get. Retried answers honour `Retry-After`, and every wait ends when the execution is
  stopped.
- **Retry On Fail resumes the run.** The node sends its own idempotency key unless you set one, so
  a retry adopts the run the first try started (`idempotent_replay: true`), and a run that ended
  with status `failed` is followed by one new run.
- **Reads:** Project → Get Many, Document → Get Many, Document → Get and Run → Get, with **Return
  All** and **Limit** on the two lists. Run → Get flattens a run the same way Generate does and
  lists a batch's files, within its own **Max Wait** (node version 1.1).
- **Output** (node version 1.1): Simplified, Raw or Selected Fields. Version 1 keeps the
  **Simplify** switch. The output item carries `file_url`, `file_name`, `status`, `deliveries`,
  `warnings`, `generation_stats`, `folder_url` and, for a split Document, `split_key`.
- **What the rows said about themselves:** `empty_columns`, `empty_rows` and `missing_split_keys`
  on the item, each with a hint in the output panel.
- **Errors:** a refusal from the API is a node error that names the code and says what to do next,
  with a link to that code's entry in the troubleshooting guide. An API Token refused too many times from
  one address (`authentication_rate_limited`) is not retried: the message tells you to check the token. The messages for a request over the 2 MiB body
  limit and for too many rows say how to get unstuck. With On Error set to Continue, an error is one
  flat item; with Continue (using error output) it is `{ error, details }` on the error output,
  and a failed batch becomes one item per failed file.
- **An AI tool.** The node can be an AI Agent's tool, and every operation and parameter is described
  for the agent. The credential is restricted to this node and its tool variant.
- **Safety:** the Base URL must use `https`; redirects are never followed; every request times out
  after 30 seconds; every ID that reaches a URL or the request must be a UUID; a long message from the server is cut before it is
  shown.
- **Three importable workflow templates:** a weekly report from CRM deals, one invoice per
  customer, and generate a document from an n8n Form submission. They only act on files that
  succeeded (the report and form templates also accept a run that finished with warnings).
- A **codex** file, so a search for "invoice", "PDF", "Google Slides" or "mail merge" in the nodes
  panel finds the node.
