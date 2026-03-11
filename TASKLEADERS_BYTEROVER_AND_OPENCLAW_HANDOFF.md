# TaskLeaders — ByteRover Notes and OpenClaw Handoff

## Purpose

This document captures the important ByteRover lessons learned during TaskLeaders setup and gives a concise handoff summary for OpenClaw so future work stays aligned.

---

## Part 1 — Important ByteRover Points to Know

### 1. Primary ByteRover memory for this project is currently at the workspace level

The important ByteRover memory files for TaskLeaders were found at:

`/Users/toddbrunel/.openclaw/workspace/.brv/context-tree/`

Not mainly at:

`/Users/toddbrunel/.openclaw/workspace/task-leaders-deploy/.brv/context-tree/`

This matters because running ByteRover from the project subfolder may not show the real memory tree if the main memory lives at the workspace root.

### 2. Correct working directory for ByteRover sync

When checking or syncing the main ByteRover memory for TaskLeaders, use:

`cd /Users/toddbrunel/.openclaw/workspace`

Then run ByteRover commands from there.

### 3. Verified connected ByteRover state

The TaskLeaders ByteRover memory was successfully pushed to the Pro account space:

- Account: `todd@smartforhumans.com`
- Space: `tender-hugle/gifted-ritchie`
- Push result: `Added: 23`
- Final status after push: `Context Tree: No changes`

This confirms that the earlier local memory was successfully synced into the paid account.

### 4. Useful ByteRover commands

From the workspace root:

#### Check status
`brv status`

#### Push local memory to remote space
`brv push`

#### Open ByteRover interactive mode
`brv`

Useful interactive commands:
- `/space list`
- `/space switch`
- `/push`
- `/pull`
- `/exit`

### 5. Best practical ByteRover rule going forward

Treat ByteRover as an important support layer, but not the only source of truth.

The safest recall hierarchy for TaskLeaders is:

1. GitHub-pushed files and live pages
2. TaskLeaders markdown/source-of-truth documents in the workspace
3. Workspace-level ByteRover memory
4. Chat history

### 6. What should be stored in ByteRover

Store:
- stable project decisions
- source-of-truth hierarchy
- naming conventions
- MVP scope rules
- category rules
- flow rules
- important implementation constraints
- important current priorities

Do not store:
- long brainstorming transcripts
- random chat noise
- speculative ideas not yet adopted
- duplicate history that already exists cleanly in project docs

### 7. Workspace vs project-level caution

TaskLeaders currently has meaningful ByteRover memory at the workspace level. Do not assume the project-level `.brv` folder contains the full memory unless intentionally set up that way later.

### 8. Best operating habit

When important TaskLeaders decisions are made:
- update the project docs first
- then update ByteRover memory as a distilled decision layer
- then push ByteRover from the workspace root if needed

---

## Part 2 — TaskLeaders Current Important State for OpenClaw

### Current source-of-truth hierarchy

Use this order:

1. `TASKLEADERS_MVP_WORKING_BRIEF.md`
2. `TASKLEADERS_SITE_FUNCTIONALITY_RULES.md`
3. `TASKLEADERS_PROJECT_STATE_SUMMARY.md`
4. `PRODUCT_SPEC.md` as original baseline only

### Brand naming rules

- Correct brand spelling: `TaskLeaders`
- Individual provider role: `TaskLeader`
- Never treat legacy variants like `Task Leaders` or `Taskleaders.com` as the working standard

### Current approved page names

- Homepage
- Category Page
- TaskLeader Public Profile
- Become a TaskLeader
- TaskLeader Profile Setup
- TaskLeader Sign In

### Current approved homepage category set

For the Real Estate / Property Manager target market, the approved category set is:

- Handyman
- Plumbing
- Electrical
- Painting
- Cleaning
- Furniture Assembly
- Moving Help
- Yard Work

### Category visibility rule

A category should only appear publicly on the Homepage when at least one approved and activated TaskLeader exists in that category.

### Current customer flow

Homepage → Category Page → TaskLeader Public Profile → Connect → WhatsApp

### Current prospective TaskLeader flow

Homepage or outreach → Become a TaskLeader → application / interest submitted → founder WhatsApp video call → approval → TaskLeader Profile Setup → profile goes live

### Current returning TaskLeader flow

TaskLeader Sign In → email magic link → TaskLeader Profile Setup (edit mode)

### Important page-role rules

- `Become a TaskLeader` is the public provider recruitment/application page
- `TaskLeader Profile Setup` is post-approval only
- `TaskLeader Profile Setup` is not a normal public-nav page
- returning approved TaskLeaders use `TaskLeader Sign In`
- public-facing pages must not imply unsupported functionality

### Public profile rules already established

- TaskLeader Public Profile is populated from approved setup data
- top location uses approved city only
- service areas are shown separately
- current search category may influence hero/category context
- trust signals include response, reliability, and price

### Homepage rules already established

- Homepage links to categories
- Homepage links to Become a TaskLeader
- Homepage includes TaskLeader Sign In for returning TaskLeaders
- hero language emphasizes speed and reliability
- homepage category visibility depends on supply existing

### Important implementation mindset

- store decisions, not noise
- protect current naming consistency
- do not reintroduce deprecated/legacy assumptions
- do not let public pages promise unsupported backend features
- keep flows simple and MVP-appropriate

---

## Part 3 — OpenClaw Prompt to Re-anchor the Project

Use this prompt in OpenClaw when you want it fully aligned with the important current state:

```text
Please re-anchor yourself on the current TaskLeaders project state before doing further work.

Use these documents as the current authority, in this order:
1. TASKLEADERS_MVP_WORKING_BRIEF.md
2. TASKLEADERS_SITE_FUNCTIONALITY_RULES.md
3. TASKLEADERS_PROJECT_STATE_SUMMARY.md
4. PRODUCT_SPEC.md as original baseline only

Important project rules:
- Correct brand spelling is TaskLeaders
- Individual provider role is TaskLeader
- Approved public page names are: Homepage, Category Page, TaskLeader Public Profile, Become a TaskLeader, TaskLeader Profile Setup, TaskLeader Sign In
- Approved homepage category set for the Real Estate / Property Manager target market is:
 Handyman, Plumbing, Electrical, Painting, Cleaning, Furniture Assembly, Moving Help, Yard Work
- A category should only appear on the Homepage when at least one approved and activated TaskLeader exists in that category
- Customer flow is: Homepage → Category Page → TaskLeader Public Profile → Connect → WhatsApp
- Prospective TaskLeader flow is: Homepage or outreach → Become a TaskLeader → founder WhatsApp video call → approval → TaskLeader Profile Setup → profile goes live
- Returning TaskLeader flow is: TaskLeader Sign In → email magic link → TaskLeader Profile Setup (edit mode)
- Become a TaskLeader is the public recruitment/application page
- TaskLeader Profile Setup is post-approval only and not a normal public-nav page
- Public-facing pages must not imply unsupported functionality

Before starting new work, briefly confirm that you are aligned with these rules and identify any files/pages that would be affected by the next task.
```

---

## Part 4 — Short Operating Reminder

When in doubt:
- update the TaskLeaders project documents first
- keep OpenClaw aligned with the source-of-truth hierarchy
- use ByteRover from the workspace root when syncing memory
- trust files and GitHub more than chat recollection

---

*End of document.*