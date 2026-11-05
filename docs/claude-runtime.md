# Claude and Pi sessions

Choose **Pi** or **Claude** in a new conversation. The choice stays fixed after creation. Pi remains the default. Claude uses native Claude Code through the pinned official Agent SDK; it does not send a Claude model through Pi.

## Native configuration

Install a compatible Claude Code executable and authenticate it using your normal local setup. The verified combination is Claude Code 2.1.318 and `@anthropic-ai/claude-agent-sdk` 0.3.318. Pi Web uses the executable on the server PATH, or an absolute `PI_WEB_CLAUDE_EXECUTABLE` path. No credentials are copied into Pi settings.

The model comes from native Claude settings and is displayed read-only. Pi provider, model, thinking and tool-preset selections are never passed to Claude. Settings shows the user, project and local Claude settings files. Native MCP, skills, agents, hooks and plugins follow Claude discovery rules. Changes take effect according to the native runtime lifecycle.

Before the first prompt in a runtime, confirm project trust. This allows native project resources to start. Listing sessions, viewing history and reading configuration do not start a model, hook or MCP server.

## Conversations and tools

Native terminal history appears beside Pi history. Claude session URLs use `claude:<uuid>`; existing Pi URLs remain valid. Replies, thinking, images, tool cards, permission requests and question dialogs use the shared chat UI. Permission answers are single-use and reconciled when a page reconnects. Stop also cancels pending input and startup.

Use the sidebar **Fork** action for an independent native copy. `/side` opens a side conversation with inherited history and a persistent no-tool policy: tools, MCP and hooks are disabled. A side conversation cannot widen its policy. Native subagents have a read-only history viewer under their parent; they are not independently controllable Pi agents.

Claude native slash commands stay native. Web-owned `/side`, `/name`, `/session` and `/copy` remain available. Pi-only controls, extension widgets and tree navigation are not advertised as Claude capabilities. The manual Pi compaction toolbar is unavailable for Claude; native commands and automatic compaction retain their native semantics.

Avoid continuing the same native session simultaneously from Web and an external CLI. Web coordinates its own writers, but cannot reliably detect an external terminal writer. Forking does not roll back files.

## Limits and operations

- The pinned SDK can return historical system entries without their content or subtype. Native compaction and its summary work, but Web does not invent historical compaction markers from those incomplete entries. History and export follow the native history API’s available conversation chain.
- Historical aggregate token/cost statistics are unavailable where the native history API does not supply them. Latest native result metrics keep their cumulative query/session scope; repeated results are not summed.
- HTML export is a safe conversation display export, not a portable Claude session backup. Native transcripts remain authoritative.
- Native fork side-policy metadata is stored separately from the transcript. An interrupted side-fork transaction fails closed by quarantining new sessions in that project until the transaction can be resolved; do not remove its policy metadata to bypass the restriction.
- `PI_WEB_CLAUDE=0` (or `false`) disables Claude runtime and native mutations while leaving history visible. Pi continues normally.
- Run the application under a service environment that can find the intended Claude executable. Installing the SDK alone does not install or configure native CLI authentication.

The implementation does not migrate Pi history, replace native authentication, or deploy/restart a running service.
