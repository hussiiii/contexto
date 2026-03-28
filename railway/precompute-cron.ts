const TARGET_URL = (process.env.PRECOMPUTE_TARGET_URL || "").trim();
const TRIGGER_TOKEN = (process.env.PRECOMPUTE_TRIGGER_TOKEN || "").trim();
const TIMEZONE = (process.env.PRECOMPUTE_TIMEZONE || "America/Los_Angeles").trim();
const LOCAL_HOUR = Number(process.env.PRECOMPUTE_LOCAL_HOUR || 0);
const LOCAL_MINUTE = Number(process.env.PRECOMPUTE_LOCAL_MINUTE || 1);
const SKIP_TIME_GATE =
  String(process.env.PRECOMPUTE_SKIP_TIME_GATE || "").trim().toLowerCase() === "true";
const FORCE_REFRESH =
  String(process.env.PRECOMPUTE_FORCE_REFRESH || "").trim().toLowerCase() === "true";

function getLocalTimeParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const entries = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: entries.year,
    month: entries.month,
    day: entries.day,
    hour: Number(entries.hour),
    minute: Number(entries.minute),
    second: Number(entries.second),
  };
}

async function main() {
  if (!TARGET_URL) {
    throw new Error("Missing PRECOMPUTE_TARGET_URL.");
  }

  const now = new Date();
  const parts = getLocalTimeParts(now, TIMEZONE);
  const localTimestamp = `${parts.year}-${parts.month}-${parts.day} ${String(parts.hour).padStart(
    2,
    "0"
  )}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;

  if (!SKIP_TIME_GATE && (parts.hour !== LOCAL_HOUR || parts.minute !== LOCAL_MINUTE)) {
    console.log(
      `Skipping precompute at ${localTimestamp} ${TIMEZONE}; waiting for ${String(
        LOCAL_HOUR
      ).padStart(2, "0")}:${String(LOCAL_MINUTE).padStart(2, "0")}.`
    );
    return;
  }

  if (SKIP_TIME_GATE) {
    console.log(`Time gate bypass enabled. Triggering precompute at ${localTimestamp} ${TIMEZONE}.`);
  }

  const url = new URL(TARGET_URL);

  if (FORCE_REFRESH) {
    url.searchParams.set("force", "true");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(TRIGGER_TOKEN ? { "x-precompute-token": TRIGGER_TOKEN } : {}),
    },
    body: JSON.stringify(FORCE_REFRESH ? { force: true } : {}),
  });

  const rawText = await response.text();
  let payload: unknown = rawText;

  try {
    payload = JSON.parse(rawText);
  } catch {
    // Keep the raw text if the server returned a non-JSON response.
  }

  if (!response.ok) {
    throw new Error(
      `Precompute request failed with ${response.status} ${response.statusText}: ${JSON.stringify(
        payload
      )}`
    );
  }

  console.log("Precompute request succeeded:", payload);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Precompute cron function failed:", error);
    process.exit(1);
  });
