# Templates

Three workflows for the [n8n templates catalogue](https://n8n.io/workflows/), each importable
as is. After import: add a **SourceToDocs API** credential to the SourceToDocs node, then pick
your own Project, Document and Data Set from its dropdowns (and your own credentials on the
other service nodes) — nothing else needs changing.

Each JSON file below is one submission. The **Title**, **Description** and **Category** text is
what to paste into the catalogue submission form for that workflow.

All three set the workflow's execution order to `v1` (n8n's default for a workflow made in the
editor), pin the SourceToDocs node at version 1.1 with **Output** on **Simplified**, and carry a
"Setup" sticky note that lists what to pick after import.

All three leave **Unknown Fields** on its default, **Drop**: Airtable's own `id`/`createdTime` and
the Form Trigger's own `submittedAt`/`formMode` land on every item those nodes produce, on top of
whatever columns you picked, and the node removes anything that is not one of the Data Set's own
columns before sending — reporting what it removed as `dropped_keys` on the output, so a genuine
typo in a column you meant to send is still visible rather than silently discarded. That is what
lets the first two templates below use a source's items as is, with no field-by-field mapping
step. The third uses **Map Columns** in Map Automatically instead of JSON, so Unknown Fields cleans its
rows the same way; the other two stay JSON.

---

## `weekly-report-from-crm-deals.json`

**Title:** Weekly report from CRM deals with SourceToDocs

**Category:** Sales

**Description:**

> Every Monday morning, pull your open deals from Airtable (swap in HubSpot if that's your CRM)
> and generate a Google Slides or Google Docs report from them with
> [SourceToDocs](https://sourcetodocs.com) — no Rows mapping to write, just
> `{{ $input.all().map(i => i.json) }}` — then post the finished file's link to Slack.
>
> **Before you run it:** add your Airtable, SourceToDocs and Slack credentials, pick your Base
> and Table on the Airtable node, and pick your Project, Document and Data Set on the
> SourceToDocs node (its description lists the Data Set's column names — your Airtable
> columns need to match them exactly; Airtable's own `id` and `createdTime` fields are dropped
> automatically). Pick your Slack channel. That's it.
>
> If the report did not finish (the wait timed out, or the run was cancelled), the Slack message
> says so and names the status instead of showing an empty link. A report that finished with
> warnings (`partial_success`) still has its file, so its link is posted. A run that fails stops
> the workflow with the failure.

**What it builds:** Schedule Trigger (weekly) → Airtable (Search) → SourceToDocs (Generate, Rows
Come From: This Workflow — JSON) → Slack (Post a message).

---

## `one-invoice-per-customer.json`

**Title:** One invoice per customer with SourceToDocs' split documents

**Category:** Sales

**Description:**

> Generate one invoice per customer in a single run, through a SourceToDocs Document configured
> to split: one file per customer, built from that customer's own line items, each emailed
> straight to them.
>
> This one needs a little more of your own setup than the others, because split documents are
> SourceToDocs' most powerful feature and the one with the most moving parts. Airtable returns a
> linked or lookup field as ids or plain scalars, never as row objects, so a customer's line
> items cannot live inside the customer's own row — they have to come from a **second** read of
> their own table, joined only by a column your data carries:
>
> 1. Your Document must be [configured to split](https://app.sourcetodocs.com/docs/guides/split/)
>    on your Customers table, keyed on the customer's **Email** column — that is what lets
>    `{{ $json.split_key }}` go straight into the Gmail node's **To** field with no extra lookup
>    step. Configure the invoice-lines Data Set against your Invoice Lines table, **scoped by a
>    customer key column that table must carry** (a Customer ID or Email field matching one
>    Customers row) — without it the split cannot tell whose lines are whose.
> 2. Two Airtable **Get Many** nodes feed the one SourceToDocs node: "Get customers" (your
>    Customers table) and "Get invoice lines" (your Invoice Lines table, including that key
>    column). They run one after the other — `Get customers → Get invoice lines → SourceToDocs`
>    — so both have executed by the time SourceToDocs reads them, and "Get invoice lines" has
>    **Execute Once** on so it reads the table once, not once per customer.
> 3. The SourceToDocs node needs **two** Data Sets, each referencing its own read by name rather
>    than the connected input: `{{ $('Get customers').all().map(i => i.json) }}` for the
>    Customers Data Set (also where the split reads its driver from), and
>    `{{ $('Get invoice lines').all().map(i => i.json) }}` for the invoice lines Data Set.
>
> A misspelled column name or the wrong Data Set id comes back as a clear `422` with a code —
> see the node's README for what each one means. A missing or mismatched customer key column is
> quieter: that customer's invoice just has no lines, with no error at all — check it first if a
> file comes out empty.

**What it builds:** Manual Trigger → Airtable (Search customers) → Airtable (Search invoice
lines) → SourceToDocs (Generate on a split Document, two Data Sets) → If "Has an invoice?" →
true: Gmail (Send, one email per succeeded file); false: No Operation "No invoice, not emailed".

The If passes only items whose `status` is `succeeded` and that have a `file_url`. Failed and
cancelled files, files that finished with warnings (`partial_success`), a batch that timed out
(`timed_out: true`) and a batch that produced nothing all go to the "No invoice, not emailed"
node, whose output lists them (a file's `split_key` is the customer's email), and the execution
still succeeds: no customer is emailed a missing invoice. The exception is a batch in which
every file failed: the batch itself is `failed`, so the SourceToDocs node stops the workflow
with the failure and neither branch runs.

---

## `generate-on-form-submission.json`

**Title:** Generate a document from an n8n Form submission

**Category:** Productivity

**Description:**

> The simplest way to see SourceToDocs work: a public n8n Form collects a couple of fields,
> generates a document from them, waits for the run to finish (the node polls it), and shows the
> person who submitted it a link to the result.
>
> **Before you run it:** add your SourceToDocs credential, then pick your Project, Document and
> Data Set. The SourceToDocs node uses **Map Columns** in **Map Automatically**: every form field
> is sent as it is, so name the form's fields (**Client name**, **Amount** to start with) exactly
> like the Data Set's columns — rename the fields or the columns until they match. The Form
> Trigger's own `submittedAt` and `formMode` fields are dropped automatically. To fill columns
> yourself instead, switch the mapper to **Map Each Column Manually** and drag a value into each.
> The flow ends with an n8n Form page that shows the link to the finished document, or a plain
> message when it is not ready (the wait timed out, or the run was cancelled). A run that finished with warnings (`partial_success`) has its file, so the link is shown; a run that fails stops the workflow with the failure.
>
> The form is public: anyone with its address can submit it, every submission spends a run of
> your plan, and the link shown opens the generated document. Turn on Basic Auth on the Form
> Trigger for internal use. The template ships without webhook ids, so n8n gives your form its
> own address on import.

**What it builds:** Form Trigger → SourceToDocs (Generate, Rows Come From: This Workflow — Map
Columns in Map Automatically, Wait For Completion on) → n8n Form (Form Ending page showing
`file_url`, or a message when there is none).
