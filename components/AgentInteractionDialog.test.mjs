import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { isolateClaudeHome, isolatePiHome } from "../lib/claude-test-home.mjs";

await isolateClaudeHome();
await isolatePiHome();
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { AgentInteractionDialog } = await jiti.import("./AgentInteractionDialog.tsx");

function renderQuestion(question) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(AgentInteractionDialog, {
      request: { type: "agent_interaction_request", id: "q", kind: "question", title: "Question", questions: [question], submitting: false, error: null },
      waitingCount: 0,
      onRespond() {},
    }),
  ));
}

test("secret questions use a masked input and other questions accept free text", () => {
  const base = { question: "Answer", options: [] };
  assert.match(renderQuestion({ ...base, isSecret: true }), /<input type="password"/);
  assert.match(renderQuestion({ ...base, isOther: true }), /<input type="text"/);
});

test("approval controls expose only allowed plain decisions", () => {
  const render = approvalOptions => renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(AgentInteractionDialog, {
      request: { type: "agent_interaction_request", id: "p", kind: "permission", title: "Codex", approvalOptions, submitting: false, error: null },
      waitingCount: 0, onRespond() {},
    }),
  ));
  const both = render({ accept: true, decline: true });
  assert.match(both, />Allow<\/button>/);
  assert.match(both, />Deny<\/button>/);
  const limited = render({ accept: false, decline: true });
  assert.doesNotMatch(limited, />Allow<\/button>/);
  assert.match(limited, />Deny<\/button>/);
  assert.match(limited, /does not support/);
  const none = render({ accept: false, decline: false });
  assert.doesNotMatch(none, />Allow<\/button>|>Deny<\/button>/);
  assert.match(none, /does not support/);
  assert.match(none, />Cancel<\/button>/);
});
