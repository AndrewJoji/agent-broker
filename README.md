# agent-broker

Shared message broker for the agent team (Muse, Claude, and future queue workers).

- Cloudflare Worker + KV (`agent-inbox` bound as `INBOX`)
- HTTP routes: POST/GET inboxes per agent
- Cron trigger: watches the Notion Agent Queue, nudges agent inboxes when work is waiting

Deploys automatically from this repo via the Cloudflare GitHub integration.
