# Changelog

All notable changes to `@twovmodules/n8n-nodes-sourcetodocs` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-11-06

### Changed

- **Optional fields are now under Options.** On Document → Generate, **Deliver To**, **Wait For
  Completion**, **Max Wait**, **Poll Every** and **Idempotency Key** moved into an **Options**
  collection; on Run → Get, **Summary Only** and **Max Wait** did too. They behave as before, and an
  empty Options collection is the same as the old defaults. This applies to node versions 1 and 1.1.
  A workflow saved with 1.0.0 loses the values it held for these fields when it is opened or run: n8n
  drops the old top-level values without an error. A node with Wait For Completion off waits again, a
  node with its own Idempotency Key switches to the automatic key, and a Deliver To subset becomes
  every enabled distribution. Set them again under Options.
- **The Document picker lists the whole workspace.** Document → Get and Generate no longer have a
  **Project** filter: From List shows every document as `Project / Document` and searches both
  names. A workflow that had a Project set simply loses it, with no other effect. Document → Get
  Many still takes a Project.
- **Unknown Fields and Additional Data Sets are under Options too.** **Unknown Fields** (JSON and Map
  Columns rows) and **Additional Data Sets** (Map Columns) moved into Generate's **Options**, with
  their old behaviour and the same defaults. A workflow saved with 1.0.0 that set **Unknown Fields** to
  Refuse goes back to Drop, and its Additional Data Sets are lost; set them again under Options.
- **Simplified output keeps ten fields, and Document → Get has an Output option.** At node version
  1.1, Simplified on Generate and Run → Get returns `run_id`, `status`, `file_url`, `file_name`,
  `split_key`, `file_count`, `deliveries`, `warnings`, `error_code` and `error_message` (a batch's
  files also keep `batch_run_id`); `kind`, `page_count`, `progress`, `folder_url`,
  `generation_stats`, `document_id` and the timestamps are in Raw and Selected Fields. Document →
  Get (version 1.1) now offers Simplified (the default), Raw and Selected Fields: Simplified turns
  a Data Set's columns into a list of names and leaves out their `choices`, so use Raw for those.
  Version 1 is unchanged.

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
