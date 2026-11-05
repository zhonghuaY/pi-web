import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createAgentEventStream } from "./agent-event-stream";
import { allowFileRoot } from "./file-access";
import { invalidateSessionListCache, attachSessionProjectInfo } from "./session-reader";
import { describeStreamClient } from "./stream-client";
import { isValidLivenessHolder } from "./session-liveness";
import { forgetSessionUiState } from "./session-ui-state";
export { claudeEnabled, claudeBackend } from "./agent-catalog";
import { claudeEnabled, claudeBackend } from "./agent-catalog";

export function isClaudeKey(id: string): boolean {
  return id.startsWith("claude:");
}

export function claudeFailure(error: unknown): Response {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status : 400;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Claude operation failed" }, { status });
}

export async function claudeCreate(body: Record<string, unknown>): Promise<Response> {
  try {
    if (!claudeEnabled()) return NextResponse.json({ error: "Claude is disabled" }, { status: 409 });
    if (typeof body.cwd !== "string" || !isAbsolute(body.cwd) || !(await stat(body.cwd)).isDirectory()) {
      return NextResponse.json({ error: "An existing absolute project directory is required" }, { status: 400 });
    }
    if (body.type !== "prompt" && body.type !== "ensure_session") {
      return NextResponse.json({ error: "Unsupported new-session command" }, { status: 400 });
    }
    if (body.provider !== undefined || body.thinkingLevel !== undefined || body.toolNames !== undefined) {
      return NextResponse.json({ error: "Claude does not accept Pi provider, thinking level, or tool selections" }, { status: 400 });
    }
    if (body.modelId !== undefined && (typeof body.modelId !== "string" || !body.modelId.trim())) {
      return NextResponse.json({ error: "Claude modelId must be a non-empty string" }, { status: 400 });
    }
    if (body.effort !== undefined && (typeof body.effort !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(body.effort))) {
      return NextResponse.json({ error: "Unsupported Claude effort level" }, { status: 400 });
    }
    if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)) {
      return NextResponse.json({ error: "A stable requestId UUID is required" }, { status: 400 });
    }
    const backend = await claudeBackend();
    const session = await backend.createClaudeSession(body.cwd, {
      requestId: body.requestId,
      trustProject: body.trustProject === true,
      ...(typeof body.modelId === "string" ? { modelId: body.modelId } : {}),
      ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
    });
    allowFileRoot(body.cwd);
    invalidateSessionListCache();
    const state = await session.send({ type: "get_state" });
    let data: unknown = null;
    if (body.type === "prompt") {
      try { data = await session.send(body); }
      catch (error) {
        await backend.discardRejectedClaudeCreation(session.sessionId, body.requestId);
        invalidateSessionListCache();
        throw error;
      }
    }
    return NextResponse.json({ success: true, sessionId: session.sessionId, backend: "claude", data, state });
  } catch (error) { return claudeFailure(error); }
}

export async function claudeCommand(id: string, command: Record<string, unknown>): Promise<Response> {
  try {
    if (!claudeEnabled()) return NextResponse.json({ error: "Claude is disabled" }, { status: 409 });
    const backend = await claudeBackend();
    const session = await backend.ensureClaudeSession(id);
    return NextResponse.json({ success: true, data: await session.send(command) });
  } catch (error) { return claudeFailure(error); }
}

export async function claudeState(id: string): Promise<Response> {
  try {
    const backend = await claudeBackend();
    const session = backend.getClaudeSession(id);
    if (session?.isAlive()) return NextResponse.json({ running: true, state: await session.send({ type: "get_state" }) });
    await backend.readClaudeSession(id);
    return NextResponse.json({ running: false, state: { backend: "claude", requiresProjectTrust: true, capabilities: backend.CLAUDE_CAPABILITIES } });
  } catch (error) { return claudeFailure(error); }
}

export async function claudeEvents(req: Request, id: string): Promise<Response> {
  try {
    const backend = await claudeBackend();
    const session = await backend.ensureClaudeSession(id);
    const holder = new URL(req.url).searchParams.get("holder");
    return new Response(createAgentEventStream(req, id, Promise.resolve(session), {
      holder: isValidLivenessHolder(holder) ? holder : null,
      ...describeStreamClient(req.headers),
    }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) { return claudeFailure(error); }
}

export async function claudeSession(req: Request, id: string, contextOnly = false): Promise<Response> {
  try {
    const params = new URL(req.url).searchParams;
    const count = Number(params.get("tail"));
    const tail = Number.isInteger(count) && count > 0 ? Math.min(count, 1000) : 50;
    const before = params.get("before") ?? undefined;
    const snapshot = await (await claudeBackend()).readClaudeSession(id, { tail, before });
    const info = (await attachSessionProjectInfo([snapshot.info]))[0];
    return NextResponse.json(contextOnly ? { context: snapshot.context, tail, before: before ?? null } : { ...snapshot, info }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return claudeFailure(error); }
}

export async function claudeFork(id: string, body: { side?: unknown; name?: unknown; entryId?: unknown }): Promise<Response> {
  try {
    if (!claudeEnabled()) return NextResponse.json({ error: "Claude is disabled" }, { status: 409 });
    const backend = await claudeBackend();
    const session = await backend.forkClaudeSession(id, {
      side: body.side === true,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.entryId === "string" ? { entryId: body.entryId } : {}),
    });
    invalidateSessionListCache();
    return NextResponse.json({ sessionId: session.id, session });
  } catch (error) { return claudeFailure(error); }
}

export async function claudeRename(id: string, name: string): Promise<Response> {
  try {
    if (!claudeEnabled()) return NextResponse.json({ error: "Claude is disabled" }, { status: 409 });
    if (!name.trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 });
    await (await claudeBackend()).renameClaudeSession(id, name.trim());
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) { return claudeFailure(error); }
}

export async function claudeDelete(id: string): Promise<Response> {
  try {
    if (!claudeEnabled()) return NextResponse.json({ error: "Claude is disabled" }, { status: 409 });
    await (await claudeBackend()).deleteClaudeSession(id);
    await forgetSessionUiState([id]);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) { return claudeFailure(error); }
}
