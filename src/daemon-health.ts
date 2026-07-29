import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { SERVICE_NAME } from "./install-paths.js";

export const DAEMON_HEALTH_PROTOCOL =
  "read-my-chatgpt-daemon-health-v1";

export type DaemonHealthState = "ok" | "stopping";

export class DaemonHealthVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonHealthVerificationError";
  }
}

export function createDaemonHealthChallenge(): string {
  return randomBytes(32).toString("base64url");
}

export function isDaemonHealthChallenge(
  challenge: unknown,
): challenge is string {
  return (
    typeof challenge === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(challenge)
  );
}

export function createDaemonHealthProof(
  bearerToken: string,
  challenge: string,
  state: DaemonHealthState,
): string {
  return createHmac("sha256", bearerToken)
    .update(DAEMON_HEALTH_PROTOCOL)
    .update("\0")
    .update(challenge)
    .update("\0")
    .update(state)
    .digest("base64url");
}

export function validDaemonHealthProof(
  proof: unknown,
  bearerToken: string,
  challenge: string,
  state: DaemonHealthState,
): boolean {
  if (typeof proof !== "string") return false;
  const expected = Buffer.from(
    createDaemonHealthProof(bearerToken, challenge, state),
  );
  const actual = Buffer.from(proof);
  return (
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

export async function fetchVerifiedDaemonHealth(
  healthUrl: URL,
  bearerToken: string,
  timeoutMs: number,
): Promise<DaemonHealthState> {
  const challenge = createDaemonHealthChallenge();
  const challengedUrl = new URL(healthUrl);
  challengedUrl.searchParams.set("challenge", challenge);
  const response = await fetch(challengedUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new DaemonHealthVerificationError(
      `daemon health returned HTTP ${response.status}`,
    );
  }

  let body: {
    status?: unknown;
    server?: unknown;
    protocol?: unknown;
    proof?: unknown;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new DaemonHealthVerificationError(
      "daemon health returned invalid JSON",
    );
  }
  if (
    body.server !== SERVICE_NAME ||
    body.protocol !== DAEMON_HEALTH_PROTOCOL ||
    (body.status !== "ok" && body.status !== "stopping") ||
    !validDaemonHealthProof(
      body.proof,
      bearerToken,
      challenge,
      body.status,
    )
  ) {
    throw new DaemonHealthVerificationError(
      "daemon health proof could not be verified",
    );
  }
  return body.status;
}
