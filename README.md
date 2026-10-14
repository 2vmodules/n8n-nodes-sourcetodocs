# @twovmodules/n8n-nodes-sourcetodocs

The [SourceToDocs](https://sourcetodocs.com) node for [n8n](https://n8n.io/) does document
generation: it generates Google Slides and Google Docs documents (with an optional PDF alongside)
from the rows flowing through your workflow — **a weekly report from your CRM rows**, or **one
invoice PDF per customer** through a single split Document, in the way of a mail merge. It also reads your projects, documents and runs, so a workflow can pick
a Document by name, see its Data Sets' column names before sending a row, and poll a run's
outcome without using Generate's own wait.

n8n is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow
automation platform.

- [Installation](#installation)
- [Operations](#operations)
- [Credentials](#credentials)
- [Compatibility](#compatibility)
- [Usage](#usage)
- [Resources](#resources)
- [Version history](#version-history)
- [Development](#development)
- [License](#license)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and install `@twovmodules/n8n-nodes-sourcetodocs`. On n8n Cloud, look for **SourceToDocs** in the nodes
panel once the node is verified.

## Operations

| Resource | Operation | What it does |
| --- | --- | --- |
| Project | Get Many | List every project in the workspace |
| Document | Get Many | List the documents of a project |
| Document | Get | Get a document: its Data Sets (with column names), its split configuration and its Distributions |
| Document | Generate | Start a run — from the Document's connected sources, or from rows sent in this workflow — and return the produced file's link |
| Run | Get | Get a run's status, its file and its deliveries; a batch also lists its children unless Summary Only is on |

Project → Get Many, Document → Get Many and Document → Get return the API's own objects as
items, unmodified. Run → Get flattens **every** item exactly as Generate does — an ordinary run,
a Summary Only batch, and each child alike — so the next node reads `file_url` at the top level
either way. Generate and Run → Get both offer **Output** (below) to keep or drop the full `run`
object from each item; Document → Get always returns the API's raw object.

Project → Get Many and Document → Get Many (version 1.1) have **Return All** (on) and **Limit**
(50, shown when Return All is off). The API has no paging, so Limit cuts the list the node
already has, in one request. A Limit that is not a whole number of at least 1 is refused.
Version 1 has neither and returns everything.

## Credentials

You need a SourceToDocs account with a workspace ([app.sourcetodocs.com](https://app.sourcetodocs.com));
the API Token is created in that workspace, on its **API Tokens** page. Only a workspace owner or admin can create an API Token: a member asks one of them.

Create a **SourceToDocs API** credential with:

| Field | Value |
| --- | --- |
| API Token | A workspace API Token from the **API Tokens** page in the SourceToDocs app. It starts with `wsk_` and is shown once, when it is created. |
| Base URL | `https://app.sourcetodocs.com/api/public/v1`. Keep the default. |

The token is sent as `Authorization: Bearer <token>`. It may do everything the Public API
exposes, for its own workspace and nothing else. The credential is restricted to this node (and
its AI tool variant): n8n refuses to save a workflow where another node, an HTTP Request node for
example, uses it.

**Base URL must use `https`.** A plain `http` address is refused before a request is made, with
an error naming Base URL, because every request carries the token. The node also never follows a
redirect (a redirect would send the token on to another address): an answer such as `301` or
`302` becomes an error that says to set Base URL to the API root.

**Test** in the credential dialog lists the workspace's projects (`GET /projects`) and **sends
the API Token to the Base URL you entered**, so check the address before you press it. It reports
four cases in their own words: a rejected token (`401`), a Base URL where nothing answers (`404`),
the rate limit (`429`), and a `200` that is not the Public API's JSON — Base URL set to the app
itself, for example, which answers with its HTML page. Test does not apply the `https` rule: that
check runs when the node makes a request.

## Compatibility

Built and tested against n8n 2.36.9 (self-hosted), with n8n's own engine in the test suite. It
uses recent n8n features (a credential restricted to one node, `@version` display rules, resource
mappers, the AI tool variant), so keep n8n current; earlier versions are untested. The node works as a tool for n8n's AI Agent; on a self-hosted n8n, using a
community node as an AI tool may need to be switched on in the instance's settings (see n8n's
documentation on community nodes as tools). It has no runtime dependencies.

## Usage

### Generate a report from your CRM rows

This is the [`weekly-report-from-crm-deals.json`](https://github.com/2vmodules/n8n-nodes-sourcetodocs/blob/main/templates/weekly-report-from-crm-deals.json)
template end to end: a CRM's rows become a document, with no mapping step.

1. Add a node before SourceToDocs that produces one item per row you want in the report — an
   Airtable or HubSpot **Get Many**, a Postgres query, a Set node, anything. Each item's `.json`
   becomes one row.
2. Add the **SourceToDocs** node, credential attached, **Resource: Document**,
   **Operation: Generate**.
3. Pick **Project**, then **Document** — From List once a Project is picked, or paste the
   document's URL from the app (`.../documents/show/<id>`), or its ID directly.
4. Set **Rows Come From** to **This Workflow — JSON**. The **Data Sets** collection appears, already
   holding one entry with **Rows** pre-filled:

   ```
   {{ $input.all().map(i => i.json) }}
   ```

   Pick a **Data Set** for that entry — its own dropdown description lists the Data Set's
   column names, which is exactly what each row's fields must spell, case included.
5. Leave **Unknown Fields** on **Drop** (the default). Most upstream nodes add their own fields to
   every item they produce on top of the ones you actually picked — an Airtable read carries
   `id`/`createdTime`, an n8n Form Trigger submission carries `submittedAt`/`formMode` — so the
   node removes anything that is not one of the Data Set's own columns before sending, and
   reports what it removed as `dropped_keys` on the output item (one array per Data Set, only
   where something was actually dropped). This is what makes step 4's plain
   `{{ $input.all().map(i => i.json) }}` work straight off an Airtable or Form Trigger node with
   no projection step: a genuine typo in a column name you *did* mean to send still shows up in
   `dropped_keys`, it just does not fail the run. Switch to **Refuse** when you want the opposite
   trade — every field sent exactly as given, and a stray field becomes the API's own `422
   inline_column_unknown` naming it, rather than being silently removed. **Drop** reads the
   Document once before the run (one extra `GET`) to learn each Data Set's columns; **Refuse**
   sends the rows as given and does not read it.
6. Leave **Deliver To** empty to use the Document's own distributions, or pick a subset.
7. Leave **Wait For Completion** on (the default). **Max Wait** (300 s) and **Poll Every**
   (5 s) control how long and how often the node polls before giving up; the bounds are in
   [Wait or poll](#wait-or-poll).
8. Run it. The output item carries `file_url` and `file_name` at the top level — hand those
   straight to a Slack, email or HTTP node. **Output** (default **Simplified**) keeps the
   flattened fields; **Raw** adds the complete run object the API returned, under `run`; see
   [Node versions and the Output option](#node-versions-and-the-output-option).

Two things about the input. First, **with 0 input items the node does not run** — n8n skips a
node that receives nothing, so a scheduled report whose upstream node found no rows generates
nothing and says nothing. To run it anyway, turn **Always Output Data** on in the settings of
the node before SourceToDocs: it then runs once, on one empty item (in JSON mode that item
is sent as one blank row, which the output reports as `empty_rows: 1`). Second, **every
parameter except the Map Columns cells reads the first input item only**: a Document, Deliver
To or Idempotency Key written as an expression such as `{{ $json.doc }}` takes item 0's value
for the whole run, because Generate makes one request however many items arrive. Only the
Map Columns cells are resolved once per item. (The read operations, Project, Document and Run,
do run once per item.)

The node's parameters, in order, for reference:

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| Project | options | — | Only filters the Document picker; never sent |
| Document | resource locator | — | From List / ID / URL |
| Rows Come From | options | Connected Data Sources | `connected`, `workflow` (This Workflow — JSON) or `mapped` (This Workflow — Map Columns) |
| Data Sets | collection | one empty entry | shown for `workflow` only |
| → Data Set | options | — | per entry; its description lists column names |
| → Rows | json | `{{ $input.all().map(i => i.json) }}` on the first entry | an array of row objects; a run takes a request body of up to 2 MiB (about 15 000 ordinary rows) and up to the plan's row limit per Data Set, see [Limits](#limits) |
| Data Set (Map Columns) | options | — | shown for `mapped` only; the one Data Set whose columns are mapped |
| Columns | resource mapper | Map Each Column Manually | shown for `mapped` only; see [below](#map-columns-instead-of-writing-json) |
| Additional Data Sets | collection | empty | shown for `mapped` only; JSON rows for other Data Sets |
| Unknown Fields | options | `Drop` | shown for `workflow` and `mapped`; `drop` or `refuse` |
| Deliver To | multi-select | none | the Document's enabled Distributions; one that was deleted or disabled is ignored by the API, the others still get the file |
| Wait For Completion | boolean | `true` | |
| Max Wait | number (s) | `300`, at least Poll Every, at most `3600` | shown while waiting |
| Poll Every | number (s) | `5`, at least `2`, at most `3600` | shown while waiting |
| Idempotency Key | string | empty | empty: the node sends its own key; see [Retry On Fail](#retry-on-fail). An expression may give text or a number (a number is used as its text); one that gives nothing, or anything else, stops the node before it sends anything |
| Output | options | `Simplified` | node version 1.1 and later: `Simplified`, `Raw` or `Selected Fields` |
| Fields | multi-select | `run_id`, `status`, `file_url` | shown for `Selected Fields` only; `run_id` (and `batch_run_id` on a batch's files) is always kept, so a timed-out item can still be polled |
| Simplify | boolean | `true` | node version 1 only; off keeps the full run object under `run` |


Every id the node puts in a URL or in the request — the Document in any of its three modes, the
Project, the Run, a Data Set, a Deliver To entry — must be a UUID. Anything else, an expression
or an AI agent's value included, is refused before any request, with an error that names the
parameter.

Three ways to get rows into **Rows**, all from the field's own hint:

```
all input items:                {{ $input.all().map(i => i.json) }}
an array field of the items:    {{ $input.all().flatMap(i => i.json.Lines) }}
another node's items:           {{ $('Get lines').all().map(i => i.json) }}
```

### Map columns instead of writing JSON

The CRM recipe above sends JSON. When each incoming item is one row — a Form submission, an
Airtable record, a webhook call — pick **Rows Come From: This Workflow — Map Columns** and map
the columns the way you would in Google Sheets or Airtable. Which choice to make:

| Rows Come From | Pick it when |
| --- | --- |
| **Connected Data Sources** (default) | The Document reads its own sources and nothing comes from the workflow. |
| **This Workflow — Map Columns** | One row per incoming item. Pick a Data Set, map a value into each column, no JSON. |
| **This Workflow — JSON** | Rows come from another node, from an array inside an item, or for several Data Sets at once — the [invoice recipe](#one-invoice-per-customer) stays JSON. |

With Map Columns:

1. Pick the **Document**, then the **Data Set** (shown only in this mode). The **Columns** mapper
   fills with that Data Set's Table columns, in the order SourceToDocs lists them.
2. **The columns the Data Set selects in the app are shown at once; every other column of its
   Table is in the mapper's "add column" list**, because the API accepts any column of the Table.
   A Data Set that selects no column shows all of them. A column's type only picks the
   input: a date column gets n8n's date picker, a **select** column whose choices the API
   publishes gets a dropdown of them, and every other column — number and true/false included —
   is a **text field**. Values are sent as the mapping resolves them: n8n does not convert or
   check them, and the SourceToDocs API decides what a row may hold, as in JSON mode. See
   [What the mapper sends](#what-the-mapper-sends) for the exact result of each kind of value.
3. Choose how to map, with the mapper's own switch:
   - **Map Each Column Manually** — drag or type a value into each shown column. Exactly those
     values are sent: one row per input item, each item's expressions read against that item.
     Unknown Fields does not apply to these rows. If no input item carries any mapped value the node
     stops before sending anything. The error names the shown columns whose expressions resolved
     to nothing and suggests a Split Out node (or `.map(...)` for a list field) first; picking
     another Document or Data Set resets the mapping, so map the columns again (or use Map
     Automatically).
   - **Execute Once** on the SourceToDocs node: Map Columns then sends only the first item's row
     (JSON mode's `$input.all()` still sees every item). The node adds a hint to the output
     panel saying so; for several rows use Rows Come From: This Workflow — JSON.
   - **Map Automatically** — every input item's own fields are sent as its row. **Unknown Fields**
     then works exactly as in JSON mode: **Drop** (the default) removes fields that are not the
     Data Set's columns — an Airtable `id`/`createdTime`, a Form's `submittedAt` — and reports
     them as `dropped_keys`; **Refuse** sends them and the API's `422 inline_column_unknown` names every unknown key (up to 20).
   - **A split Document needs its key.** If the Document splits, map the split's key column(s)
     (the split's Driver table column, for example the customer's email) — or use Map
     Automatically or JSON. A row with no key produces no file: the run succeeds with
     `file_count` 0 and no error. Where the API can name the key columns (see below) the node
     reads the Document and, when every item leaves a key column empty, still sends the run but
     adds `missing_split_keys: [<column>, …]` to the output item and a hint.
4. Rows for **other** Data Sets go in **Additional Data Sets**, the same collection as Data Sets
   in JSON mode (Rows is a JSON array, often `{{ $('Other node').all().map(i => i.json) }}`). The
   Data Set you mapped may not also be listed there: the node refuses that before sending anything.

The request is still one Generate per execution, however many items arrive. As a tool for an AI
Agent, each mapped column can be handed to the model with n8n's "let the model define this
parameter" button, so an Agent fills the columns one by one instead of composing a JSON array
(read [Use it as an AI tool](#use-it-as-an-ai-tool) first).

#### What the mapper sends

A mapped value is sent as it resolved. Measured on n8n's engine, on a text, number and date column:

| You map | What goes in the row |
| --- | --- |
| `{{ $json.str }}` where it is the text `12` | `"12"`, not the number |
| the number `0`, the boolean `false` | `0`, `false` |
| a resolved `null` | `null` |
| `{{ $json.empty }}` where it is `''`, `{{ '' }}`, a bare `=`, or an empty literal in a number column | `""` (the API renders it as an empty cell) |
| `{{ $json.missing }}`, a key the item does not have | the key is left out of the row |
| `{{ }}` | not sent: n8n raises "invalid syntax" |
| a date such as `2026-03-01`, or `{{ $now }}` | the text, or an ISO 8601 string carrying the instance's UTC offset |

So only a value that really resolved to `null` goes as `null`; "no value" is usually `""` or a
missing key. The one literal n8n itself refuses before the run is a wrong-typed value in a
field that has a type: an empty literal in a date column ("expects a dateTime") or, for a column
a node saved before the number and true/false fields became text, text in a number column. That
stops the workflow with a workflow-issue error and sends nothing; an expression is never checked.

#### Columns, rows and keys the node reports

The run is sent in each of these cases; the output item says what was missing.

- **`empty_columns`** — a column the mapper shows (one you have not removed from the mapper)
  whose value is `undefined` or `null` in **every** input item, typically an expression that read
  a list field (`{{ $json.clients.name }}`) or a field the items do not have. A column that is
  empty in only some items is normal and is not listed. The node also adds a hint suggesting a
  Split Out node before it, or `.map(...)` on the list. Map the column, or remove it from the
  mapper, to silence it.
- **`empty_rows`: n** — rows that are `{}` in everything sent from this workflow (an item with
  only binary data, for example, or a row whose fields all went away under Unknown Fields: Drop,
  because none matched a column), plus a hint. This covers Map Automatically, Additional Data
  Sets and JSON mode.
- **`missing_split_keys`** — see the split Document above.

Number and true/false columns used to be seeded by n8n's editor with `0` and `false`, which
then rendered as a real 0 or "No". Now they are text fields and an untouched one stores nothing.
A Map Columns node you saved before that keeps what it stored, **`0` and `false` included**: n8n
does not refresh the stored mapping when you open or save the node. Set those values yourself, or
add a fresh SourceToDocs node.

A **select** column offers the published choices as a dropdown. The API publishes them for
Airtable single and multiple selects, for a Google Sheets column with a list validation, and for
a CSV column the Data Set types as a select with a list; any other select stays a free-text
field. A literal value that is not in the list stops the workflow before the run (n8n checks it,
for example when a choice was added in the source after the mapper's columns were stored);
refresh the mapper's columns, or map it with an expression, which is sent as it is. Because the
mapper reads the Document, each Map Columns run costs one extra `GET` of it per execution
(Unknown Fields: Drop makes the same read in JSON mode; one read serves both).

### One invoice per customer

This is the [`one-invoice-per-customer.json`](https://github.com/2vmodules/n8n-nodes-sourcetodocs/blob/main/templates/one-invoice-per-customer.json) template:
one Generate call produces one invoice per customer, each emailed to its own recipient — a
split document used the way it is meant to be used from an integration. An **If** node,
**Has an invoice?**, sits before Gmail and lets through only items whose `status` is `succeeded`
and that have a `file_url`. Every other item (a file that failed, was cancelled or finished with warnings, or a batch that
timed out or produced nothing) goes to a **No invoice, not emailed** node, so you can see which
customers got nothing, and the execution does not fail. The exception is a batch in which every
file failed: the batch is `failed`, so the node stops the workflow with the failure.

Airtable returns a linked-record field as record ids and a lookup field as an array of scalars,
never as row objects — so a customer row's own `Lines` field cannot hold line-item objects to
`flatMap` over. The two tables have to come from **two separate reads**, joined only by a column
your own data carries, not by n8n:

1. In the app, configure the Document to split on your Customers table, keyed on the column
   you want one file per — an email address works well, because it lets the next node address
   each file without a lookup (see step 5). Configure the invoice lines Data Set against your
   Invoice Lines table, **scoped by a customer key column** that table must carry — a Customer
   ID or email field that matches one row of Customers — so the split can tell each customer's
   lines apart.
2. Feed the SourceToDocs node from **two** Airtable (or similar) **Get Many** nodes: one of your
   Customers table ("Get customers"), one of your Invoice Lines table ("Get invoice lines").
   Both must have run before SourceToDocs, and n8n's current execution order (`v1`, the
   default for every workflow made in the editor) runs only the nodes connected into the path, so
   chain them: `Get customers → Get invoice lines → SourceToDocs`, with **Execute Once** on `Get
   invoice lines` (it would otherwise read once per customer). The template does exactly this and
   sets `executionOrder` to `v1`.
3. **Rows Come From: This Workflow**, with **two** Data Sets, each referencing its own node by
   name rather than `$input` (the "another node's items" recipe), since SourceToDocs is only
   connected to one of the two reads:
   - the one on your Customers table —
     `{{ $('Get customers').all().map(i => i.json) }}`. This is also the Data Set the split reads
     its driver from (its table matches the split's), so its rows decide how many files come out
     — one per distinct value of the split's key column.
   - the one on your Invoice Lines table —
     `{{ $('Get invoice lines').all().map(i => i.json) }}`. Every row needs the customer key
     column from step 1; a line with none, or with a value that matches no customer, never
     reaches that customer's file.
   - Leave **Unknown Fields** on **Drop**: both Airtable reads carry `id`/`createdTime` on every
     record, and neither table's own columns include them.
   - **Deliver To** does not apply to a split Document: the node's own dropdown shows a notice
     instead of a choice, because a split run delivers through the Document's own
     distributions, not a per-call selection.
4. **Wait For Completion** on. The output is one item per customer's file, each already
   carrying `split_key` (the driver value that file was generated for — the customer's email,
   per step 1) alongside `file_url`.
5. Feed that straight into a Gmail or Send Email node's **To** field: `{{ $json.split_key }}` —
   **not** an expression on the Customers node, such as `{{ $('Get customers').item.json.Email }}`.
   Every output item of a Generate call pairs to *every* input item, not the one that happens to
   produce that file, so with more than one customer `.item` on the Customers node throws
   "Multiple matches found" (with exactly one customer it resolves to that customer). `split_key`
   is the one field guaranteed to name the right customer for each item.

A key that does not belong to a Data Set's own table, a Data Set picked twice, or no inline Data
Set sitting on the split's driver table, are each a distinct `422` with a code — see
[Errors](#errors). If every customer's `Lines`-equivalent rows end up blank, check the customer
key column spelling and values first — a mismatch there is silent, not a `422`.

### Get the PDF bytes

SourceToDocs never puts a file's bytes on the wire — Generate returns a **link**, same as every
read. To get the bytes into your workflow:

1. Turn on the Document's own **Generate PDF** setting (the app, not this node) so a PDF is
   produced alongside the native Google Slides or Google Docs file.
2. Add a **Google Drive** distribution to the Document (or pick it in **Deliver To**). Once a
   run finishes, its item's `deliveries` array holds one entry per destination; a Drive
   delivery's `result` carries `drive_file_id`/`drive_url` for the native file and, when
   **Generate PDF** is on, `pdf_file_id`/`pdf_url` for the PDF right alongside them.
3. Use n8n's own **Google Drive → Download** node with `pdf_file_id` (the same Google
   credential you deliver with) to pull the PDF's bytes into the workflow — attach them, store
   them, whatever needs the actual file rather than a link to it.

Google Drive is the Distribution to deliver through for this: it is the only
[distribution type](https://app.sourcetodocs.com/docs/reference/distribution-types/) with a
delivery behind it today. **Download** exists as a type but is not enabled by default, and a
run delivering through one anyway records a failed delivery rather than a link.

### Wait or poll

**Wait For Completion** (the default) is the simple path: the node polls `GET /runs/{run}`
itself and the next node only ever sees a finished result. It does this by holding the
workflow's execution open for as long as the run takes — for n8n running in **queue mode**,
that is a worker occupied for the whole wait, not just the request.

Turn it off for a document that reliably takes longer than a few polls, or in a workflow where
tying up a worker is the wrong trade: the node then returns as soon as the run is created,
`status: "pending"` and no `file_url` yet. Poll it yourself afterward with **Run → Get** — on a
schedule, from a webhook your own system calls, or from a loop with a Wait node in between —
until `status` is one of `succeeded`, `failed`, `partial_success` or `cancelled`. For a split
Document, the same **Run → Get** on the batch's own id lists every child file once it is done
(or pass **Summary Only** to get the batch's own counters as a single item instead).

A run that times out inside **Wait For Completion** is not an error either: the item comes back
with `timed_out: true` and the run's id, ready for the same **Run → Get** poll. That holds even
when the last status check before Max Wait ran out meets a `429`, a `5xx`, a timeout or a dropped
connection: the item is `timed_out`, with the run as the node last saw it.

**The real bounds.** **Max Wait** defaults to 300 s, is never under **Poll Every** (so there is
always one poll) and never over 3600 s. **Poll Every** defaults to 5 s, is never under 2 s and
never over 3600 s. Both are read as numbers first: empty takes the default, and anything else
that is not a number (text, `NaN`, an object) is refused before the run is created, naming the
parameter, so a bad expression costs no run. Every request also times out after 30 seconds (a
poll after the smaller of that and what is left of Max Wait, with a floor of 5 s), so a server
that stops answering ends the wait within Max Wait plus one poll timeout. A poll that times out
is retried like a `429` or `5xx`.

A transient answer while polling — a `429`, a `5xx`, a timeout or a dropped connection (a reset or
refused socket, a failed DNS lookup) — is retried within **Max Wait** on its own, honouring a
`Retry-After` header when the API sends one (the Public API sends it on a `429`). The wait is never
under 1 second, whatever `Retry-After` says (`0` included), so a poll cannot spin; the start
`POST`'s `Retry-After` wait has the same floor. The document read that Unknown Fields: Drop and Map
Columns make before the run, and the list of a batch's files after it, are retried on a `429`
(and the other transient answers) in the same way, within Max Wait. A `Retry-After` longer than
what is left of Max Wait is handled differently by the two requests. The start `POST` does not
wait at all: the `429` is the error, with no second try. A poll sleeps out what is left of Max
Wait and polls once more; if that poll is transient too, the run is reported as `timed_out`, not
as an error. An error that is not transient (a `404`, say) is an error, and any error raised once
a run exists — a poll that could not be retried, or the run itself ending `failed` — names that
run's id in its own message.

**Run → Get** waits only to read a batch's list of files, and it has its own **Max Wait** (300 s
by default) for that read: the same bounds as Generate's, never under 5 s (the default Poll Every)
and at most `3600`. A single run and a Summary Only batch are read once and do not wait.

A `429` with the code `authentication_rate_limited` is different from the per-token limit: the
API has refused the **API Token** too many times from this address. Waiting does not help while
the token is wrong, so no wait or start request retries it; the message tells you to check the
**API Token**.

Every wait (Poll Every, a `Retry-After`, the start request's retries) ends as soon as the
execution is stopped, from the editor or by n8n's own execution timeout, instead of sleeping out
its interval.

### Retry On Fail

Turn on n8n's **Retry On Fail** setting and a retry **resumes the same run** instead of starting
another:

- **The automatic key.** When **Idempotency Key** is empty, the node sends its own: it is the
  same on every try of one run of the node, and different for each run of the node in an
  execution and for each execution. A key you type is sent as it is.
- **As an AI tool the key comes from the request, on n8n's in-process tool path only.** That
  path (for example the MCP Server Trigger) raises the run index on every Retry On Fail try, so
  there the tool variant ends its key with a hash of the request instead: the document and the
  body without the key. Two identical tool calls in one execution on that path therefore share
  one run, and the second returns the first's result with `idempotent_replay: true`. Where n8n's
  engine runs the tool (the AI Agent node), each call has its own run index, the run index stays
  the same across Retry On Fail tries, and the node uses it: a retry resumes the run, but two
  identical calls start two runs. The regular node keeps the run index too, so a loop that sends
  the same rows twice on purpose still starts two runs.
- **The automatic key adopts only a recent run.** A conflict on the node's own key that names a
  run created more than 6 hours ago is not adopted: it is treated like a failed run, and the
  node starts a new one under the key followed by `:after:` and that run's id. (That happens
  when n8n's database was reset or migrated and a key repeated; 6 hours is more than Retry On
  Fail can span.) A key you type adopts its run whatever its age.
- **Adoption.** A try whose start `POST` met the first try's run gets `422
  run_idempotency_conflict` naming that run. The node does not treat that as an error: it reads
  the run and carries on as if it had just created it — waits for it, or returns it — and the
  output item says `idempotent_replay: true`. A conflict that names no run stays an error.
- **The start `POST` retries by itself**, inside a budget of three tries and **Max Wait**: a
  `429` always (no run was created), honouring `Retry-After`, except a `429` that refuses the API Token
  (`authentication_rate_limited`); a `5xx`, a refused connection or
  a timeout (a run may have been created) only while a key is sent, so the retry meets the
  conflict and adopts the run. A `4xx` other than `429` is never retried.
- **After a failed run.** A run that ended `failed` is not adopted, whether or not it made its
  document (see the edge case below), so a retry that meets one starts **one new run** under the key followed by `:after:` and the
  failed run's id (a failed batch counts as failed only when every file failed, so a batch is
  chained the same way). Every other status — pending, processing, succeeded, partial success,
  cancelling and cancelled — is adopted. A key whose run was cancelled therefore keeps returning
  that run with `status: cancelled`; to start again, change the key.
- **The edge case.** A single run that rendered its document and then failed *every delivery* is
  also `failed`. The retry starts a new run and renders a second file; the first one is left,
  undelivered, in the render account. Check `deliveries` before retrying such a run by hand.
- **"Retry execution" starts a new run.** The button on the executions list creates a new
  execution (n8n's own docs: the new one records `retryOf`), and the automatic key contains the
  execution id, so it is a different key and generates a new document. Only Retry On Fail inside
  one execution resumes.

### Node versions and the Output option

The node has two versions. A workflow that already has the node stays on **version 1**, which
keeps the **Simplify** boolean and the output items exactly as they were. A node you add now is
**version 1.1**, which replaces Simplify with **Output**:

| Output | Generate and Run → Get return |
| --- | --- |
| **Simplified** (default) | the flattened fields: `run_id`, `status`, `file_url`, `file_name`, `file_count`, `deliveries`, `warnings`, `generation_stats`, `folder_url`, … |
| **Raw** | the same, plus the API's complete run object under `run` |
| **Selected Fields** | only the keys you tick under **Fields** (one is required; an unknown name is refused before anything is sent) |

Version 1.1 also adds, to the flattened item: `warnings`, `generation_stats`, `folder_url` (the
batch folder, from the run's destinations), `document_id`, `processing_started_at`,
`finished_at`, and each delivery's `distribution_id`. A batch's children carry the batch's
`folder_url` and `generation_stats` and their own `warnings`. Version 1 does not get these.

These keys are added after the selection, so they survive every Output choice and version:
`timed_out`, `idempotent_replay`, `dropped_keys`, `empty_columns`, `empty_rows` and
`missing_split_keys`.

The three templates pin the node at 1.1 with Output **Simplified**.

### Errors

Every non-2xx answer from the Public API surfaces as a node error whose message is the API's
own `message` and whose details carry its code (for example `inline_column_unknown`,
`run_idempotency_conflict` or `no_enabled_distributions`), its `category`, any field it names,
and a next step: a link to the [Run error codes reference](https://app.sourcetodocs.com/docs/reference/run-error-codes/)
for a code, or what to check for a `401`, `404` or `429`. A parameter the node itself refuses
(a bad ID, Rows that are not JSON, a Max Wait that is not a number) is named in single quotes in
the message, and the details say what to change.

Two refusals have words of their own, because they come from a limit (see [Limits](#limits)). A
request body over 2 MiB (`413`, `request_body_too_large`) reads "The rows are too large to send in
one run" and a Data Set with too many rows (`422`, `source_too_large`) reads "A Data Set has more
rows than one run may hold". Both details say that nothing was started and to send fewer rows per
run: split them over several runs, or use a split document. A `413` from the web server in front
of the application (a plain-text answer over 40 MB) or a `502`/`503`/`504` is named for what it
is, rather than blamed on a wrong Base URL; only an answer this node genuinely cannot parse
points there.

The node's **On Error** setting changes what comes out, and the two item shapes differ:

- **Continue (regular output)** (and the older Continue On Fail switch) puts one **flat** item
  on the success output, carrying every fact there is to carry: `error` (the message),
  `error_code`, `errors` (the envelope's own field names, such as `unknown_keys`, `data_set_id`
  or `table_id`), `category`, and `run_id` whenever a run was actually started before the failure.
- **Continue (using error output)** puts `{ error, details }` on the error output, where `details`
  holds the same facts. n8n merges the paired input item's own fields under it, so a read's item
  also carries what it was reading (a Run → Get error carries the `run` field it was given). For
  Generate, which pairs to every input item, that is input item 0's fields.

The facts live in `details` there, not at the top level, because n8n rewrites any item that
carries its own `error` key and would drop them. A batch whose every file failed is expanded into
**one item per failed file**, each with that file's own `run_id` and `error_code` plus the
batch's own id under `batch_run_id`, in either shape. A read error names the failing item.

A run that ends `failed` raises the API's own `error_message` when it sent one. Only when the API
sent none does the message read "The run ended before the document was produced" (a batch: "The
batch run ended before all of its documents were produced"). The API's own `error_code` stays
verbatim.

The full, generated list of codes and what each one means is the product's own
[Run error codes reference](https://app.sourcetodocs.com/docs/reference/run-error-codes/) — it
is regenerated from the code that enforces them, so it stays current where this README would
not. A `failed` run (as opposed to a request the API itself refused) throws the same way, with the
run's own `error_message` as the message, its code and the same link in the details, and — for a
batch — the first few files that were not produced, with their own codes, alongside the batch's id.

### When something is wrong or gone

- **The Document was deleted** (or its Project is in the trash, or the token belongs to another
  workspace): the Data Set, Deliver To and Columns pickers show the API's `404` message ("Resource
  not found.") instead of an empty list, and Generate throws the same `404`. A revoked token shows
  `401` ("Invalid API token."). An empty picker means there is genuinely nothing to pick.
- **Deliver To holding a deleted or disabled Distribution** is not an error: the API ignores that
  id, answers `201` and delivers to the others. The node passes the ids through and adds no
  warning. Only when none of them is valid does the start answer `422 no_enabled_distributions`.
  Leave Deliver To empty to deliver to every enabled Distribution.
- **A Data Set deleted in the app** and named in the rows is `422 inline_data_set_unknown`
  (`errors.data_set_id` names it); the quota being used up is `422 plan.limit_exceeded.generations`
  (`errors.limit`, `errors.used`). With Continue (regular output) each becomes one item carrying `error`,
  `error_code`, `category` and `errors`, and no `run_id` (no run was created).
- **The Document deleted between the start and the render**: the run ends `failed` with
  `render_failed` and "The document was deleted before this run could render it." (a batch
  deleted before it is prepared: `destination_container_failed`). Deleted once the render has
  begun, the run finishes as usual: it renders and delivers to every destination. Run → Get still returns the run either way.
- **No fields to send**: the body goes out as JSON; "no fields" is `{}`, `[]` or no body. Any other
  body that is not a JSON object, or an object sent as text or a form, is `422` on `body`.
- **A cell of the wrong type** is never refused: it renders as the column can show it, or empty
  (a number column keeps `12` and `"12"`, a boolean column only a real `true`, a date column an
  ISO 8601 string with its offset dropped). Send dates as ISO 8601.

### Use it as an AI tool

The node can be an AI Agent's tool, and every operation and parameter is described for an agent
to read cold. Whatever you hand to the model with n8n's "let the model define this parameter"
button (`$fromAI`) is chosen by the model, and n8n checks only the key name, so:

- **Keep Document a literal.** A model-chosen Document, Rows, Idempotency Key or Run ID can
  point the run at any Document of the workspace (an Idempotency Key, see below, can also
  return another call's run). The node refuses a value that is not a UUID,
  but any real one passes.
- **Do not expose Deliver To** to the model: it decides where files are sent.
- **Put n8n's human review in front of Generate.** From n8n 2.6, a tool's connection to the AI
  Agent can carry an "Add human review step" that holds the call until a person approves it; use
  it for Generate, which creates documents and counts against the plan.
- **Identical calls can share a run.** On n8n's in-process tool path (for example the MCP Server
  Trigger) the tool variant's automatic key comes from the request (see
  [Retry On Fail](#retry-on-fail)): two identical Generate calls in one execution start one run,
  and the second returns it with `idempotent_replay: true`. Under the AI Agent node, which runs
  the tool through n8n's engine, identical calls each start their own run. A fixed
  **Idempotency Key** makes every call adopt the first run on either path; if you set one, it
  must differ per call. A key adopts the run that already holds it whatever its rows and
  whatever its age, so a key the model chooses by itself can return another conversation's run
  (with its file links). Scope it to the call, so the model cannot name a key from another
  execution: `{{ $execution.id }}:{{ $fromAI('key', 'A short label for this document', 'string') }}`.
- Generate **waits for the run** (up to Max Wait, 300 s by default) inside one tool call. Turn
  Wait For Completion off if the agent should not block, and let it poll with Run → Get.

### Limits

- **60 requests a minute per API Token** — Generate's own worst case is one start plus a poll
  every 2 seconds (the minimum **Poll Every** allows), 31 requests a minute, under the limit but
  not by much (32 when the run also reads the Document once, as Map Columns and Unknown Fields: Drop, the default, do); the default 5-second Poll Every is a gentler 12 a minute. A `429` carries a
  `Retry-After`, which the node honours inside Max Wait.
- **Every request times out after 30 seconds.**
- **A request body over 2 MiB is refused with `413` (`request_body_too_large`)**, before the body
  is read and before the token is checked. That is about 15 000 ordinary rows in one run. Over
  40 MB the web server in front of the application answers first, in plain text.
- **A Data Set holds at most the plan's source-row limit** (100,000 rows unless the plan sets
  another). More rows sent in a run are refused at start with `422` `source_too_large`, and no run
  is created.
- For more rows than a run takes, split them over several runs, or use a split Document, which
  makes one file per key from one request. The node's message for either refusal says the same.

## Resources

- [Templates](templates/README.md): three importable workflows (weekly report from CRM deals, one
  invoice per customer, generate a document from an n8n Form submission).
- [SourceToDocs documentation](https://app.sourcetodocs.com/docs/), in particular
  [Automate with n8n](https://app.sourcetodocs.com/docs/guides/n8n/) and the
  [Run error codes reference](https://app.sourcetodocs.com/docs/reference/run-error-codes/).
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/).
- [Issues and source](https://github.com/2vmodules/n8n-nodes-sourcetodocs); building and testing the node is in
  [CONTRIBUTING](CONTRIBUTING.md).

## Version history

- **1.0.0** — the first public release. The package ships node version 1 and node version 1.1:
  a node you add is 1.1, and a workflow that already holds the node on version 1 keeps its
  Simplify switch and its output items (see
  [Node versions and the Output option](#node-versions-and-the-output-option)). The full list of
  what the release contains is in the [CHANGELOG](CHANGELOG.md).

## License

[MIT](LICENSE) — © 2V Modules
