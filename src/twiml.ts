/**
 * twiml.ts
 *
 * Pure helpers for the TwiML the Twilio voice webhook returns. Kept separate
 * from the server so they can be unit-tested without standing up Fastify, and
 * so the host-normalization logic lives in exactly one place.
 */

/**
 * Normalize the public host from request headers. A proxy may set
 * x-forwarded-host (possibly as a comma-separated list); fall back to host.
 * Returns just the hostname, with any scheme stripped.
 */
export function resolveHost(headers: Record<string, unknown>): string {
  const raw =
    (headers["x-forwarded-host"] as string | string[] | undefined) ??
    (headers["host"] as string | undefined) ??
    "";
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first)
    .split(",")[0]
    .trim()
    .replace(/^https?:\/\//, "");
}

/**
 * Build the TwiML that tells Twilio to open a Media Stream to our /media
 * WebSocket. The host must be a bare domain (no scheme) so the resulting
 * wss:// URL is well-formed.
 */
export function incomingCallTwiml(host: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you now.</Say>
  <Connect>
    <Stream url="wss://${host}/media" />
  </Connect>
</Response>`;
}
