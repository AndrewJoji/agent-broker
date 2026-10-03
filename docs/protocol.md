# The Agent Queue protocol (minimal version)

The broker only tells agents that work is waiting. How they pick it up,
avoid doing the same task twice and report back is this protocol. It lives
in your Notion database and in each agent's instructions, not in code.

This is the smallest version that works. You should be able to set it up in
about ten minutes.

> **Note:** I have extended this a lot for my own setup (ownership rules for
> splitting work between agents, heartbeat rows so I can see each agent is
> alive, standing rules that each agent acknowledges, a turn-taking thread
> for when two agents disagree). None of that is needed to start. Begin with
> this version, see where it breaks for you, and experiment from there.

## 1. Create the database

A Notion database with these properties:

| Property | Type | Options / notes |
|---|---|---|
| `Task` | Title | One line: what needs doing |
| `Status` | **Select** | `Queued`, `Running`, `Done`, `Failed`, `Needs approval` |
| `Owner` | Select | One option per agent, matching its inbox name (e.g. `claude`, `muse`), plus one for you |
| `Priority` | Select | `High`, `Normal`, `Low` |
| `Instructions` | Text | Everything the agent needs to do the task without asking |
| `Result` | Text | Written by the agent: claim line, then the outcome |

Use a **Select** for `Status`, not Notion's built-in *Status* property type:
the broker filters on a select.

Give each agent that needs to update rows its own Notion integration (or
whatever access mechanism it supports), shared only with this database.

## 2. The rules

Put these in every agent's instructions.

1. **Only work rows you own.** Pick up a row only if `Owner` is you and
   `Status` is `Queued`.
2. **Claim before you start.** Set `Status = Running` and make the first
   line of `Result` `Claimed by <agent> <date>`. Never start a row someone
   else has claimed.
3. **Finish with a status.** When done, write the outcome in `Result` and set
   `Status` to `Done` or `Failed` (with the reason).
4. **Ask before anything irreversible.** Sending messages, spending money,
   booking, deleting, merging: set `Status = Needs approval`, explain what
   you want to do in `Result`, and stop. A human sets it back to `Queued`
   once approved.
5. **Hand off with a new row.** If part of the task belongs to another agent,
   create a new row owned by that agent with everything it needs in
   `Instructions`. Hand over a short context packet, not a transcript.
6. **Ack your inbox after acting.** Once you have handled what a broker
   message pointed you to, ack that message so it is not delivered again.

## 3. Try it

1. Add a row: `Task = Say hello`, `Owner = <your agent>`, `Status = Queued`,
   `Instructions = Write "hello" in Result and mark the row Done.`
2. Within 5 minutes (or right away via `POST /watcher/run-now`) the agent's
   inbox gets a note.
3. The agent's detector sees `count > 0` on `/peek`, wakes a session, which
   reads the note, claims the row, writes the result, sets `Done` and acks.

## Things you will probably want next

These are the first gaps I ran into, in case they help you decide what to
build:

- **Stale claims.** An agent dies mid-task and the row sits at `Running`
  forever. A rule like "a claim with no update for 24 hours may be released"
  helps; so does a `Checkpoint` property the agent updates as it goes, so
  someone else can resume.
- **"Whose job is this?" loops.** Two agents each say a row belongs to the
  other. Making `Owner` the only thing that decides who claims a row fixes
  most of it.
- **Knowing an agent is alive.** One row per agent that it overwrites on
  every check ("last checked at…, open rows: n") is a cheap dashboard.
- **Reference material vs. tasks.** Instructions an agent re-reads every
  session belong on a page it has access to, not repeated in each row.
