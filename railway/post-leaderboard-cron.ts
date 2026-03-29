const TARGET_URL = (process.env.LEADERBOARD_TARGET_URL || "").trim();
const TRIGGER_TOKEN =
  (process.env.LEADERBOARD_TRIGGER_TOKEN || process.env.PRECOMPUTE_TRIGGER_TOKEN || "").trim();
const TIMEFRAME = (process.env.LEADERBOARD_TIMEFRAME || "yesterday").trim().toLowerCase();
const CHANNEL_ID = (process.env.LEADERBOARD_CHANNEL_ID || "").trim();
const DATE_OVERRIDE = (process.env.LEADERBOARD_DATE_OVERRIDE || "").trim();

async function main() {
  if (!TARGET_URL) {
    throw new Error("Missing LEADERBOARD_TARGET_URL.");
  }

  const url = new URL(TARGET_URL);
  const body = {
    timeframe: TIMEFRAME === "today" ? "today" : "yesterday",
  };

  if (CHANNEL_ID) {
    url.searchParams.set("channelId", CHANNEL_ID);
  }

  if (DATE_OVERRIDE) {
    url.searchParams.set("date", DATE_OVERRIDE);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(TRIGGER_TOKEN ? { "x-leaderboard-token": TRIGGER_TOKEN } : {}),
    },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let payload: unknown = rawText;

  try {
    payload = JSON.parse(rawText);
  } catch {
    // Keep the raw text if the server returned non-JSON.
  }

  if (!response.ok) {
    throw new Error(
      `Leaderboard post failed with ${response.status} ${response.statusText}: ${JSON.stringify(
        payload
      )}`
    );
  }

  console.log("Leaderboard post succeeded:", payload);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Leaderboard cron function failed:", error);
    process.exit(1);
  });
