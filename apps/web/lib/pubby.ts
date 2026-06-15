import { PubbyServer } from "@getpubby/sdk/server";

/**
 * Whether Pubby is configured. On self-hosted / no-Pubby installs this is
 * false: `pubby` below becomes a no-op stub, callers that check this flag
 * early-return, and the browser switches to polling when NEXT_PUBLIC_PUBBY_KEY
 * is absent.
 */
export const PUBBY_ENABLED = !!(
  process.env.PUBBY_APP_ID &&
  process.env.PUBBY_APP_KEY &&
  process.env.PUBBY_APP_SECRET
);

// Self-hosted without real-time: when Pubby isn't configured, export a no-op
// stub so trigger()/auth calls resolve quietly instead of hitting api.pubby.dev
// with empty creds (500 -> unhandledRejection + log spam).
export const pubby = PUBBY_ENABLED
  ? new PubbyServer({
      appId: process.env.PUBBY_APP_ID!,
      key: process.env.PUBBY_APP_KEY!,
      secret: process.env.PUBBY_APP_SECRET!,
      apiHost: "https://api.pubby.dev",
    })
  : ({
      trigger: async () => {},
      authenticatePresenceChannel: () => ({ auth: "" }),
    } as unknown as PubbyServer);
