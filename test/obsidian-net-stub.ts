// An `obsidian` stub whose `requestUrl` is real, backed by Node's fetch.
//
// Used only by the network probe (`npm run probe:network`), never by the test
// suite: these calls hit GitHub, so they are slow, rate-limited and offline-
// hostile — everything a unit test should not be. The probe exists to catch the
// one class of failure unit tests structurally cannot, which is the remote API
// changing shape underneath us.

export const apiVersion = "1.5.0";

export interface RequestUrlParam {
  url: string;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  json: unknown;
  text: string;
}

export async function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
  const res = await fetch(param.url, {
    headers: {
      // GitHub refuses unauthenticated API calls without a User-Agent, and
      // Obsidian's own requestUrl always sends one.
      "User-Agent": "flowkit-health-dashboard-probe",
      Accept: "application/vnd.github+json",
    },
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    // `json` is a getter on Obsidian's response that throws on malformed
    // bodies; the parse failure surfacing here matches that behaviour.
    get json(): unknown {
      return JSON.parse(text);
    },
  };
}
