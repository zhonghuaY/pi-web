# Claude and Pi sessions

Choose **Pi** or **Claude** in a new conversation. The choice stays fixed after creation. Pi remains the default. Claude uses native Claude Code through the pinned official Agent SDK; it does not send a Claude model through Pi.

## Native configuration

Install a compatible Claude Code executable and authenticate it using your normal local setup. The verified combination is Claude Code 2.1.318 and `@anthropic-ai/claude-agent-sdk` 0.3.318. Pi Web uses the executable on the server PATH, or an absolute `PI_WEB_CLAUDE_EXECUTABLE` path. No credentials are copied into Pi settings.

The native Claude setting supplies the initial model. The model picker reads the complete catalogue from the SDK’s `supportedModels()` result, which already applies Claude Code aliases, `modelPicker`, gateway discovery, `modelOverrides`, managed allowlists, and custom model options. Claude Code does not define a separate `~/.claude/models.json` contract; Pi Web does not parse third-party files that may use that name or expose their credentials. The composer can override the selected model and its native supported effort level for the current Claude session through the SDK’s `setModel` and flag-settings APIs; these are not Pi provider or thinking settings. Pi tool presets are never passed to Claude. Settings shows the user, project and local Claude settings files. Native MCP, skills, agents, hooks and plugins follow Claude discovery rules.

Before the first prompt or project-resource discovery in a runtime, confirm project trust. Discovery starts a native session without making a model request, then loads the account’s model catalogue and the project’s native slash commands and skills. Listing sessions, viewing history and reading configuration remain dormant. Normal Claude sessions start with the SDK equivalent of `--dangerously-skip-permissions` (`bypassPermissions` plus its explicit safety opt-in), so tool calls do not repeatedly request approval. This is intentionally not applied to side sessions, which remain locked to plan mode with no tools.

## Conversations and tools

Native terminal history appears beside Pi history. Claude session URLs use `claude:<uuid>`; existing Pi URLs remain valid. Replies, thinking, images, tool cards, permission requests and question dialogs use the shared chat UI. Permission answers are single-use and reconciled when a page reconnects. Stop also cancels pending input and startup.

Use the sidebar **Fork** action for an independent native copy. `/side` opens a side conversation with inherited history and a persistent no-tool policy: tools, MCP and hooks are disabled. A side conversation cannot widen its policy. Native subagents have a read-only history viewer under their parent; they are not independently controllable Pi agents.

Claude native slash commands stay native. Their live catalogue, including project skills, appears in slash completion and updates when Claude reports newly discovered commands. Selecting one sends its native `/name` form to Claude. Web-owned `/side`, `/name`, `/session` and `/copy` remain available. Pi-only controls, extension widgets and tree navigation are not advertised as Claude capabilities. The manual Pi compaction toolbar is unavailable for Claude; native commands and automatic compaction retain their native semantics.

Avoid continuing the same native session simultaneously from Web and an external CLI. Web coordinates its own writers, but cannot reliably detect an external terminal writer. Forking does not roll back files.

## Limits and operations

- The pinned SDK can return historical system entries without their content or subtype. Native compaction and its summary work, but Web does not invent historical compaction markers from those incomplete entries. History and export follow the native history API’s available conversation chain.
- Historical aggregate token/cost statistics are unavailable where the native history API does not supply them. Latest native result metrics keep their cumulative query/session scope; repeated results are not summed.
- HTML export is a safe conversation display export, not a portable Claude session backup. Native transcripts remain authoritative.
- Native fork side-policy metadata is stored separately from the transcript. An interrupted side-fork transaction fails closed by quarantining new sessions in that project until the transaction can be resolved; do not remove its policy metadata to bypass the restriction.
- `PI_WEB_CLAUDE=0` (or `false`) disables Claude runtime and native mutations while leaving history visible. Pi continues normally.
- Run the application under a service environment that can find the intended Claude executable. Installing the SDK alone does not install or configure native CLI authentication.

The implementation does not migrate Pi history, replace native authentication, or deploy/restart a running service.
