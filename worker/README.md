# Atlas Local Browser Worker

Polls the `atlas-browser` edge function and runs commands locally with Playwright/Chromium.
Nothing executes on Lovable's servers — your machine is the browser.

## Install

```bash
cd worker
npm install
npx playwright install chromium
cp .env.example .env
# edit .env: paste your worker token + your auth user id
npm start
```

## What Atlas can do

| Risk | Commands | Behavior |
| --- | --- | --- |
| safe | navigate, search, extract, screenshot, read, scrape, download | runs automatically |
| caution | click, type, fill, upload, login | requires approval row in `atlas_approvals` first |
| restricted | (anything not in the lists above) | blocked unless explicitly approved |

Atlas queues commands by calling its `browser_action` tool. The worker claims
queued safe commands, plus caution/restricted commands whose linked approval
has been set to `approved` in `atlas_approvals`.

Every completed command writes a row to `atlas_receipts`.

## Approving a caution/restricted command

Update the relevant `atlas_approvals` row to `status='approved'` (Atlas can do
this via its `write_record` tool when you tell it to, or you can do it from
the Backend tab). The worker will pick it up on the next poll.
