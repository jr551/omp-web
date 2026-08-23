import type { OAuthAuthInfo } from "@oh-my-pi/pi-ai/oauth";

type OAuthLoginCandidate = {
  id: string;
  storeCredentialsAs?: string;
};

export type WebOAuthAuthEvent =
  | {
      type: "auth";
      url: string;
      fullUrl: string;
      instructions: string | null;
      token: string;
    }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds: null;
      expiresInSeconds: null;
    };

/** Prefer OpenAI's headless login in the web UI so remote browsers need no loopback tunnel. */
export function selectWebOAuthLoginId(
  provider: string,
  candidates: readonly OAuthLoginCandidate[],
): string | undefined {
  const matches = candidates.filter((candidate) => (candidate.storeCredentialsAs ?? candidate.id) === provider);
  if (provider === "openai-codex") {
    const deviceFlow = matches.find((candidate) => candidate.id === "openai-codex-device");
    if (deviceFlow) return deviceFlow.id;
  }
  return matches[0]?.id;
}

export function createWebOAuthAuthEvent(
  loginId: string,
  info: OAuthAuthInfo,
  token?: string,
): WebOAuthAuthEvent {
  if (loginId === "openai-codex-device") {
    const userCode = info.instructions?.match(/enter code:\s*(\S+)/i)?.[1];
    if (!userCode) throw new Error("OpenAI device login did not provide a verification code");
    return {
      type: "device_code",
      userCode,
      verificationUri: info.url,
      intervalSeconds: null,
      expiresInSeconds: null,
    };
  }

  if (!token) throw new Error("OAuth browser login requires a callback token");
  return {
    type: "auth",
    url: info.launchUrl ?? info.url,
    fullUrl: info.url,
    instructions: info.instructions ?? null,
    token,
  };
}
