import { NextResponse } from "next/server";
import { sessions } from "@/lib/backend-service";
import { sessionRouteRefusal } from "@/lib/session-route-identity";

export const runtime = "nodejs";

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const invalidSession = sessionRouteRefusal(id);
  if (invalidSession) return invalidSession;
  const inline = new URL(req.url).searchParams.get("inline") === "1";

  try {
    const result = await sessions.exportSession({ id });
    if (!result.ok) {
      if (result.kind === "not-found") return NextResponse.json({ error: "Session not found" }, { status: 404 });
      if (result.kind === "error") return NextResponse.json({ error: String(result.error) }, { status: 500 });
      return sessionRouteRefusal(id)!;
    }
    const { backend, html, fileName } = result.value;
    if (backend === "claude") {
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": getContentDisposition(fileName, inline),
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    }
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": getContentDisposition(fileName, inline),
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
