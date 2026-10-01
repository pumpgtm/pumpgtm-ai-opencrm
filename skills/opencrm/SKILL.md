---
name: opencrm
description: Operate PumpGTM OpenCRM, a Markdown CRM of accounts, people, activities, tasks, and agreements. Use after every call, reply, signed document, or invoice, and whenever someone asks what is due, how a deal stands, or who to follow up with.
---

# Operating OpenCRM

Run everything through `node crm.js` (the examples use `alias crm="node /path/to/crm.js"`) or
`require("./crm")`. Don't write one-off scripts against the files. If a capability is missing, add it
to `crm.js` so the next run can use it. Add `--json` when you need to parse the output. The fields and
allowed values are in `SCHEMA.md`, and `crm/schema.json` is the copy in force.

## Rules

1. **Facts and judgement are separate.** Syncs log activities and people, which are facts. Only a
   human decision (or an explicit instruction) changes an account's `stage` or notes. Never move a
   stage because an activity was logged.
2. **Every pending next step is a task.** If a call or a reply ends with something still to do,
   create a task with a due date, every time. Use `Open` when it's ours to do and `Waiting` when it's
   on them. Never type a follow-up date into notes.
3. **Never hand-type derived fields.** `last_contact` and `next_followup` are computed from activities
   and tasks. To change them, log the activity or create, snooze, or close the task.
4. **Everything is idempotent.** Pass `source` and `source_id` on every activity that comes from a
   tool. People dedupe on email and accounts on name. Re-running a sync must add nothing.
5. **Record agreements and invoices when they happen.** Do it the moment a document is signed or an
   invoice goes out. Unknown amounts stay blank.
6. **The CRM never sends anything.** Drafting a message is fine. Sending an email, DM, or invite needs
   a human's explicit OK, outside this tool.
7. **Don't delete records.** A dead deal goes to `stage=Lost`. A dropped task goes to `skip`.
8. **Run `crm validate` after writes.** It must print `ok`, or list only live deals still waiting on a
   task from you.

## After a call

```bash
node integrations/fathom.js --since=2026-10-01          # or log it by hand:
crm activity "Discovery call with Jane" account=Acme type=Meeting attendees=jane@acme.com \
  source=fathom source_id=123456789 url=https://fathom.video/share/... \
  note="Wants per-client isolation. Blocker: security review."
```

Then read the call and decide, which is the part a sync never does:

```bash
crm task create "Send security doc" account=Acme due=2026-10-02 type=Email person=jane@acme.com
crm account Acme stage=Scoping note="Scoping after discovery. Security review is the gate."
```

If the call ended with "they'll get back to us", the task is `status=Waiting`.

## After a reply

```bash
crm activity "Re: security doc" account=Acme type=Email source=gmail source_id=18c2f... attendees=jane@acme.com
crm task done account=Acme title="security doc"
crm task create "Book pilot kickoff" account=Acme due=2026-10-07 type=LinkedIn person=jane@acme.com
```

## New person or company

```bash
crm account Acme source=Inbound domain=acme.com
crm person jane@acme.com name="Jane Doe" account=Acme status=Engaged channel=LinkedIn linkedin=janedoe
```

## Daily

```bash
crm due        # every open and waiting task, soonest first. Start here
crm pipeline   # live deals, most neglected first. "no task" means rule 2 was missed
crm validate
```

## Signed paper and invoices

```bash
crm agreement create "Pilot Order Form" account=Acme type="Order Form" status=Signed \
  effective=2026-10-01 next=2026-11-01 fee=1000 signer="Jane Doe" ref="DocuSign 4f2a..."
crm agreement create "Invoice 0001" account=Acme type=Invoice status=Unpaid fee=1000 next=2026-10-31 ref="Stripe in_..."
crm agreement set account=Acme title="invoice 0001" status=Paid
```

## Looking things up

```bash
crm show Acme                            # account, people, activities, tasks, agreements
crm list people account=Acme
crm list accounts stage=Discovery
crm list activities source=fathom
crm list agreements status=Unpaid
```
