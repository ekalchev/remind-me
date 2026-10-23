# Remind Me for Jira

Reddit-style `RemindMe!` for Jira Cloud. Write a comment on an issue, and Jira emails you about that issue when the time comes.

```
RemindMe! 2 days
RemindMe! in 5 hours "check if Sam replied"
@remindme tomorrow 9am
!remind Friday 14:00 follow up with QA
```

The app replies right away. The reply mentions you and says something like:

> @Emil Kalchev I'll remind you at 9:00 AM EET, Sun, Oct 25, 2026 (in 18 hours). Note: *check if Sam replied*

When the reminder is due, you get an email titled **Reminder: ABC-123 &lt;issue summary&gt;**. It contains your note, a link to the issue and a link to the comment that set the reminder.

It is a Forge app: it runs entirely on Atlassian's infrastructure, with no servers to host and no data leaving Atlassian.

## Using it

| You write | What happens |
| --- | --- |
| `RemindMe! <when> [note]` | Sets a reminder. `!RemindMe`, `@remindme` and `!remind` work too, in any letter case. |
| `RemindMe!` | Sets a reminder for one day from now. |
| `RemindMe! <when> "note"` | Uses the quoted text as the note. Without quotes, the note is whatever follows the time. |
| `RemindMe! list` | Lists your pending reminders on this issue, numbered. |
| `RemindMe! cancel` | Cancels all your pending reminders on this issue. |
| `RemindMe! cancel 2` | Cancels reminder number 2 from the list. |
| `RemindMe! help` | Shows the accepted formats. |

**When** can be either of these:

- **A duration.** Examples: `2 days`, `in 5 hours`, `3h`, `2h30m`, `90 minutes`, `a week`, `1 week and 2 days`, `2 months`, `1 year`.
  - Hours and minutes are exact elapsed time.
  - Days, weeks, months and years keep the same clock time, even across a daylight saving change.
- **A date or time.** Examples: `tomorrow 9am`, `Friday`, `next monday 14:00`, `Oct 30 5pm`, `at 17:30`, `tomorrow 9am UTC`.
  - These are read in **your** time zone, as set in your Atlassian profile.
  - A date without a time means 09:00.
  - A time that has already passed today means tomorrow.
  - A date without a year means the next one.

Rules:

- The time goes **right after the keyword**.
- Times count from when the comment was written.
- A reminder can be at most one year ahead.
- Only the first keyword in a comment counts.
- Text in code blocks, inline code and quotes is ignored, so pasting an example doesn't set a reminder.
- A reminder is always for the person who wrote the comment.

**Editing and deleting comments**

- Editing the comment moves the reminder, and the app rewrites its reply in place rather than posting a new one.
- Editing the keyword out of the comment, or deleting the comment, cancels the reminder.
- `list`, `cancel` and `help` answer only the first version of a comment.
- Each person can have at most 25 pending reminders per issue.

**Who sees the replies.** A reply to a comment restricted to a role or group gets the same restriction. A reply to an internal comment in Jira Service Management is also internal.

## How it works

```
comment created/edited ──► trigger (avi:jira:commented:issue) ──► parse ──► KVS "reminder" entity
comment deleted ─────────► trigger (avi:jira:deleted:comment) ──► cancel
every 5 minutes ─────────► scheduledTrigger ──► due reminders ──► POST /issue/{id}/notify (one user)
```

| File | Role |
| --- | --- |
| `src/adf.ts` | Extracts the comment's plain text from ADF, one line per paragraph, skipping code, quotes and mentions. |
| `src/command.ts` | Finds the keyword and splits the command from its arguments. |
| `src/time.ts` | Turns the arguments into a due instant and a note. |
| `src/format.ts` | Formats dates for the user's locale and time zone, with fallbacks. |
| `src/messages.ts` | The reply comments (ADF) and the reminder email. |
| `src/jira.ts` | The Jira REST calls, all made as the app. |
| `src/store.ts` | Reminder storage and conditional writes. |
| `src/handlers/comment.ts` | Comment created, edited and deleted. |
| `src/handlers/deliver.ts` | The five-minute delivery job. |

**Time zones.** The commenter's zone comes from `GET /rest/api/3/user?accountId=…`.

- If their profile privacy settings hide it, times are in UTC, and the confirmation says so.
- chrono-node, the date parser, only knows fixed UTC offsets. So the app takes the wall-clock fields chrono finds and re-anchors them in the user's IANA zone with Luxon. That's why `tomorrow 9am` stays 09:00 even when daylight saving changes overnight.
- Durations are parsed by the app itself, so `24 hours` and `1 day` mean different things across a daylight saving change, as they should.

### Why Forge KVS custom entities, not Forge SQL

The delivery job needs one query: pending reminders whose `dueAt` is before now, oldest first. The `list` and `cancel` commands need a user's pending reminders on one issue. KVS custom entities do both with two indexes:

- `by-status-due` (partition `status`, range `dueAt`)
- `by-issue-owner` (partition `issueId, accountId, status`, range `dueAt`)

KVS also has what makes delivery safe:

- **Conditional transactions.** Each write expects the version it read, so two writers can't both win.
- **`FAIL_IF_EXISTS` writes.** These make a re-delivered event harmless.

Forge SQL would also work, but it brings more setup for less in return:

- It needs a `sql` module.
- It needs a migrations runner.
- Its documentation still says multi-statement transactions aren't supported.
- Its free allowance is 1 compute-hour a month, and a job querying every five minutes uses that up.

Instants are stored as epoch milliseconds in `float` attributes, because a KVS `integer` is 32-bit.

### Delivery guarantees

Delivery is **at-least-once**:

1. Each run claims a reminder by writing a 10-minute lease (`leaseUntil`). The write only succeeds if the reminder's version hasn't changed since the run read it, so overlapping or duplicate runs (which Forge says can happen) skip what another run holds.
2. The run then emails the user.
3. It marks the reminder `sent`, again conditionally.

If a run dies between steps 2 and 3, the lease expires and a later run sends the reminder again. That's a rare duplicate email rather than a lost reminder.

Failed emails are retried after 5 and then 15 minutes, and marked `failed` after 3 attempts. A reminder whose issue was deleted is cancelled.

Each run stops claiming work after 100 seconds, within its 120-second timeout, and the next run continues.

### Stored fields

| Field | Meaning |
| --- | --- |
| `id` | `c-<commentId>`: a comment sets at most one reminder. |
| `issueId`, `issueKey` | The issue. The id is used for API calls, so moving the issue doesn't break the reminder. |
| `commentId` | The comment that set it. |
| `accountId` | Who gets reminded. |
| `dueAt` | When, in UTC epoch milliseconds. |
| `note` | Optional, up to 500 characters. |
| `createdAt` | When the comment was written. |
| `sentAt` | When the email went out. |
| `status` | `pending`, `sent`, `failed` or `cancelled`. |
| `attempts`, `lastError` | Delivery attempts and the last failure. |
| `leaseUntil`, `version` | The claim lease and retry backoff, and the version each conditional write expects. |
| `zone`, `locale` | Used for formatting the dates in replies and emails. |
| `confirmationCommentId` | The app's reply, which an edit rewrites. |

## Permissions, egress and "Runs on Atlassian"

| Scope | Used for |
| --- | --- |
| `read:jira-work` | Receiving the comment events, and reading comments and issues. |
| `write:jira-work` | Posting and editing replies, and `POST /issue/{id}/notify`. Notify needs no extra scope. |
| `read:jira-user` | Reading the commenter's time zone, locale and display name. |
| `storage:app` | Forge KVS. |

The manifest declares no `permissions.external` and no remotes. The app makes no outbound calls outside Atlassian, uses only Forge-hosted compute and storage, and so stays eligible for **Runs on Atlassian**.

## What it costs to run

Forge has billed by usage since 1 January 2026. Every environment counts, but each app gets a monthly free allowance. As of the [pricing page](https://developer.atlassian.com/platform/forge/forge-platform-pricing/) (updated 12 August 2026), that includes:

- 200,000 GB-seconds of function compute
- 0.1 GB of KVS reads and 0.1 GB of KVS writes
- 1 GB of logs

This app is a small fraction of that. The five-minute job runs about 8,640 times a month, and an empty run takes well under a second. Every comment on the site invokes the comment trigger once, but a comment without a keyword costs one comment read and one KVS read before the trigger returns. Check the developer console's usage page after a week of real use.

## Setup

You need Node.js 22 or 24 and npm. The Forge CLI supports both.

### 1. Create an Atlassian developer account

If you already have an Atlassian account (you use Jira), you can use it. Otherwise sign up at <https://id.atlassian.com/signup>. Then open the developer console at <https://developer.atlassian.com/console/myapps/> once, to accept the developer terms.

### 2. Install the Forge CLI

```bash
npm install -g @forge/cli
forge --version
```

### 3. Log in

Create an API token at <https://id.atlassian.com/manage/api-tokens>, then run:

```bash
forge login
```

Enter your Atlassian email and the token. On a machine without a keychain, set `FORGE_EMAIL` and `FORGE_API_TOKEN` instead.

### 4. Create a free developer site for testing

Go to <http://go.atlassian.com/cloud-dev> and create a developer site, for example `your-name-dev.atlassian.net`. It is a free Jira Cloud site meant for testing apps, so don't use your company site for development.

### 5. Register the app under your account

From this folder:

```bash
npm install
forge register
```

When asked, name the app "Remind Me". `forge register` replaces the placeholder `app.id` in `manifest.yml` with your app's id. Commit that change.

### 6. Deploy to the development environment

```bash
npm test
forge lint
forge deploy
```

`forge deploy` uses the `development` environment by default.

### 7. Install it on your developer site

```bash
forge install --site your-name-dev.atlassian.net --product jira
```

Approve the scopes when prompted.

### 8. Try it

1. Open any issue on the developer site and add the comment `RemindMe! in 10 minutes "it works"`.
2. Within about a minute the app replies with the confirmation. Events can take up to 3 minutes to arrive.
3. 10–15 minutes later, the email arrives at your account's address.
4. Try `RemindMe! list`, then `RemindMe! cancel`.
5. Edit a reminder comment's time, and watch the app's reply update in place.
6. Watch the logs while you test:

```bash
forge logs -e development --since 15m
```

For faster iteration, `forge tunnel` runs your local code against the developer site without redeploying.

Jira sends notify emails through its normal mail queue. If nothing arrives, check spam, and check that your Jira email notifications aren't turned off under Profile > Personal settings.

### 9. Move to the production environment

```bash
forge deploy -e production
```

Development and production are separate deployments of the same app, with separate storage.

### 10. Install on the company site

A Jira site admin installs the app. You can't install it yourself unless you are an admin there.

1. In the [developer console](https://developer.atlassian.com/console/myapps/), open **Remind Me**, go to **Distribution**, and click **Edit** under **Distribution controls**.
2. Turn on **Sharing** and fill in the short form: app description, vendor (your company), privacy policy and terms links (internal pages are fine), and the security and data questions. The answers to those are: no personal data stored outside Atlassian, and no egress.
3. Save, then copy the **installation link**.
4. Send it to a Jira admin of `your-company.atlassian.net`, with the four scopes above and a link to this README. They open the link, choose the site, review the scopes and click **Install**. It installs the **production** environment.

Later updates:

- `forge deploy -e production` updates the installed app automatically, as long as the scopes don't change.
- If you add a scope, an admin must approve the upgrade. The app's page under **Jira admin > Apps > Manage apps** prompts for it. If you're the admin, `forge install --upgrade -e production --site your-company.atlassian.net` does the same.

To offer the app outside your company, list it on the Atlassian Marketplace instead.

## Development

```bash
npm test           # vitest: ADF, command, time zones, DST, formatting, delivery
npm run typecheck  # tsc --noEmit
forge lint         # manifest validation (needs forge login)
```

The time tests run with the process time zone set to `Pacific/Chatham`, so nothing silently relies on the machine's zone.

## Known limits

- **Delivery can be about 5 minutes late.** The job runs every five minutes, Forge spreads runs across that window, and comment events can take up to 3 minutes to arrive.
- **Every confirmation is a comment.** Watchers of the issue are notified of it like any other comment. Reddit's bot has the same trade-off.
- **Email only.** If someone turned off Jira email notifications, or their address bounces, the app can't tell. One community report says notify emails also reach deactivated users.
- **Restricted comments.** A community report suggests Forge may not deliver events for comments with restricted visibility. If so, reminders in restricted comments are ignored.
- **The display language is English.** Dates follow your locale, but the replies are in English.
- **Assumptions to confirm on the first deploy.** The docs didn't settle these, so check them in `forge logs` the first time:
  - The `avi:jira:commented:issue` payload has `issue.id`, `issue.key` and `comment.id`. The app re-reads the comment through the v3 API, so the body format in the event doesn't matter.
  - Comments the app posts show the app as their author.
