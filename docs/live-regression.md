# Live regression runbook

Use this runbook after changing Knot's routing, identity, session, projection, media, or runtime adapters. Run it in a disposable Anytype space with dedicated agent identities. Never use production tasks or secrets as fixtures.

## Test record

Record the date, Knot commit, Anytype API version, runtime versions, space and chat names, operators, and a pass/fail note for every case. Keep participant IDs, invite links, API keys, and gateway tokens out of the record.

## Setup

1. Create a disposable space and a chat named `Gateway Regression`.
2. Invite the existing Codex and OpenClaw identities. Verify the names, avatars, and identity suffixes before approving each as editor; do not create replacement identities.
3. Add the space to both agent configurations with chat discovery, automatic enrollment, `mention-or-reply`, and an operator-only sender allowlist. Enable discussions only for this space.
4. Add the space to `tools.anytype.allowedSpaceIds` when the agent will exercise Anytype writes.
5. Run `knot validate` and `knot doctor`, restart both services, and verify one discovered chat and a connected route in each service log.
6. Capture the pre-test route/session rows from the state store. Do not copy credentials into logs or screenshots.

## Core chat matrix

| ID      | Action                                                                                      | Expected evidence                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHAT-01 | Send one message with native mentions for both agents and ask each to identify its harness. | Both add 👀 to the operator message, create separate status replies, remove 👀 on completion, and answer as the correct Anytype member. Codex identifies Codex; OpenClaw identifies OpenClaw. |
| CHAT-02 | Mention one agent without mentioning the other.                                             | Only the mentioned identity wakes. The other service logs a wake-policy rejection or does not receive an eligible event.                                                                      |
| CHAT-03 | Reply to an agent response without a new mention.                                           | The same agent wakes in the same Anytype chat and resumes the same native harness session.                                                                                                    |
| CHAT-04 | While a run is active, send a qualifying follow-up.                                         | The follow-up steers the active run. Knot freezes the earlier progress reply, creates a new reply after the follow-up, and does not start a duplicate tool run.                               |
| CHAT-05 | Ask for a response with two distinct assistant text parts.                                  | The first part replaces the status reply; each later part gets one new streamed Anytype message. No raw protocol tokens appear.                                                               |
| CHAT-06 | Ask the runtime to stay silent using its documented Knot control token.                     | The working placeholder follows `responses.silentPlaceholder`; the control token itself never appears in Anytype.                                                                             |
| CHAT-07 | Ask for bold text, a list, and inline code.                                                 | Output uses Anytype-safe formatting; unsupported Markdown markers are not shown literally.                                                                                                    |
| CHAT-08 | Ask one agent to mention a configured peer or user.                                         | Knot emits a native Anytype mention mark, not plain `@name` text. Fan-out remains within policy.                                                                                              |

## Sessions, projects, and models

| ID         | Action                                                                     | Expected evidence                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SESSION-01 | Send `/new`, then a normal message.                                        | Knot acknowledges the reset. The next message creates a new native session bound to the same Anytype chat; the prior binding remains auditable.          |
| SESSION-02 | Send `/new` during an active run.                                          | The active run is replaced cleanly; it is not treated as steering and no silent-control token is leaked.                                                 |
| PROJECT-01 | On Codex, run `/projects`.                                                 | Knot lists only configured/available saved projects without exposing local secrets.                                                                      |
| PROJECT-02 | Select a valid project, run `/new`, then ask for the working directory.    | The new Codex task is created under the selected saved project and uses its configured workspace.                                                        |
| PROJECT-03 | Select a nonexistent project and run `/new`.                               | Knot refuses with a clear “project not found” result and creates no native session.                                                                      |
| PROJECT-04 | Clear the project selection and run `/new`.                                | Knot falls back to the agent's default workspace.                                                                                                        |
| MODEL-01   | Run `/models`, select an allowed model/reasoning pair, then send a prompt. | The choice is persisted for this route and the harness starts with that choice. Invalid or disallowed choices fail without changing the saved selection. |

## Progress and resilience

| ID            | Action                                                                           | Expected evidence                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PROGRESS-01   | Ask for a task that produces thinking and at least two tool calls.               | One compact status message is edited with human-readable milestones. Tool input, credentials, and raw thinking are absent. The final answer replaces progress cleanly. |
| PROGRESS-02   | Run a task longer than the old 900-second limit in a controlled harness fixture. | Knot remains active when both watchdogs are disabled. Any native runtime/provider timeout is reported precisely.                                                       |
| RESILIENCE-01 | Restart Knot between receiving and completing a queued delivery.                 | Durable work resumes once, without duplicate agent messages or repeated tool side effects.                                                                             |
| RESILIENCE-02 | Briefly interrupt the Anytype API or stream.                                     | REST catch-up processes missed messages once after reconnection.                                                                                                       |

## Discussions, objects, and media

| ID         | Action                                                                                                | Expected evidence                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DISCUSS-01 | Mention an agent in a top-level object comment.                                                       | 👀 is placed on the human comment and the answer is posted in that same discussion with object and nearby-comment context.                                                   |
| DISCUSS-02 | Reply inside the discussion thread.                                                                   | The reply wakes the same route and the response remains in the same discussion.                                                                                              |
| OBJECT-01  | Ask the agent to create a disposable page, update it, search it, and send it as an object attachment. | All operations stay inside an allowed space; the final chat message contains the native object card, not only a URL. Archive the fixture afterward only if policy allows it. |
| MEDIA-01   | Attach an image and ask for a factual description.                                                    | The runtime receives a readable local artifact and describes the image.                                                                                                      |
| MEDIA-02   | Attach a small video/audio/document fixture.                                                          | Knot downloads the media once, supplies a supported artifact or explicit limitation, and never claims the attachment is missing when it was delivered.                       |
| MEDIA-03   | Reference an object containing embedded media.                                                        | Bounded object context includes the referenced media artifacts needed by the runtime.                                                                                        |

## Access, direct messages, and coordination

| ID        | Action                                                                                                                     | Expected evidence                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| ACCESS-01 | Message each enabled direct-message channel as an allowed operator.                                                        | The correct identity replies and creates one DM route/session.                                                                |
| ACCESS-02 | Send an otherwise valid mention as a participant not on the allowlist.                                                     | No status message or runtime run is created; logs record an authorization rejection without exposing the participant ID.      |
| ACCESS-03 | Ask an authorized admin to change this chat between mention-only and every-message wake, then send an unmentioned message. | Configuration changes are persisted only for the requested route and behavior changes on the next message.                    |
| ACCESS-04 | Ask the agent to read a named chat/object in another allowed space.                                                        | The agent can search/read spaces its Anytype identity belongs to and its tool policy allows; it cannot cross either boundary. |
| COORD-01  | Directly mention the other agent from agent output.                                                                        | The peer wakes only under the configured agent policy; hop and circuit-breaker limits prevent loops.                          |

## Cleanup

1. Confirm no run, scheduled job, or outbound delivery remains active.
2. Archive disposable objects if the test policy permits it.
3. Remove the regression space from both configurations, validate, and restart services if the space is not intended to remain a standing test fixture.
4. Revoke the invite link. Do not remove or recreate the dedicated agent identities.
5. Save sanitized logs and the completed matrix with the tested commit.

## Minimum release gate

A release is not live-verified until CHAT-01 through CHAT-04, SESSION-01, PROJECT-02 and PROJECT-03 for Codex, PROGRESS-01, DISCUSS-01 and DISCUSS-02, OBJECT-01, MEDIA-01, ACCESS-01 and ACCESS-02, plus both service restart checks pass. Cases that require a deliberately unsupported harness capability must be marked as an explicit limitation, not silently skipped.
