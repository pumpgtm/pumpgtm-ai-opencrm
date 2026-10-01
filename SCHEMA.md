# Schema

Five record types. Each record is one Markdown file. The frontmatter holds flat `key: value` fields
and the body holds free text (notes, a call summary, task context).

```
crm/
  schema.json                           allowed values in force (edit to fit your pipeline)
  accounts/<name>.md                    a company you sell to
  people/<email>.md                     a person at that company
  activities/<date>-<title>[-<id>].md   something that already happened
  tasks/<account>--<title>.md           something that has not happened yet
  agreements/<account>--<title>.md      a signed document or an issued invoice
```

`crm.js` writes these files. You can also edit them by hand. `crm validate` tells you if an edit
broke the schema.

## accounts

| field | values |
|---|---|
| name | text, required, the upsert key |
| stage | Discovery, Scoping, Pilot, Customer, Lost |
| source | Outbound, Inbound, Referral |
| domain | text, used to match attendee emails to the account |

Body: what they want, the blocker, the context. A blank stage means you're talking to them but it's
not a deal yet. `pipeline` only lists accounts that have a stage.

**Derived, never stored:** `last_contact` is the latest activity date. `next_followup` is the earliest
due date among Open or Waiting tasks. Both are computed on every read, so they can't go stale.

## people

| field | values |
|---|---|
| name | text, required |
| email | text, the upsert key (lowercased). No email: pass `-` and the name becomes the key |
| account | name of an existing account |
| status | Engaged, Active, Inactive, Disqualified |
| channel | LinkedIn, Email (preferred channel. Blank means email) |
| linkedin | LinkedIn username |

## activities

| field | values |
|---|---|
| name | text, required |
| date | YYYY-MM-DD (default today) |
| type | Meeting, Email, LinkedIn, Other (default Other) |
| account | name of an existing account (optional, assign later if unknown) |
| attendees | list of emails, `[a@x.com, b@y.com]` |
| source | where it came from: `fathom`, `granola`, `gmail`, `gcal`, `linkedin`, anything |
| source_id | that source's id for it (recording id, message id, event id) |
| url | link to the recording, thread, or event |

Body: the summary. `source` + `source_id` is the dedup key, so a sync that runs every hour never
double-writes. With no id, date + title is the key.

## tasks

| field | values |
|---|---|
| name | text, required |
| due | YYYY-MM-DD |
| status | Open (ours to do), Waiting (on them), Done, Skipped (default Open) |
| type | Follow-up, LinkedIn, Email, Call, Internal (default Follow-up) |
| account | name of an existing account |
| person | email of the person it's about |
| activity | file of the activity that created it |

Body: context. Find a task by account plus a piece of its title, not by id.

## agreements

The signature tool and the billing tool stay the system of record. This row is the copy you can
search, so a renewal date or an unpaid invoice is one command away.

| field | values |
|---|---|
| name | text, required |
| account | name of an existing account |
| type | Order Form, Invoice, SOW, NDA |
| status | Sent, Signed, Active, Paid, Unpaid, Cancelled |
| fee | number in USD. Leave it blank if you don't know it, never guess |
| effective | YYYY-MM-DD |
| next | YYYY-MM-DD, next charge, renewal, or due date |
| signer | text |
| ref | the outside id, with the tool: `Stripe in_123`, `Bill.com INV-4`, `DocuSign <envelope>` |

## Why these fields and not more

We ran our own sales pipeline on a bigger version of this model for five months: 479 accounts, 579
people, 1,684 activities, 802 tasks, 16 agreements. Then we counted which fields were actually
filled in. We kept the ones used on most records and cut the rest.

| cut | why |
|---|---|
| account type (Prospect, Customer, Partner) | 459 of 462 were Prospect. Stage already says Customer |
| priority | set on 17% of accounts, mostly Medium |
| expected close date | never set |
| last contact, next follow-up, counts | typed in by hand, they went stale. Now computed |
| 8 deal stages | 4 pilot sub-stages held 7 accounts between them. Merged into Pilot |
| person role | set on 8 of 579 people |
| first seen, last seen, call count | the activities already hold them |
| one id field per provider (Recording ID, Calendar event ID, Gmail message ID) | replaced by `source` + `source_id`, so a new tool needs no new field |
| activity types Discovery, Scoping, Demo, Implementation | 67 records. The account stage already says what the meeting was for. 1,105 "Other" activities were LinkedIn messages, so LinkedIn got its own type |
| agreement document, term, billing | 0, 4 and 14 of 16. The billing tool now goes in `ref` |

## Changing the schema

`crm init` writes these values to `crm/schema.json`. Edit that file to rename stages or add values.
A fundraise pipeline, for example, can use
`stage: Needs Intro, Inbound, Meeting Scheduled, Meeting Completed, Invested, Dead`. Field types are
`text`, `date`, `number`, `list`, `account` (must exist), or an array of allowed values. Fields that
aren't in the schema are rejected.
