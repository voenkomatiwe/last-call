export interface HealthResponse {
  readonly status: "ok";
  readonly service: "last-call-web";
}

// Never prerender: this route reports that the server process is running.
export const dynamic = "force-dynamic";

export function GET(): Response {
  const body: HealthResponse = { status: "ok", service: "last-call-web" };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
