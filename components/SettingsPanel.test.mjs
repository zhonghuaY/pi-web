import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { CodexNativeModelSettings, settingsSectionsForBackend } = await jiti.import("./SettingsPanel.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const loginSource = await readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8");

test("the trust dialog Settings › MCP opens stacks above Settings", () => {
  const zIndex = (selector) => Number(cssSource.match(new RegExp(`\\${selector} \\{[^}]*z-index: (\\d+);`))?.[1]);
  assert.ok(zIndex(".project-trust-backdrop") > zIndex(".settings-dialog-backdrop"));
});

test("the login page returns only to a destination safeLoginDestination() accepts", () => {
  assert.match(loginSource, /safeLoginDestination\(destination, window\.location\.origin\)/);
});

test("Codex settings expose only native or read-only sections", () => {
  assert.deepEqual(settingsSectionsForBackend("codex"), ["general", "models", "skills", "mcp"]);
  assert.deepEqual(settingsSectionsForBackend("pi"), ["general", "models", "skills", "agents", "plugins", "mcp"]);
  assert.deepEqual(settingsSectionsForBackend("claude"), ["general", "models", "skills", "agents", "plugins", "mcp"]);

  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(CodexNativeModelSettings)),
  );
  assert.match(html, /Native Codex models/);
  assert.match(html, /chat composer/);
  assert.doesNotMatch(html, /ModelsConfig|AgentsConfig|PluginsConfig/);
});
