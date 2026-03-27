import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import OpenAI from "openai";
import { Pool } from "pg";
import { words as popularWords } from "popular-english-words";
import sharp from "sharp";

dotenv.config();

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_GUILD_ID,
  DEFAULT_CHANNEL_ID,
  DATABASE_URL,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  PORT = "3000",
} = process.env;

const requiredEnvVars = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
];

const missingEnvVars = requiredEnvVars.filter((name) => !process.env[name]);

if (missingEnvVars.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnvVars.join(", ")}`
  );
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "..");
const puzzleFilePath = path.join(projectRoot, "data", "puzzles", "sample.json");
const generatedDataDirectory = path.join(projectRoot, "data", "generated");
const semanticCacheFilePath = path.join(
  generatedDataDirectory,
  "sample-semantic-cache.json"
);
const answersFilePath = path.join(
  generatedDataDirectory,
  "answers.json"
);
const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const RANKING_VOCAB_SIZE = Number(process.env.RANKING_VOCAB_SIZE || "50000");
const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || "128");
const SCORING_VERSION = "lexical-penalty-v2-family-dedupe-v1-popular-words-v1";
const APP_SESSION_TTL_DAYS = 30;
const DISCORD_OAUTH_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_OAUTH_ME_URL = "https://discord.com/api/oauth2/@me";
const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: OPENAI_BASE_URL || undefined,
    })
  : null;
const progressPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl:
        DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1")
          ? undefined
          : { rejectUnauthorized: false },
    })
  : null;
const STOP_WORDS = new Set([
  "about", "after", "again", "against", "all", "also", "although", "always",
  "among", "and", "another", "any", "are", "around", "because", "been",
  "before", "being", "below", "between", "both", "but", "can", "could",
  "did", "does", "doing", "down", "during", "each", "either", "enough",
  "even", "every", "few", "for", "from", "further", "had", "has", "have",
  "having", "here", "hers", "herself", "him", "himself", "his", "how",
  "however", "into", "its", "itself", "just", "made", "make", "many",
  "might", "more", "most", "much", "must", "near", "neither", "nor",
  "not", "off", "often", "once", "only", "onto", "other", "our", "ours",
  "ourselves", "out", "over", "own", "same", "should", "since", "some",
  "such", "than", "that", "the", "their", "theirs", "them", "themselves",
  "then", "there", "these", "they", "this", "those", "through", "too",
  "toward", "under", "until", "upon", "very", "was", "were", "what",
  "when", "where", "which", "while", "who", "whom", "whose", "will",
  "with", "within", "without", "would", "your", "yours", "yourself",
  "yourselves"
]);

const app = express();
app.use(express.json());
app.use(
  "/vendor/embedded-app-sdk",
  express.static(
    path.join(projectRoot, "node_modules", "@discord", "embedded-app-sdk", "output")
  )
);
app.use(express.static(path.join(projectRoot, "public")));

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const PLAY_BUTTON_ID = "contexto-play";
const guessScoreCache = new Map();
const avatarDataUriCache = new Map();
let semanticPuzzlePromise;
let acceptedWordsPromise;
let allowedAnswersPromise;
let progressStorageReadyPromise;

const slashCommands = [
  new SlashCommandBuilder()
    .setName("contexto-post")
    .setDescription("Post a Contexto play prompt into a text channel.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Optional text channel override for the play prompt.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .toJSON(),
];

async function registerGuildCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
    { body: slashCommands }
  );

  console.log("Registered guild slash commands.");
}

async function loadPuzzle() {
  const rawPuzzle = await fs.readFile(puzzleFilePath, "utf8");
  return JSON.parse(rawPuzzle);
}

function isProgressPersistenceEnabled() {
  return Boolean(progressPool);
}

async function ensureProgressStorage() {
  if (!progressPool) {
    console.log(
      "Postgres progress storage disabled: DATABASE_URL is not set. Player progress will not persist across sessions."
    );
    return;
  }

  if (!progressStorageReadyPromise) {
    progressStorageReadyPromise = (async () => {
      console.log("Initializing Postgres progress storage...");

      await progressPool.query(`
        CREATE TABLE IF NOT EXISTS player_progress (
          user_id TEXT NOT NULL,
          puzzle_id TEXT NOT NULL,
          guild_id TEXT,
          channel_id TEXT,
          display_name TEXT NOT NULL,
          avatar_url TEXT,
          guesses_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          solved_answer TEXT,
          gave_up BOOLEAN NOT NULL DEFAULT FALSE,
          result_posted BOOLEAN NOT NULL DEFAULT FALSE,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at TIMESTAMPTZ,
          PRIMARY KEY (user_id, puzzle_id)
        )
      `);
      await progressPool.query(`
        CREATE INDEX IF NOT EXISTS player_progress_puzzle_id_idx
        ON player_progress (puzzle_id)
      `);
      await progressPool.query(`
        CREATE TABLE IF NOT EXISTS app_sessions (
          session_token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          avatar_url TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL
        )
      `);
      await progressPool.query(`
        CREATE INDEX IF NOT EXISTS app_sessions_user_id_idx
        ON app_sessions (user_id)
      `);
      await progressPool.query(`
        CREATE TABLE IF NOT EXISTS player_progress_messages (
          user_id TEXT NOT NULL,
          puzzle_id TEXT NOT NULL,
          guild_id TEXT,
          channel_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, puzzle_id, channel_id)
        )
      `);
      await progressPool.query(`
        DELETE FROM app_sessions
        WHERE expires_at <= NOW()
      `);

      console.log("Postgres progress storage ready.");
    })();
  }

  await progressStorageReadyPromise;
}

function normalizeOptionalText(value, maxLength = 255) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizePlayerContext(rawPlayer) {
  const userId = normalizeOptionalText(rawPlayer?.userId, 80);

  if (!userId) {
    return null;
  }

  return {
    userId,
    displayName:
      normalizeOptionalText(rawPlayer?.displayName, 120) ||
      normalizeOptionalText(rawPlayer?.username, 120) ||
      "Player",
    avatarUrl: normalizeOptionalText(rawPlayer?.avatarUrl, 500),
    guildId: normalizeOptionalText(rawPlayer?.guildId, 80),
    channelId: normalizeOptionalText(rawPlayer?.channelId, 80),
  };
}

function hashSessionToken(sessionToken) {
  return crypto.createHash("sha256").update(String(sessionToken || "")).digest("hex");
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getSessionExpiryDate() {
  return new Date(Date.now() + APP_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function overlaySessionContext(player, rawContext) {
  if (!player) {
    return null;
  }

  return {
    ...player,
    guildId: normalizeOptionalText(rawContext?.guildId, 80) || player.guildId || null,
    channelId: normalizeOptionalText(rawContext?.channelId, 80) || player.channelId || null,
  };
}

async function createAppSession(player) {
  if (!progressPool || !player) {
    return null;
  }

  await ensureProgressStorage();

  const sessionToken = createSessionToken();
  const expiresAt = getSessionExpiryDate();

  await progressPool.query(
    `
      INSERT INTO app_sessions (
        session_token_hash,
        user_id,
        display_name,
        avatar_url,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      hashSessionToken(sessionToken),
      player.userId,
      player.displayName,
      player.avatarUrl,
      expiresAt.toISOString(),
    ]
  );

  console.log(`Created app session for Discord user ${player.userId}.`);

  return {
    sessionToken,
    expiresAt: expiresAt.toISOString(),
  };
}

async function loadPlayerFromSession(sessionToken, rawContext) {
  if (!progressPool) {
    return null;
  }

  const normalizedToken = normalizeOptionalText(sessionToken, 512);

  if (!normalizedToken) {
    return null;
  }

  await ensureProgressStorage();

  const result = await progressPool.query(
    `
      SELECT user_id, display_name, avatar_url
      FROM app_sessions
      WHERE session_token_hash = $1
        AND expires_at > NOW()
      LIMIT 1
    `,
    [hashSessionToken(normalizedToken)]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  const player = normalizePlayerContext({
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  });

  await progressPool.query(
    `
      UPDATE app_sessions
      SET last_used_at = NOW(),
          expires_at = $2
      WHERE session_token_hash = $1
    `,
    [hashSessionToken(normalizedToken), getSessionExpiryDate().toISOString()]
  );

  return overlaySessionContext(player, rawContext);
}

async function resolvePlayerContext(rawRequestBody) {
  const sessionPlayer = await loadPlayerFromSession(
    rawRequestBody?.sessionToken,
    rawRequestBody
  );

  if (sessionPlayer) {
    return sessionPlayer;
  }

  if (rawRequestBody?.sessionToken) {
    throw new Error("Your session expired. Please reopen the activity.");
  }

  return normalizePlayerContext(rawRequestBody?.player);
}

function normalizeStoredGuessEntry(rawEntry) {
  const guess = normalizeGuess(rawEntry?.guess);
  const rank = Number(rawEntry?.rank);

  if (!guess || !Number.isFinite(rank) || rank <= 0) {
    return null;
  }

  return {
    guess,
    rank: Math.round(rank),
    solved: Boolean(rawEntry?.solved),
    hinted: Boolean(rawEntry?.hinted),
    revealed: Boolean(rawEntry?.revealed),
    countsTowardScore: rawEntry?.countsTowardScore !== false,
  };
}

function normalizeStoredGuesses(rawGuesses) {
  if (!Array.isArray(rawGuesses)) {
    return [];
  }

  return rawGuesses.map(normalizeStoredGuessEntry).filter(Boolean);
}

function countScoredGuesses(guesses) {
  return guesses.filter((entry) => entry.countsTowardScore !== false).length;
}

function getBestRankFromGuesses(guesses) {
  const scoredGuesses = guesses.filter((entry) => entry.countsTowardScore !== false);

  if (scoredGuesses.length === 0) {
    return null;
  }

  return Math.min(...scoredGuesses.map((entry) => entry.rank));
}

async function loadPlayerProgress(player, puzzleId) {
  if (!progressPool || !player) {
    if (!player) {
      console.warn("Skipping progress load: missing player identity.");
    }
    return null;
  }

  await ensureProgressStorage();

  const result = await progressPool.query(
    `
      SELECT
        guesses_json,
        solved_answer,
        gave_up,
        result_posted
      FROM player_progress
      WHERE user_id = $1 AND puzzle_id = $2
      LIMIT 1
    `,
    [player.userId, puzzleId]
  );

  if (result.rows.length === 0) {
    console.log(`No saved progress found for user ${player.userId} on puzzle ${puzzleId}.`);
    return null;
  }

  const row = result.rows[0];
  const guesses = normalizeStoredGuesses(row.guesses_json);

  return {
    guesses,
    solvedAnswer: normalizeOptionalText(row.solved_answer, 120),
    gaveUp: Boolean(row.gave_up),
    resultPosted: Boolean(row.result_posted),
    guessCount: countScoredGuesses(guesses),
    hintCount: guesses.filter((entry) => entry.hinted).length,
    bestRank: getBestRankFromGuesses(guesses),
  };
}

async function savePlayerProgress({
  player,
  puzzleId,
  guesses,
  solvedAnswer = null,
  gaveUp = false,
  resultPosted = false,
}) {
  if (!progressPool || !player) {
    if (!player) {
      console.warn("Skipping progress save: missing player identity.");
    }
    return;
  }

  await ensureProgressStorage();

  const normalizedGuesses = normalizeStoredGuesses(guesses);
  const normalizedSolvedAnswer = normalizeOptionalText(solvedAnswer, 120);
  const finished = Boolean(normalizedSolvedAnswer || gaveUp);

  await progressPool.query(
    `
      INSERT INTO player_progress (
        user_id,
        puzzle_id,
        guild_id,
        channel_id,
        display_name,
        avatar_url,
        guesses_json,
        solved_answer,
        gave_up,
        result_posted,
        finished_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
      ON CONFLICT (user_id, puzzle_id)
      DO UPDATE SET
        guild_id = EXCLUDED.guild_id,
        channel_id = EXCLUDED.channel_id,
        display_name = EXCLUDED.display_name,
        avatar_url = COALESCE(EXCLUDED.avatar_url, player_progress.avatar_url),
        guesses_json = EXCLUDED.guesses_json,
        solved_answer = EXCLUDED.solved_answer,
        gave_up = EXCLUDED.gave_up,
        result_posted = EXCLUDED.result_posted OR player_progress.result_posted,
        updated_at = NOW(),
        finished_at = CASE
          WHEN EXCLUDED.finished_at IS NOT NULL
            THEN COALESCE(player_progress.finished_at, EXCLUDED.finished_at)
          ELSE player_progress.finished_at
        END
    `,
    [
      player.userId,
      puzzleId,
      player.guildId,
      player.channelId,
      player.displayName,
      player.avatarUrl,
      JSON.stringify(normalizedGuesses),
      normalizedSolvedAnswer,
      gaveUp,
      resultPosted,
      finished ? new Date().toISOString() : null,
    ]
  );
  console.log(
    `Saved progress for user ${player.userId} on puzzle ${puzzleId}: ${normalizedGuesses.length} guesses, solved=${Boolean(
      normalizedSolvedAnswer
    )}, gaveUp=${gaveUp}, resultPosted=${resultPosted}.`
  );
}

function createEmptyProgressState() {
  return {
    guesses: [],
    solvedAnswer: null,
    gaveUp: false,
    resultPosted: false,
    guessCount: 0,
    hintCount: 0,
    bestRank: null,
  };
}

function getGuessTone(rank) {
  if (rank <= 100) {
    return "green";
  }

  if (rank <= 500) {
    return "yellow";
  }

  return "red";
}

function summarizePlayerProgress(progress) {
  const normalizedProgress = progress || createEmptyProgressState();
  const guesses = normalizeStoredGuesses(normalizedProgress.guesses);
  const scoredGuesses = guesses.filter((entry) => entry.countsTowardScore !== false);
  const toneCounts = {
    green: 0,
    yellow: 0,
    red: 0,
  };

  for (const entry of scoredGuesses) {
    toneCounts[getGuessTone(entry.rank)] += 1;
  }

  const status = normalizedProgress.gaveUp
    ? "Gave up"
    : normalizedProgress.solvedAnswer
      ? "Solved"
      : "Attempted";

  return {
    status,
    guessCount: scoredGuesses.length,
    hintCount: scoredGuesses.filter((entry) => entry.hinted).length,
    greenCount: toneCounts.green,
    yellowCount: toneCounts.yellow,
    redCount: toneCounts.red,
  };
}

function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function getPlayerInitials(player) {
  const source = String(player?.displayName || "Player").trim();
  const parts = source.split(/\s+/).filter(Boolean).slice(0, 2);

  if (parts.length === 0) {
    return "P";
  }

  return parts.map((part) => part[0]?.toUpperCase() || "").join("").slice(0, 2) || "P";
}

async function getAvatarDataUri(avatarUrl) {
  const normalizedUrl = normalizeOptionalText(avatarUrl, 500);

  if (!normalizedUrl) {
    return null;
  }

  if (avatarDataUriCache.has(normalizedUrl)) {
    return avatarDataUriCache.get(normalizedUrl);
  }

  try {
    const response = await fetch(normalizedUrl);

    if (!response.ok) {
      throw new Error(`Avatar request failed with ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await response.arrayBuffer());
    const dataUri = `data:${contentType};base64,${buffer.toString("base64")}`;
    avatarDataUriCache.set(normalizedUrl, dataUri);
    return dataUri;
  } catch (error) {
    console.warn("Failed to fetch Discord avatar for progress card:", error);
    avatarDataUriCache.set(normalizedUrl, null);
    return null;
  }
}

function buildProgressCardSvg({ player, puzzle, summary, avatarDataUri }) {
  const badgeColors =
    summary.status === "Solved"
      ? { fill: "#153b2d", stroke: "#1f9d68", text: "#58d69e" }
      : summary.status === "Gave up"
        ? { fill: "#3d1f29", stroke: "#ff6b8c", text: "#ff9eb3" }
        : { fill: "#232a4a", stroke: "#6f8cff", text: "#b4c0ff" };

  const avatarMarkup = avatarDataUri
    ? `<image href="${avatarDataUri}" x="54" y="70" width="128" height="128" clip-path="url(#avatar-clip)" preserveAspectRatio="xMidYMid slice" />`
    : `
      <circle cx="118" cy="134" r="64" fill="#2b2b34" />
      <text x="118" y="148" text-anchor="middle" font-size="42" font-weight="700" fill="#f4f4f5">${escapeXml(
        getPlayerInitials(player)
      )}</text>
    `;

  return `
    <svg width="960" height="360" viewBox="0 0 960 360" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="avatar-clip">
          <circle cx="118" cy="134" r="64" />
        </clipPath>
      </defs>
      <rect width="960" height="360" rx="28" fill="#121215" />
      <rect x="18" y="18" width="924" height="324" rx="24" fill="#17171c" stroke="#2c2c33" stroke-width="2" />
      <text x="54" y="48" font-size="20" font-weight="700" fill="#e6e6eb">Contexto</text>
      <text x="165" y="48" font-size="20" fill="#a8a8b3">${escapeXml(puzzle?.date || "")}</text>

      ${avatarMarkup}
      <circle cx="118" cy="134" r="64" fill="none" stroke="#35353d" stroke-width="4" />

      <text x="214" y="106" font-size="34" font-weight="700" fill="#f4f4f5">${escapeXml(
        player?.displayName || "Player"
      )}</text>
      <rect x="214" y="124" width="148" height="40" rx="20" fill="${badgeColors.fill}" stroke="${badgeColors.stroke}" />
      <text x="288" y="150" text-anchor="middle" font-size="20" font-weight="700" fill="${badgeColors.text}">${escapeXml(
        summary.status
      )}</text>

      <text x="214" y="205" font-size="18" fill="#9d9daa">Guesses</text>
      <text x="214" y="250" font-size="46" font-weight="700" fill="#ffffff">${summary.guessCount}</text>

      <text x="386" y="205" font-size="18" fill="#9d9daa">Hints Used</text>
      <text x="386" y="250" font-size="46" font-weight="700" fill="#ffffff">${summary.hintCount}</text>

      <rect x="560" y="92" width="330" height="196" rx="22" fill="#101013" stroke="#303039" />

      <rect x="598" y="132" width="28" height="28" rx="8" fill="#14b87a" />
      <text x="646" y="153" font-size="24" font-weight="700" fill="#ffffff">${summary.greenCount}</text>
      <text x="690" y="153" font-size="18" fill="#9d9daa">Top 100</text>

      <rect x="598" y="178" width="28" height="28" rx="8" fill="#f57c2c" />
      <text x="646" y="199" font-size="24" font-weight="700" fill="#ffffff">${summary.yellowCount}</text>
      <text x="690" y="199" font-size="18" fill="#9d9daa">101-500</text>

      <rect x="598" y="224" width="28" height="28" rx="8" fill="#ff2f92" />
      <text x="646" y="245" font-size="24" font-weight="700" fill="#ffffff">${summary.redCount}</text>
      <text x="690" y="245" font-size="18" fill="#9d9daa">501+</text>
    </svg>
  `;
}

async function renderProgressCardBuffer({ player, puzzle, progress }) {
  const summary = summarizePlayerProgress(progress);
  const avatarDataUri = await getAvatarDataUri(player?.avatarUrl);
  const svg = buildProgressCardSvg({
    player,
    puzzle,
    summary,
    avatarDataUri,
  });

  return {
    summary,
    buffer: await sharp(Buffer.from(svg)).png().toBuffer(),
  };
}

function buildProgressMessageContent({ player, summary }) {
  return [
    `${player.displayName} • ${summary.status}`,
    `Guesses: ${summary.guessCount} • Hints: ${summary.hintCount}`,
    `🟩 ${summary.greenCount}  🟨 ${summary.yellowCount}  🟥 ${summary.redCount}`,
  ].join("\n");
}

async function loadProgressMessageRecord({ userId, puzzleId, channelId }) {
  if (!progressPool || !userId || !puzzleId || !channelId) {
    return null;
  }

  const result = await progressPool.query(
    `
      SELECT message_id
      FROM player_progress_messages
      WHERE user_id = $1 AND puzzle_id = $2 AND channel_id = $3
      LIMIT 1
    `,
    [userId, puzzleId, channelId]
  );

  return result.rows[0]?.message_id || null;
}

async function saveProgressMessageRecord({ userId, puzzleId, guildId, channelId, messageId }) {
  if (!progressPool || !userId || !puzzleId || !channelId || !messageId) {
    return;
  }

  await progressPool.query(
    `
      INSERT INTO player_progress_messages (
        user_id,
        puzzle_id,
        guild_id,
        channel_id,
        message_id
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, puzzle_id, channel_id)
      DO UPDATE SET
        guild_id = EXCLUDED.guild_id,
        message_id = EXCLUDED.message_id,
        updated_at = NOW()
    `,
    [userId, puzzleId, guildId || null, channelId, messageId]
  );
}

async function syncPlayerProgressCard({ player, puzzle, progress }) {
  try {
    if (!progressPool || !player?.userId || !player?.channelId || !client.isReady()) {
      return null;
    }

    const channel = await client.channels.fetch(player.channelId).catch(() => null);

    if (!channel || !channel.isTextBased()) {
      return null;
    }

    const normalizedProgress = progress || createEmptyProgressState();
    const { buffer, summary } = await renderProgressCardBuffer({
      player,
      puzzle,
      progress: normalizedProgress,
    });
    const attachment = new AttachmentBuilder(buffer, {
      name: `contexto-progress-${puzzle.id}-${player.userId}.png`,
    });
    const payload = {
      content: buildProgressMessageContent({ player, summary }),
      files: [attachment],
      components: createPlayMessageComponents(),
      allowedMentions: { parse: [] },
    };

    const existingMessageId = await loadProgressMessageRecord({
      userId: player.userId,
      puzzleId: puzzle.id,
      channelId: player.channelId,
    });

    if (existingMessageId) {
      const existingMessage = await channel.messages.fetch(existingMessageId).catch(() => null);

      if (existingMessage) {
        await existingMessage.edit({
          ...payload,
          attachments: [],
        });
        return existingMessage.id;
      }
    }

    const sentMessage = await channel.send(payload);
    await saveProgressMessageRecord({
      userId: player.userId,
      puzzleId: puzzle.id,
      guildId: player.guildId,
      channelId: player.channelId,
      messageId: sentMessage.id,
    });
    return sentMessage.id;
  } catch (error) {
    console.error("Failed to sync player progress card:", error);
    return null;
  }
}

async function exchangeDiscordCodeForAccessToken(code) {
  if (!DISCORD_CLIENT_SECRET) {
    throw new Error(
      "DISCORD_CLIENT_SECRET is required to authenticate Discord Activity users."
    );
  }

  if (!DISCORD_REDIRECT_URI) {
    throw new Error(
      "DISCORD_REDIRECT_URI is required to authenticate Discord Activity users."
    );
  }

  const response = await fetch(DISCORD_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: String(code || ""),
      redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });

  const payload = await response.json().catch(async () => ({
    error: await response.text(),
  }));

  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || "Token exchange failed.");
  }

  console.log("Discord token exchange succeeded.");

  return payload.access_token;
}

async function fetchDiscordOAuthUser(accessToken) {
  const response = await fetch(DISCORD_OAUTH_ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = await response.json().catch(async () => ({
    error: await response.text(),
  }));

  const oauthUser = payload?.user;

  if (!response.ok || !oauthUser?.id) {
    throw new Error(
      payload?.message || payload?.error || "Failed to load authenticated Discord user."
    );
  }

  return normalizePlayerContext({
    userId: oauthUser.id,
    displayName: oauthUser.global_name || oauthUser.username || "Discord Player",
    avatarUrl: oauthUser.avatar
      ? `https://cdn.discordapp.com/avatars/${oauthUser.id}/${oauthUser.avatar}.${oauthUser.avatar.startsWith("a_") ? "gif" : "png"}?size=128`
      : null,
  });
}

async function getAcceptedWords() {
  if (!acceptedWordsPromise) {
    acceptedWordsPromise = (async () => {
      const startedAt = Date.now();
      const rawPopularWords = popularWords.getMostPopular(1000000);
      const acceptedWords = new Set();
      const allowedAnswers = await getAllowedAnswers();
      let filteredPopularWordCount = 0;

      console.log(
        "Building in-memory valid-guess dictionary from the full popular-english-words list."
      );
      console.log(
        "This startup step is used only for guess validation so common real words are accepted and obvious gibberish is rejected without any API calls."
      );
      console.log(
        `Guess dictionary preload: scanning ${rawPopularWords.length} popular words, filtering by normalization, length, and stop-word rules, then adding ${allowedAnswers.size} ordered answer words from answers.json.`
      );

      for (const rawWord of rawPopularWords) {
        const normalizedWord = normalizeGuess(rawWord);

        if (
          normalizedWord &&
          normalizedWord.length >= 3 &&
          normalizedWord.length <= 16 &&
          !STOP_WORDS.has(normalizedWord)
        ) {
          filteredPopularWordCount += 1;
          acceptedWords.add(normalizedWord);
        }
      }

      for (const answer of allowedAnswers) {
        acceptedWords.add(answer);
      }

      const elapsedMs = Date.now() - startedAt;
      console.log(
        `Guess dictionary ready in ${elapsedMs}ms. Kept ${filteredPopularWordCount} filtered popular words and ${allowedAnswers.size} ordered answer words, resulting in ${acceptedWords.size} unique valid guess words cached in memory.`
      );
      return acceptedWords;
    })();
  }

  return acceptedWordsPromise;
}

function normalizeGuess(guess) {
  return String(guess || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function parseGuessInput(rawGuess) {
  const trimmedGuess = String(rawGuess || "").trim().toLowerCase();

  if (!trimmedGuess) {
    throw new Error("Type a word to make a guess.");
  }

  if (/\s/.test(trimmedGuess)) {
    throw new Error("One word only please.");
  }

  const normalizedGuess = normalizeGuess(trimmedGuess);

  if (!normalizedGuess) {
    throw new Error("That doesn't look like a valid word.");
  }

  if (STOP_WORDS.has(normalizedGuess)) {
    throw new Error("This word doesn't count, it's too common.");
  }

  return normalizedGuess;
}

function levenshteinDistance(left, right) {
  if (left === right) {
    return 0;
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    matrix[row][0] = row;
  }

  for (let col = 0; col < cols; col += 1) {
    matrix[0][col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

function longestSharedPrefixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let count = 0;

  while (count < max && left[count] === right[count]) {
    count += 1;
  }

  return count;
}

function longestSharedSuffixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let count = 0;

  while (
    count < max &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }

  return count;
}

function buildTrigrams(word) {
  if (word.length < 3) {
    return new Set([word]);
  }

  const trigrams = new Set();

  for (let index = 0; index <= word.length - 3; index += 1) {
    trigrams.add(word.slice(index, index + 3));
  }

  return trigrams;
}

function trigramJaccard(left, right) {
  const leftTrigrams = buildTrigrams(left);
  const rightTrigrams = buildTrigrams(right);
  let intersection = 0;

  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftTrigrams, ...rightTrigrams]).size || 1;
  return intersection / union;
}

function normalizeFamilyStem(word) {
  const suffixReplacements = [
    ["ations", ""],
    ["ation", ""],
    ["ments", ""],
    ["ment", ""],
    ["ities", "ity"],
    ["ingly", ""],
    ["edly", ""],
    ["ances", ""],
    ["ance", ""],
    ["ships", ""],
    ["ship", ""],
    ["ness", ""],
    ["less", ""],
    ["able", ""],
    ["ible", ""],
    ["ally", ""],
    ["ing", ""],
    ["ers", ""],
    ["ies", "y"],
    ["ied", "y"],
    ["est", ""],
    ["er", ""],
    ["ed", ""],
    ["ly", ""],
    ["es", ""],
    ["s", ""],
  ];

  let stem = word;

  for (const [suffix, replacement] of suffixReplacements) {
    if (stem.endsWith(suffix) && stem.length - suffix.length + replacement.length >= 4) {
      stem = stem.slice(0, -suffix.length) + replacement;
      break;
    }
  }

  return stem;
}

function isLikelyLexicalFamily(left, right) {
  if (left === right) {
    return true;
  }

  const minLength = Math.min(left.length, right.length);
  const prefixLength = longestSharedPrefixLength(left, right);
  const leftStem = normalizeFamilyStem(left);
  const rightStem = normalizeFamilyStem(right);

  if (leftStem.length >= 4 && leftStem === rightStem) {
    return true;
  }

  if (
    minLength >= 4 &&
    (left.startsWith(right) || right.startsWith(left)) &&
    prefixLength >= minLength
  ) {
    return true;
  }

  return (
    minLength >= 5 &&
    prefixLength >= minLength - 1 &&
    trigramJaccard(left, right) >= 0.55
  );
}

function getDisplayTopWords(rankedWords, limit = 100) {
  const topWords = [];

  for (const entry of rankedWords) {
    const isDuplicateFamily = topWords.some((existingEntry) =>
      isLikelyLexicalFamily(existingEntry.word, entry.word)
    );

    if (isDuplicateFamily) {
      continue;
    }

    topWords.push(entry);

    if (topWords.length >= limit) {
      break;
    }
  }

  return topWords.map((entry, index) => ({
    rank: index + 1,
    word: entry.word,
  }));
}

function ensureEmbeddingsClient() {
  if (!openai) {
    throw new Error(
      "OPENAI_API_KEY is missing. Add it to your environment to enable semantic guess scoring."
    );
  }
}

function dotProduct(vectorA, vectorB) {
  let total = 0;

  for (let index = 0; index < vectorA.length; index += 1) {
    total += vectorA[index] * vectorB[index];
  }

  return total;
}

function findRankFromSortedScores(sortedScores, score) {
  let low = 0;
  let high = sortedScores.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (score >= sortedScores[middle]) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low + 1;
}

async function buildRankingVocabulary() {
  const filteredWords = popularWords.getMostPopularFilter(RANKING_VOCAB_SIZE, (word) => {
    const normalizedWord = normalizeGuess(word);

    return (
      normalizedWord &&
      normalizedWord.length >= 3 &&
      normalizedWord.length <= 16 &&
      !STOP_WORDS.has(normalizedWord)
    );
  });

  return [...new Set(filteredWords)];
}

async function getAllowedAnswers() {
  if (!allowedAnswersPromise) {
    allowedAnswersPromise = (async () => {
      let parsedAnswers;

      try {
        const rawAnswers = await fs.readFile(answersFilePath, "utf8");
        const parsed = JSON.parse(rawAnswers);
        parsedAnswers = Array.isArray(parsed) ? parsed : parsed.words;
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new Error(
            "Missing answer list. Add data/generated/answers.json with your ordered puzzle answers."
          );
        }

        throw error;
      }

      if (!Array.isArray(parsedAnswers) || parsedAnswers.length === 0) {
        throw new Error(
          "Answer list is empty or invalid. Check data/generated/answers.json."
        );
      }

      return new Set(parsedAnswers.map((word) => normalizeGuess(word)).filter(Boolean));
    })();
  }

  return allowedAnswersPromise;
}

function validatePuzzleAnswer(answer, allowedAnswers) {
  if (!allowedAnswers.has(answer)) {
    throw new Error(
      `Puzzle answer "${answer}" is not in data/generated/answers.json. Choose an answer from your ordered answer list.`
    );
  }
}

function computeLexicalPenalty(answer, candidate, semanticScore) {
  if (answer === candidate) {
    return 0;
  }

  const maxLength = Math.max(answer.length, candidate.length, 1);
  const minLength = Math.max(1, Math.min(answer.length, candidate.length));
  const editDistance = levenshteinDistance(answer, candidate);
  const prefixLength = longestSharedPrefixLength(answer, candidate);
  const suffixLength = longestSharedSuffixLength(answer, candidate);
  const prefixRatio = prefixLength / maxLength;
  const suffixRatio = suffixLength / maxLength;
  const stemPrefixRatio = prefixLength / minLength;
  const trigramOverlap = trigramJaccard(answer, candidate);
  const containsOther = answer.includes(candidate) || candidate.includes(answer);
  const startsWithOther = answer.startsWith(candidate) || candidate.startsWith(answer);
  const sameFamily = isLikelyLexicalFamily(answer, candidate);
  const shortAnswerFactor =
    answer.length <= 4 ? 1.35 : answer.length === 5 ? 1.22 : answer.length <= 7 ? 1.1 : 1;

  let penalty = 0;

  penalty += 0.15 * trigramOverlap;
  penalty += 0.11 * prefixRatio;
  penalty += 0.06 * suffixRatio;

  if (containsOther) {
    penalty += 0.1 * shortAnswerFactor;
  }

  if (startsWithOther && minLength >= 4) {
    penalty += 0.09 * shortAnswerFactor;
  }

  if (stemPrefixRatio >= 0.8 && minLength >= 4) {
    penalty += 0.07 * shortAnswerFactor;
  }

  if (sameFamily) {
    penalty += 0.06 * shortAnswerFactor;
  }

  if (editDistance <= 1) {
    penalty += 0.16 * shortAnswerFactor;
  } else if (editDistance === 2) {
    penalty += 0.08 * shortAnswerFactor;
  }

  if (candidate.length <= 3) {
    penalty += 0.03;
  }

  // Let truly strong semantic neighbors retain more of their score.
  if (semanticScore >= 0.68) {
    penalty *= 0.72;
  } else if (semanticScore >= 0.55) {
    penalty *= 0.86;
  }

  return Math.min(penalty, 0.32);
}

function computeAdjustedScore(answer, candidate, semanticScore) {
  return semanticScore - computeLexicalPenalty(answer, candidate, semanticScore);
}

function normalizeVector(vector) {
  let magnitude = 0;

  for (const value of vector) {
    magnitude += value * value;
  }

  const divisor = Math.sqrt(magnitude) || 1;
  return vector.map((value) => value / divisor);
}

async function embedTexts(texts) {
  ensureEmbeddingsClient();

  const response = await openai.embeddings.create({
    model: OPENAI_EMBEDDING_MODEL,
    input: texts,
    encoding_format: "float",
  });

  return response.data.map((item) => normalizeVector(item.embedding));
}

function hydrateSemanticCache(cache) {
  return {
    ...cache,
    rankByWord: new Map(
      cache.rankedWords.map((entry, index) => [entry.word, index + 1])
    ),
    cachedGuessScoresMap: new Map(
      Object.entries(cache.cachedGuessScores || {}).map(([word, value]) => [
        word,
        value,
      ])
    ),
  };
}

async function persistSemanticCache(semantic) {
  await fs.mkdir(generatedDataDirectory, { recursive: true });
  await fs.writeFile(
    semanticCacheFilePath,
    JSON.stringify(
      {
        provider: semantic.provider,
        modelId: semantic.modelId,
        scoringVersion: semantic.scoringVersion,
        puzzleId: semantic.puzzleId,
        answer: semantic.answer,
        answerEmbedding: semantic.answerEmbedding,
        vocabularySize: semantic.vocabularySize,
        rankedWords: semantic.rankedWords,
        sortedScores: semantic.sortedScores,
        cachedGuessScores: Object.fromEntries(semantic.cachedGuessScoresMap),
      },
      null,
      2
    ),
    "utf8"
  );
}

async function generateSemanticCache(puzzle) {
  console.log(
    `Generating API-backed semantic cache for "${puzzle.answer}" using ${RANKING_VOCAB_SIZE} words...`
  );

  const answerEmbedding = (await embedTexts([puzzle.answer]))[0];
  const [allowedAnswers, vocabulary] = await Promise.all([
    getAllowedAnswers(),
    buildRankingVocabulary(),
  ]);
  validatePuzzleAnswer(puzzle.answer, allowedAnswers);
  const rankedWords = [];
  const startedAt = Date.now();
  const totalBatches = Math.ceil(vocabulary.length / EMBEDDING_BATCH_SIZE);

  console.log(
    `Semantic cache build started: ${vocabulary.length} candidate words across ${totalBatches} batches of up to ${EMBEDDING_BATCH_SIZE}.`
  );

  for (let index = 0; index < vocabulary.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = vocabulary.slice(index, index + EMBEDDING_BATCH_SIZE);
    const embeddings = await embedTexts(batch);
    const batchNumber = Math.floor(index / EMBEDDING_BATCH_SIZE) + 1;

    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const semanticScore = dotProduct(answerEmbedding, embeddings[batchIndex]);
      rankedWords.push({
        word: batch[batchIndex],
        semanticScore,
        score: computeAdjustedScore(
          puzzle.answer,
          batch[batchIndex],
          semanticScore
        ),
      });
    }

    const shouldLogProgress =
      batchNumber === 1 ||
      batchNumber === totalBatches ||
      batchNumber % 10 === 0;

    if (shouldLogProgress) {
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const percentComplete = ((batchNumber / totalBatches) * 100).toFixed(1);
      console.log(
        `Semantic cache progress for "${puzzle.answer}": batch ${batchNumber}/${totalBatches} (${percentComplete}%), ${rankedWords.length} words processed, ${elapsedSeconds}s elapsed.`
      );
    }
  }

  rankedWords.sort((left, right) => right.score - left.score);

  const cache = {
    provider: "openai",
    modelId: OPENAI_EMBEDDING_MODEL,
    scoringVersion: SCORING_VERSION,
    puzzleId: puzzle.id,
    answer: puzzle.answer,
    answerEmbedding,
    vocabularySize: vocabulary.length,
    rankedWords,
    sortedScores: rankedWords.map((entry) => entry.score),
    cachedGuessScores: {},
  };

  const hydratedCache = hydrateSemanticCache(cache);
  await persistSemanticCache(hydratedCache);

  const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `Semantic ranking cache generated for "${puzzle.answer}" in ${totalSeconds}s.`
  );
  return hydratedCache;
}

async function getSemanticPuzzle() {
  if (!semanticPuzzlePromise) {
    semanticPuzzlePromise = (async () => {
      const puzzle = await loadPuzzle();
      const [allowedAnswers, vocabulary] = await Promise.all([
        getAllowedAnswers(),
        buildRankingVocabulary(),
      ]);
      validatePuzzleAnswer(puzzle.answer, allowedAnswers);

      try {
        const rawCache = await fs.readFile(semanticCacheFilePath, "utf8");
        const parsedCache = JSON.parse(rawCache);

        if (
          parsedCache.provider === "openai" &&
          parsedCache.modelId === OPENAI_EMBEDDING_MODEL &&
          parsedCache.scoringVersion === SCORING_VERSION &&
          parsedCache.puzzleId === puzzle.id &&
          parsedCache.answer === puzzle.answer &&
          parsedCache.vocabularySize === vocabulary.length
        ) {
          return {
            puzzle,
            semantic: hydrateSemanticCache(parsedCache),
          };
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn("Falling back to regenerating semantic cache:", error);
        }
      }

      const semantic = await generateSemanticCache(puzzle);

      return {
        puzzle,
        semantic,
      };
    })();
  }

  return semanticPuzzlePromise;
}

async function scoreGuess(guess) {
  const normalizedGuess = parseGuessInput(guess);
  const acceptedWords = await getAcceptedWords();

  if (!acceptedWords.has(normalizedGuess)) {
    throw new Error("I don't recognize that word.");
  }

  const { puzzle, semantic } = await getSemanticPuzzle();

  const cachedGuess = guessScoreCache.get(normalizedGuess);
  if (cachedGuess) {
    return cachedGuess;
  }

  let rank = semantic.rankByWord.get(normalizedGuess);
  let score;

  if (rank) {
    score = semantic.sortedScores[rank - 1];
  } else if (semantic.cachedGuessScoresMap.has(normalizedGuess)) {
    const cachedSemanticScore = semantic.cachedGuessScoresMap.get(normalizedGuess);
    rank = cachedSemanticScore.rank;
    score = cachedSemanticScore.score;
  } else {
    const [guessEmbedding] = await embedTexts([normalizedGuess]);
    const semanticScore = dotProduct(semantic.answerEmbedding, guessEmbedding);
    score = computeAdjustedScore(puzzle.answer, normalizedGuess, semanticScore);
    rank = findRankFromSortedScores(semantic.sortedScores, score);

    semantic.cachedGuessScoresMap.set(normalizedGuess, {
      rank,
      score,
      semanticScore,
    });
    await persistSemanticCache(semantic);
  }

  const result = {
    guess: normalizedGuess,
    rank,
    score,
    solved: normalizedGuess === puzzle.answer,
    answer: normalizedGuess === puzzle.answer ? puzzle.answer : null,
  };

  guessScoreCache.set(normalizedGuess, result);
  return result;
}

function getHintStartRank(bestRank) {
  if (!Number.isFinite(bestRank) || bestRank <= 0) {
    return 100;
  }

  return Math.max(2, Math.floor(bestRank / 2));
}

async function getHintGuess({ guessedWords = [], bestRank }) {
  const normalizedGuessedWords = new Set(
    (Array.isArray(guessedWords) ? guessedWords : [])
      .map((word) => normalizeGuess(word))
      .filter(Boolean)
  );
  const { puzzle, semantic } = await getSemanticPuzzle();
  const startRank = getHintStartRank(bestRank);

  const findCandidate = (fromIndex, toIndexExclusive) => {
    for (let index = fromIndex; index < toIndexExclusive; index += 1) {
      const entry = semantic.rankedWords[index];

      if (!entry) {
        continue;
      }

      if (entry.word === puzzle.answer || normalizedGuessedWords.has(entry.word)) {
        continue;
      }

      return {
        guess: entry.word,
        rank: index + 1,
        score: entry.score,
        solved: false,
        answer: null,
        hint: true,
      };
    }

    return null;
  };

  const primaryCandidate = findCandidate(
    Math.max(1, startRank - 1),
    semantic.rankedWords.length
  );

  if (primaryCandidate) {
    return primaryCandidate;
  }

  const fallbackCandidate = findCandidate(1, Math.max(1, startRank - 1));

  if (fallbackCandidate) {
    return fallbackCandidate;
  }

  throw new Error("No hint available.");
}

function createPlayMessageComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(PLAY_BUTTON_ID)
        .setLabel("Play Contexto")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

async function refreshPlayPromptMessage(message) {
  await message.edit({
    content: message.content,
    components: createPlayMessageComponents(),
  });
}

async function sendPlayPrompt({ channelId }) {
  const targetChannelId = channelId || DEFAULT_CHANNEL_ID;

  if (!targetChannelId) {
    throw new Error(
      "No channel ID provided. Set DEFAULT_CHANNEL_ID or pass channelId in the command."
    );
  }

  const channel = await client.channels.fetch(targetChannelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error("Target channel is missing or is not a text channel.");
  }

  await channel.send({
    content: "Today's Contexto is ready.\nClick below to launch the game.",
    components: createPlayMessageComponents(),
  });

  return targetChannelId;
}

async function replyEphemeral(interaction, content) {
  const payload = {
    content,
    flags: MessageFlags.Ephemeral,
  };

  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(payload);
  }

  return interaction.reply(payload);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    botReady: client.isReady(),
    defaultChannelId: DEFAULT_CHANNEL_ID || null,
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    clientId: DISCORD_CLIENT_ID,
    redirectUri: DISCORD_REDIRECT_URI || null,
    progressEnabled: isProgressPersistenceEnabled(),
    discordAuthEnabled: Boolean(DISCORD_CLIENT_SECRET),
  });
});

app.post("/api/client-log", (req, res) => {
  const level = String(req.body?.level || "info").toLowerCase();
  const message = String(req.body?.message || "Client log");
  const extra = req.body?.extra;
  const payload = extra ? { extra } : undefined;

  if (level === "error") {
    console.error(`[client] ${message}`, payload);
  } else if (level === "warn") {
    console.warn(`[client] ${message}`, payload);
  } else {
    console.log(`[client] ${message}`, payload);
  }

  res.json({ ok: true });
});

app.post("/api/discord/login", async (req, res) => {
  try {
    console.log("Received Discord login request.");
    const accessToken = await exchangeDiscordCodeForAccessToken(req.body?.code);
    const discordPlayer = await fetchDiscordOAuthUser(accessToken);

    if (!discordPlayer) {
      throw new Error("Discord login succeeded, but no user identity was returned.");
    }

    const session = await createAppSession(
      overlaySessionContext(discordPlayer, req.body)
    );

    if (!session) {
      throw new Error("App session storage is unavailable.");
    }

    res.json({
      ok: true,
      player: overlaySessionContext(discordPlayer, req.body),
      sessionToken: session.sessionToken,
      sessionExpiresAt: session.expiresAt,
    });
  } catch (error) {
    console.error("Failed to log in Discord user:", error);
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Discord login failed.",
    });
  }
});

app.post("/api/session", async (req, res) => {
  try {
    const player = await loadPlayerFromSession(req.body?.sessionToken, req.body);

    if (!player) {
      res.status(401).json({
        ok: false,
        error: "Session expired. Please reopen the activity.",
      });
      return;
    }

    res.json({
      ok: true,
      player,
    });
  } catch (error) {
    console.error("Failed to restore app session:", error);
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Failed to restore session.",
    });
  }
});

app.get("/api/puzzle", async (_req, res) => {
  try {
    const puzzle = await loadPuzzle();

    res.json({
      ok: true,
      puzzle: {
        id: puzzle.id,
        date: puzzle.date,
        answerLength: puzzle.answer.length,
        totalRankedWords: RANKING_VOCAB_SIZE,
      },
    });
  } catch (error) {
    console.error("Failed to load puzzle:", error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Failed to load puzzle.",
    });
  }
});

app.post("/api/progress", async (req, res) => {
  try {
    const player = await resolvePlayerContext(req.body);
    const puzzle = await loadPuzzle();
    console.log("Loading player progress.", {
      hasPlayer: Boolean(player),
      userId: player?.userId || null,
      puzzleId: puzzle.id,
    });
    const progress = await loadPlayerProgress(player, puzzle.id);

    if (player) {
      await syncPlayerProgressCard({
        player,
        puzzle,
        progress: progress || createEmptyProgressState(),
      });
    }

    res.json({
      ok: true,
      progress,
    });
  } catch (error) {
    console.error("Failed to load player progress:", error);
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Failed to load progress.",
    });
  }
});

app.get("/api/top-words", async (_req, res) => {
  try {
    const { semantic } = await getSemanticPuzzle();
    const topWords = getDisplayTopWords(semantic.rankedWords, 100);

    res.json({
      ok: true,
      topWords,
    });
  } catch (error) {
    console.error("Failed to load top words:", error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Failed to load top words.",
    });
  }
});

app.post("/api/hint", async (req, res) => {
  try {
    const player = await resolvePlayerContext(req.body);
    const puzzle = await loadPuzzle();
    console.log("Hint request received.", {
      hasPlayer: Boolean(player),
      userId: player?.userId || null,
      puzzleId: puzzle.id,
    });
    const progress = await loadPlayerProgress(player, puzzle.id);
    const alreadyFinished = Boolean(progress?.solvedAnswer);
    const result = await getHintGuess({
      guessedWords: progress?.guesses?.length
        ? progress.guesses.map((entry) => entry.guess)
        : req.body?.guessedWords,
      bestRank: progress?.bestRank ?? Number(req.body?.bestRank),
    });
    const countsTowardScore = !alreadyFinished;
    const nextProgress = {
      ...(progress || createEmptyProgressState()),
      guesses: progress?.guesses || [],
    };

    if (player) {
      const guesses = [
        {
          guess: result.guess,
          rank: result.rank,
          solved: false,
          hinted: true,
          revealed: false,
          countsTowardScore,
        },
        ...(progress?.guesses || []),
      ];
      nextProgress.guesses = guesses;
      nextProgress.solvedAnswer = progress?.solvedAnswer ?? null;
      nextProgress.gaveUp = Boolean(progress?.gaveUp);
      nextProgress.resultPosted = Boolean(progress?.resultPosted);
      nextProgress.guessCount = countScoredGuesses(guesses);
      nextProgress.hintCount = guesses.filter(
        (entry) => entry.hinted && entry.countsTowardScore !== false
      ).length;
      nextProgress.bestRank = getBestRankFromGuesses(guesses);

      await savePlayerProgress({
        player,
        puzzleId: puzzle.id,
        guesses,
        solvedAnswer: progress?.solvedAnswer ?? null,
        gaveUp: Boolean(progress?.gaveUp),
        resultPosted: Boolean(progress?.resultPosted),
      });

      await syncPlayerProgressCard({
        player,
        puzzle,
        progress: nextProgress,
      });
    }

    res.json({
      ok: true,
      ...result,
      countsTowardScore,
    });
  } catch (error) {
    console.error("Failed to load hint:", error);
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/guess", async (req, res) => {
  try {
    const player = await resolvePlayerContext(req.body);
    const puzzle = await loadPuzzle();
    console.log("Guess request received.", {
      hasPlayer: Boolean(player),
      userId: player?.userId || null,
      puzzleId: puzzle.id,
      guess: normalizeGuess(req.body?.guess),
    });
    const progress = await loadPlayerProgress(player, puzzle.id);
    const normalizedGuess = normalizeGuess(req.body?.guess);

    if (
      normalizedGuess &&
      progress?.guesses?.some((entry) => entry.guess === normalizedGuess)
    ) {
      throw new Error("You've already guessed that word. Try a new one.");
    }

    const alreadyFinished = Boolean(progress?.solvedAnswer);
    const result = await scoreGuess(req.body?.guess);
    const countsTowardScore = !alreadyFinished;
    const freshSolve = result.solved && !alreadyFinished;
    const nextProgress = {
      ...(progress || createEmptyProgressState()),
      guesses: progress?.guesses || [],
    };

    if (player) {
      const guesses = [
        {
          guess: result.guess,
          rank: result.rank,
          solved: result.solved,
          hinted: false,
          revealed: false,
          countsTowardScore,
        },
        ...(progress?.guesses || []),
      ];
      const nextSolvedAnswer = freshSolve
        ? result.answer
        : progress?.solvedAnswer ?? (result.solved ? result.answer : null);
      nextProgress.guesses = guesses;
      nextProgress.solvedAnswer = nextSolvedAnswer;
      nextProgress.gaveUp = Boolean(progress?.gaveUp);
      nextProgress.resultPosted = Boolean(progress?.resultPosted);
      nextProgress.guessCount = countScoredGuesses(guesses);
      nextProgress.hintCount = guesses.filter(
        (entry) => entry.hinted && entry.countsTowardScore !== false
      ).length;
      nextProgress.bestRank = getBestRankFromGuesses(guesses);

      await savePlayerProgress({
        player,
        puzzleId: puzzle.id,
        guesses,
        solvedAnswer: nextSolvedAnswer,
        gaveUp: Boolean(progress?.gaveUp),
        resultPosted: Boolean(progress?.resultPosted),
      });

      await syncPlayerProgressCard({
        player,
        puzzle,
        progress: nextProgress,
      });
    }

    res.json({
      ok: true,
      ...result,
      countsTowardScore,
      freshSolve,
    });
  } catch (error) {
    console.error("Failed to score guess:", error);
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/give-up", async (_req, res) => {
  try {
    const player = await resolvePlayerContext(_req.body);
    const { puzzle } = await getSemanticPuzzle();
    console.log("Give-up request received.", {
      hasPlayer: Boolean(player),
      userId: player?.userId || null,
      puzzleId: puzzle.id,
    });
    const progress = await loadPlayerProgress(player, puzzle.id);

    if (player) {
      const alreadyHasAnswer =
        progress?.guesses?.some((entry) => entry.guess === puzzle.answer) || false;
      const guesses = alreadyHasAnswer
        ? progress?.guesses || []
        : [
            {
              guess: puzzle.answer,
              rank: 1,
              solved: true,
              hinted: false,
              revealed: true,
              countsTowardScore: false,
            },
            ...(progress?.guesses || []),
          ];
      const nextProgress = {
        ...(progress || createEmptyProgressState()),
        guesses,
        solvedAnswer: puzzle.answer,
        gaveUp: true,
        resultPosted: Boolean(progress?.resultPosted),
        guessCount: countScoredGuesses(guesses),
        hintCount: guesses.filter(
          (entry) => entry.hinted && entry.countsTowardScore !== false
        ).length,
        bestRank: getBestRankFromGuesses(guesses),
      };

      await savePlayerProgress({
        player,
        puzzleId: puzzle.id,
        guesses,
        solvedAnswer: puzzle.answer,
        gaveUp: true,
        resultPosted: Boolean(progress?.resultPosted),
      });

      await syncPlayerProgressCard({
        player,
        puzzle,
        progress: nextProgress,
      });
    }

    res.json({
      ok: true,
      answer: puzzle.answer,
    });
  } catch (error) {
    console.error("Failed to reveal answer:", error);
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Bot logged in as ${readyClient.user.tag}`);

  try {
    await registerGuildCommands();
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId !== PLAY_BUTTON_ID) {
      return;
    }

    try {
      await interaction.launchActivity();

      // Re-send the same button component so Discord clears
      // any stale client-side loading state on the original message.
      await refreshPlayPromptMessage(interaction.message);
    } catch (error) {
      console.error("Failed to launch activity from button:", error);

      try {
        await replyEphemeral(
          interaction,
          error instanceof Error
            ? error.message
            : "Failed to launch the Contexto activity."
        );
      } catch (replyError) {
        console.error("Failed to send button error reply:", replyError);
      }
    }

    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    if (interaction.commandName === "contexto-post") {
      const selectedChannel = interaction.options.getChannel("channel");
      const targetChannelId = await sendPlayPrompt({
        channelId: selectedChannel?.id || interaction.channelId,
      });

      await interaction.reply({
        content: `Posted a Contexto play prompt in <#${targetChannelId}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    console.error("Interaction failed:", error);

    try {
      await replyEphemeral(
        interaction,
        error instanceof Error ? error.message : "Interaction failed."
      );
    } catch (replyError) {
      console.error("Failed to send interaction error reply:", replyError);
    }
  }
});

let server;

(async () => {
  await ensureProgressStorage();

  server = app.listen(Number(PORT), () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });

  await client.login(DISCORD_BOT_TOKEN);
})().catch((error) => {
  console.error("Startup failed:", error);

  if (server) {
    server.close();
  }

  process.exit(1);
});
