import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";
import { Resvg } from "@resvg/resvg-js";
import React from "react";
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
import satori from "satori";

dotenv.config();

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_GUILD_ID,
  DEFAULT_CHANNEL_ID,
  LEADERBOARD_CHANNEL_ID,
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
const answersFilePath = path.join(projectRoot, "data", "generated", "answers.json");
const progressCardFontRegularPath = path.join(
  projectRoot,
  "node_modules",
  "@fontsource",
  "inter",
  "files",
  "inter-latin-400-normal.woff"
);
const progressCardFontBoldPath = path.join(
  projectRoot,
  "node_modules",
  "@fontsource",
  "inter",
  "files",
  "inter-latin-700-normal.woff"
);
const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const RANKING_VOCAB_SIZE = Number(process.env.RANKING_VOCAB_SIZE || "50000");
const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || "128");
const SCORING_VERSION = "lexical-penalty-v2-family-dedupe-v1-popular-words-v1";
const APP_SESSION_TTL_DAYS = 30;
const LEADERBOARD_ENTRY_LIMIT = 10;
const DISCORD_OAUTH_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_OAUTH_ME_URL = "https://discord.com/api/oauth2/@me";
const CONTEXTO_EPOCH_DATE = "2026-03-25";
const PUZZLE_TIMEZONE = "America/Los_Angeles";
const PRECOMPUTE_TRIGGER_TOKEN = process.env.PRECOMPUTE_TRIGGER_TOKEN || "";
const LEADERBOARD_TRIGGER_TOKEN =
  process.env.LEADERBOARD_TRIGGER_TOKEN || PRECOMPUTE_TRIGGER_TOKEN || "";
const PUZZLE_DATE_OVERRIDE = String(process.env.PUZZLE_DATE_OVERRIDE || "").trim() || null;
const PUZZLE_ANSWER_OVERRIDE = String(process.env.PUZZLE_ANSWER_OVERRIDE || "").trim() || null;

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
let progressCardFontsPromise;
const semanticPuzzlePromises = new Map();
const backgroundPrecomputePromises = new Map();
let orderedAnswersPromise;
let acceptedWordsPromise;
let allowedAnswersPromise;
let rankingVocabularyPromise;
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
  new SlashCommandBuilder()
    .setName("contexto-leaderboard")
    .setDescription("Render the Contexto leaderboard for a puzzle day.")
    .addStringOption((option) =>
      option
        .setName("date")
        .setDescription("Puzzle date in YYYY-MM-DD. Defaults to yesterday in Los Angeles.")
        .setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("contexto-leaderboard-today")
    .setDescription("Render the Contexto leaderboard for today's puzzle.")
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

function getDatePartsInTimeZone(date = new Date(), timeZone = PUZZLE_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function getCurrentPuzzleDateId(date = new Date()) {
  const parts = getDatePartsInTimeZone(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatPuzzleDate(dateId) {
  const [year, month, day] = String(dateId || "").split("-");

  if (!year || !month || !day) {
    throw new Error(`Invalid puzzle date: "${dateId}"`);
  }

  return `${month}/${day}/${year}`;
}

function formatDateIdFromUtcDate(date) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getPuzzleSequenceNumber(dateId) {
  const epoch = new Date(`${CONTEXTO_EPOCH_DATE}T00:00:00Z`);
  const current = new Date(`${dateId}T00:00:00Z`);

  if (Number.isNaN(epoch.getTime()) || Number.isNaN(current.getTime())) {
    throw new Error(`Invalid puzzle date: "${dateId}"`);
  }

  return Math.round((current.getTime() - epoch.getTime()) / 86400000) + 1;
}

function shiftPuzzleDateId(dateId, dayOffset) {
  const baseDate = new Date(`${dateId}T12:00:00Z`);

  if (Number.isNaN(baseDate.getTime())) {
    throw new Error(`Invalid puzzle date: "${dateId}"`);
  }

  baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);
  return formatDateIdFromUtcDate(baseDate);
}

function normalizePuzzleDateOverride(dateId) {
  const trimmed = String(dateId || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

async function loadPuzzleForDateId(puzzleDateId) {
  const normalizedDateId = normalizePuzzleDateOverride(puzzleDateId);

  if (!normalizedDateId) {
    throw new Error(`Invalid puzzle date: "${puzzleDateId}"`);
  }

  const orderedAnswers = await getOrderedAnswers();
  const contextoNumber = getPuzzleSequenceNumber(normalizedDateId);
  const answerIndex =
    ((contextoNumber - 1) % orderedAnswers.length + orderedAnswers.length) % orderedAnswers.length;
  const answer = normalizeGuess(PUZZLE_ANSWER_OVERRIDE) || orderedAnswers[answerIndex];

  return {
    id: normalizedDateId,
    date: formatPuzzleDate(normalizedDateId),
    answer,
    contextoNumber,
  };
}

async function getOrderedAnswers() {
  if (!orderedAnswersPromise) {
    orderedAnswersPromise = (async () => {
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

      const orderedAnswers = parsedAnswers.map((word) => normalizeGuess(word)).filter(Boolean);

      if (orderedAnswers.length === 0) {
        throw new Error(
          "Answer list is empty after normalization. Check data/generated/answers.json."
        );
      }

      return orderedAnswers;
    })();
  }

  return orderedAnswersPromise;
}

async function loadPuzzle() {
  const puzzleDateId = normalizePuzzleDateOverride(PUZZLE_DATE_OVERRIDE) || getCurrentPuzzleDateId();
  return loadPuzzleForDateId(puzzleDateId);
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
        CREATE INDEX IF NOT EXISTS player_progress_puzzle_id_guild_id_idx
        ON player_progress (puzzle_id, guild_id)
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
        CREATE TABLE IF NOT EXISTS leaderboard_messages (
          puzzle_id TEXT NOT NULL,
          guild_id TEXT,
          channel_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (puzzle_id, channel_id)
        )
      `);
      await progressPool.query(`
        CREATE TABLE IF NOT EXISTS daily_puzzle_cache (
          puzzle_id TEXT PRIMARY KEY,
          puzzle_date TEXT NOT NULL,
          answer TEXT NOT NULL,
          provider TEXT NOT NULL,
          model_id TEXT NOT NULL,
          scoring_version TEXT NOT NULL,
          vocabulary_size INTEGER NOT NULL,
          cache_json JSONB NOT NULL,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

async function ensureStarterRevealProgress({ player, puzzleId, progress }) {
  const baseProgress = progress || createEmptyProgressState();
  const guesses = normalizeStoredGuesses(baseProgress.guesses);
  const starterReveal = await getStarterRevealGuess(guesses);

  if (!starterReveal) {
    return {
      progress: {
        ...baseProgress,
        guesses,
        guessCount: countScoredGuesses(guesses),
        hintCount: guesses.filter((entry) => entry.hinted).length,
        bestRank: getBestRankFromGuesses(guesses),
      },
      starterRevealAdded: false,
      starterReveal: null,
    };
  }

  const nextGuesses = [starterReveal, ...guesses];
  const nextProgress = {
    ...baseProgress,
    guesses: nextGuesses,
    guessCount: countScoredGuesses(nextGuesses),
    hintCount: nextGuesses.filter((entry) => entry.hinted).length,
    bestRank: getBestRankFromGuesses(nextGuesses),
  };

  if (player) {
    await savePlayerProgress({
      player,
      puzzleId,
      guesses: nextGuesses,
      solvedAnswer: baseProgress.solvedAnswer,
      gaveUp: baseProgress.gaveUp,
      resultPosted: baseProgress.resultPosted,
    });
  }

  return {
    progress: nextProgress,
    starterRevealAdded: true,
    starterReveal,
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

function getContextoNumber(puzzle) {
  if (Number.isFinite(Number(puzzle?.contextoNumber))) {
    return Number(puzzle.contextoNumber);
  }

  const puzzleId = normalizeOptionalText(puzzle?.id, 40);

  if (!puzzleId) {
    return null;
  }

  const epoch = new Date(`${CONTEXTO_EPOCH_DATE}T00:00:00Z`);
  const current = new Date(`${puzzleId}T00:00:00Z`);

  if (Number.isNaN(epoch.getTime()) || Number.isNaN(current.getTime())) {
    return null;
  }

  const dayOffset = Math.round((current.getTime() - epoch.getTime()) / 86400000);
  return dayOffset + 1;
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

function getLeaderboardScore(summary) {
  return summary.guessCount + Math.max(0, summary.hintCount - 1) * 4;
}

function getLeaderboardStatusPriority(status) {
  if (status === "Solved") {
    return 0;
  }

  if (status === "Attempted") {
    return 1;
  }

  return 2;
}

async function loadLeaderboardEntries({ puzzleId, guildId, limit = null }) {
  if (!progressPool) {
    throw new Error("Leaderboard requires DATABASE_URL to be configured.");
  }

  await ensureProgressStorage();

  const params = [puzzleId];
  const guildFilter = guildId ? "AND guild_id = $2" : "";

  if (guildId) {
    params.push(guildId);
  }

  const result = await progressPool.query(
    `
      SELECT
        user_id,
        guild_id,
        channel_id,
        display_name,
        avatar_url,
        guesses_json,
        solved_answer,
        gave_up,
        started_at,
        finished_at
      FROM player_progress
      WHERE puzzle_id = $1
      ${guildFilter}
    `,
    params
  );

  const entries = result.rows
    .map((row) => {
      const progress = {
        guesses: normalizeStoredGuesses(row.guesses_json),
        solvedAnswer: normalizeOptionalText(row.solved_answer, 120),
        gaveUp: Boolean(row.gave_up),
      };
      const summary = summarizePlayerProgress(progress);

      return {
        player: {
          userId: normalizeOptionalText(row.user_id, 80),
          displayName: normalizeOptionalText(row.display_name, 120) || "Player",
          avatarUrl: normalizeOptionalText(row.avatar_url, 500),
          guildId: normalizeOptionalText(row.guild_id, 80),
          channelId: normalizeOptionalText(row.channel_id, 80),
        },
        summary,
        leaderboardScore: getLeaderboardScore(summary),
        finishedAt: row.finished_at ? new Date(row.finished_at) : null,
        startedAt: row.started_at ? new Date(row.started_at) : null,
      };
    })
    .filter(
      (entry) =>
        entry.player.userId &&
        (entry.summary.guessCount > 0 || entry.summary.hintCount > 0 || entry.summary.status !== "Attempted")
    );

  entries.sort((left, right) => {
    const statusDifference =
      getLeaderboardStatusPriority(left.summary.status) -
      getLeaderboardStatusPriority(right.summary.status);

    if (statusDifference !== 0) {
      return statusDifference;
    }

    if (left.leaderboardScore !== right.leaderboardScore) {
      return left.leaderboardScore - right.leaderboardScore;
    }

    if (left.summary.guessCount !== right.summary.guessCount) {
      return left.summary.guessCount - right.summary.guessCount;
    }

    if (left.summary.hintCount !== right.summary.hintCount) {
      return left.summary.hintCount - right.summary.hintCount;
    }

    if (left.finishedAt && right.finishedAt) {
      const finishedDifference = left.finishedAt.getTime() - right.finishedAt.getTime();

      if (finishedDifference !== 0) {
        return finishedDifference;
      }
    }

    if (left.startedAt && right.startedAt) {
      const startedDifference = left.startedAt.getTime() - right.startedAt.getTime();

      if (startedDifference !== 0) {
        return startedDifference;
      }
    }

    return left.player.displayName.localeCompare(right.player.displayName);
  });

  return Number.isFinite(limit) ? entries.slice(0, limit) : entries;
}

async function loadGuildSolveDateSet(guildId) {
  if (!progressPool) {
    throw new Error("Leaderboard requires DATABASE_URL to be configured.");
  }

  await ensureProgressStorage();

  const params = [];
  const guildFilter = guildId ? "AND guild_id = $1" : "";

  if (guildId) {
    params.push(guildId);
  }

  const result = await progressPool.query(
    `
      SELECT DISTINCT puzzle_id
      FROM player_progress
      WHERE solved_answer IS NOT NULL
      ${guildFilter}
    `,
    params
  );

  return new Set(
    result.rows
      .map((row) => normalizePuzzleDateOverride(row.puzzle_id))
      .filter(Boolean)
  );
}

async function getGuildSolveStreak({ guildId, endingPuzzleId }) {
  const solvedDateSet = await loadGuildSolveDateSet(guildId);
  let currentDateId = normalizePuzzleDateOverride(endingPuzzleId);
  let streak = 0;

  while (currentDateId && solvedDateSet.has(currentDateId)) {
    streak += 1;
    currentDateId = shiftPuzzleDateId(currentDateId, -1);
  }

  return streak;
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

async function getProgressCardFonts() {
  if (!progressCardFontsPromise) {
    progressCardFontsPromise = Promise.all([
      fs.readFile(progressCardFontRegularPath),
      fs.readFile(progressCardFontBoldPath),
    ]).then(([regularFont, boldFont]) => [
      {
        name: "Inter",
        data: regularFont,
        weight: 400,
        style: "normal",
      },
      {
        name: "Inter",
        data: boldFont,
        weight: 700,
        style: "normal",
      },
    ]);
  }

  return progressCardFontsPromise;
}

function getProgressBadgeConfig(status) {
  if (status === "Solved") {
    return {
      label: "SOLVED",
      icon: "check",
      fill: "#143924",
      border: "#23c16b",
      text: "#84f0b2",
    };
  }

  if (status === "Gave up") {
    return {
      label: "GAVE UP",
      icon: "x",
      fill: "#431d27",
      border: "#ff5f7a",
      text: "#ffb2bf",
    };
  }

  return {
    label: "ATTEMPTING",
    icon: "spiral",
    fill: "#4a3e17",
    border: "#f8c44f",
    text: "#ffe08a",
  };
}

function renderProgressBadgeIcon(h, badge, sizeOverride = null) {
  const iconSize = sizeOverride || (badge.icon === "spiral" ? 28 : 22);
  const commonSvgProps = {
    width: iconSize,
    height: iconSize,
    viewBox: "0 0 24 24",
    style: {
      display: "flex",
      width: iconSize,
      height: iconSize,
    },
  };

  if (badge.icon === "check") {
    return h(
      "svg",
      commonSvgProps,
      h("path", {
        d: "M5 12.5L9.5 17L19 7.5",
        fill: "none",
        stroke: badge.text,
        strokeWidth: 3.2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      })
    );
  }

  if (badge.icon === "x") {
    return h(
      "svg",
      commonSvgProps,
      h("path", {
        d: "M7 7L17 17M17 7L7 17",
        fill: "none",
        stroke: badge.text,
        strokeWidth: 3.2,
        strokeLinecap: "round",
      })
    );
  }

  return h(
    "svg",
    commonSvgProps,
    h("path", {
      d: "M6 4C3.8 5.6 2.5 8 2.5 10.8C2.5 15.3 6 18.9 10.4 18.9C14.2 18.9 17.1 16 17.1 12.4C17.1 9.3 14.8 7 11.9 7C9.5 7 7.7 8.8 7.7 11.1C7.7 13 9.1 14.4 10.9 14.4C12.3 14.4 13.4 13.3 13.4 11.9C13.4 10.8 12.6 10 11.6 10",
      fill: "none",
      stroke: badge.text,
      strokeWidth: 2.6,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    })
  );
}

function renderAvatarNode(h, player, avatarDataUri, options = {}) {
  const size = options.size || 220;
  const borderWidth = options.borderWidth || 6;
  const borderColor = options.borderColor || "#35353d";
  const fontSize = options.fontSize || Math.round(size * 0.34);

  if (avatarDataUri) {
    return h("img", {
      src: avatarDataUri,
      width: size,
      height: size,
      style: {
        width: size,
        height: size,
        borderRadius: 9999,
        border: `${borderWidth}px solid ${borderColor}`,
      },
    });
  }

  return h(
    "div",
    {
      style: {
        width: size,
        height: size,
        borderRadius: 9999,
        border: `${borderWidth}px solid ${borderColor}`,
        background: "#464652",
        color: "#c7c8d3",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize,
        fontWeight: 700,
      },
    },
    getPlayerInitials(player)
  );
}

function renderStatusBadge(h, status, options = {}) {
  const badge = getProgressBadgeConfig(status);
  const fontSize = options.fontSize || 26;
  const paddingY = options.paddingY || 14;
  const paddingX = options.paddingX || 30;
  const iconSize = options.iconSize || (fontSize >= 24 ? 22 : 16);
  const gap = options.gap || 14;

  return h(
    "div",
    {
      style: {
        display: "flex",
        padding: `${paddingY}px ${paddingX}px`,
        borderRadius: 9999,
        background: badge.fill,
        border: `2px solid ${badge.border}`,
        color: badge.text,
        fontSize,
        fontWeight: 700,
        alignItems: "center",
        alignSelf: "flex-start",
        gap,
      },
    },
    renderProgressBadgeIcon(h, badge, iconSize),
    badge.label
  );
}

function renderCrownIcon(h, size = 40) {
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 64 64",
      style: {
        display: "flex",
        width: size,
        height: size,
      },
    },
    h("path", {
      d: "M11 48L16 23L28 34L32 16L36 34L48 23L53 48Z",
      fill: "#f4c542",
      stroke: "#a96c00",
      strokeWidth: 3,
      strokeLinejoin: "round",
    }),
    h("rect", {
      x: 9,
      y: 47,
      width: 46,
      height: 8,
      rx: 4,
      fill: "#f0b429",
      stroke: "#a96c00",
      strokeWidth: 3,
    }),
    h("circle", {
      cx: 16,
      cy: 21,
      r: 4,
      fill: "#ff5a83",
    }),
    h("circle", {
      cx: 32,
      cy: 14,
      r: 4,
      fill: "#19d8a0",
    }),
    h("circle", {
      cx: 48,
      cy: 21,
      r: 4,
      fill: "#4da3ff",
    })
  );
}

function getProgressBarSegments(summary) {
  const total = summary.greenCount + summary.yellowCount + summary.redCount;

  if (total <= 0) {
    return {
      greenWidth: "0%",
      yellowWidth: "0%",
      redWidth: "0%",
    };
  }

  return {
    greenWidth: `${(summary.greenCount / total) * 100}%`,
    yellowWidth: `${(summary.yellowCount / total) * 100}%`,
    redWidth: `${(summary.redCount / total) * 100}%`,
  };
}

function getProgressStatDisplay(status, type, value) {
  if (status === "Gave up") {
    return {
      value: "X",
      color: "#ff5a83",
    };
  }

  if (status !== "Solved") {
    return {
      value: String(value),
      color: "#f5f6fa",
    };
  }

  if (type === "guesses") {
    if (value <= 15) {
      return { value: String(value), color: "#19d8a0" };
    }

    if (value <= 35) {
      return { value: String(value), color: "#ffcb47" };
    }

    return { value: String(value), color: "#ff5a83" };
  }

  if (value <= 1) {
    return { value: String(value), color: "#19d8a0" };
  }

  if (value <= 5) {
    return { value: String(value), color: "#ffcb47" };
  }

  return { value: String(value), color: "#ff5a83" };
}

function buildProgressCardMarkup({ summary, avatarDataUri, player, puzzle }) {
  const h = React.createElement;
  const badge = getProgressBadgeConfig(summary.status);
  const segments = getProgressBarSegments(summary);
  const guessDisplay = getProgressStatDisplay(summary.status, "guesses", summary.guessCount);
  const hintDisplay = getProgressStatDisplay(summary.status, "hints", summary.hintCount);
  const contextoNumber = getContextoNumber(puzzle);
  const avatarNode = avatarDataUri
    ? h("img", {
        src: avatarDataUri,
        width: 220,
        height: 220,
        style: {
          width: 220,
          height: 220,
          borderRadius: 9999,
          border: "6px solid #35353d",
        },
      })
    : h(
        "div",
        {
          style: {
            width: 220,
            height: 220,
            borderRadius: 9999,
            border: "6px solid #35353d",
            background: "#2b2b34",
            color: "#f4f4f5",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 74,
            fontWeight: 700,
          },
        },
        getPlayerInitials(player)
      );

  return h(
    "div",
    {
      style: {
        width: 720,
        height: 920,
        display: "flex",
        background: "#111114",
        borderRadius: 40,
        padding: 24,
        color: "#f4f4f5",
      },
    },
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          border: "2px solid #2c2c33",
          borderRadius: 34,
          background: "#17171c",
          padding: "38px 36px 42px",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            fontSize: 52,
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: -1,
          },
        },
        contextoNumber ? `Contexto #${contextoNumber}` : "Contexto"
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            marginTop: 14,
            fontSize: 28,
            color: "#b7b9c5",
          },
        },
        puzzle?.date || ""
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            marginTop: 34,
          },
        },
        avatarNode
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            marginTop: 24,
            padding: "14px 30px",
            borderRadius: 9999,
            background: badge.fill,
            border: `2px solid ${badge.border}`,
            color: badge.text,
            fontSize: 26,
            fontWeight: 700,
            alignItems: "center",
            gap: 14,
          },
        },
        renderProgressBadgeIcon(h, badge),
        badge.label
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            marginTop: 34,
            alignItems: "flex-end",
            justifyContent: "center",
            gap: 14,
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              fontSize: 96,
              fontWeight: 700,
              lineHeight: 0.9,
              color: guessDisplay.color,
              letterSpacing: -2,
            },
          },
          guessDisplay.value
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              fontSize: 30,
              color: "#8e8f9c",
              paddingBottom: 10,
            },
          },
          "guesses"
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              fontSize: 42,
              color: "#676875",
              paddingBottom: 6,
            },
          },
          "/"
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              gap: 10,
            },
          },
          h(
            "div",
            {
              style: {
                display: "flex",
                fontSize: 96,
                fontWeight: 700,
                lineHeight: 0.9,
              color: hintDisplay.color,
                letterSpacing: -2,
              },
            },
          hintDisplay.value
          ),
          h(
            "div",
            {
              style: {
                display: "flex",
                fontSize: 30,
                color: "#8e8f9c",
                paddingBottom: 10,
              },
            },
            "hints used"
          )
        )
      ),
      h(
        "div",
        {
          style: {
            marginTop: 32,
            width: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            borderTop: "2px solid #2f3138",
            padding: "34px 0 0",
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              width: "100%",
              height: 28,
              overflow: "hidden",
              borderRadius: 9999,
              background: "#272730",
            },
          },
          h("div", {
            style: {
              display: "flex",
              width: segments.greenWidth,
              background: "#12c48b",
            },
          }),
          h("div", {
            style: {
              display: "flex",
              width: segments.yellowWidth,
              background: "#ff9f0a",
            },
          }),
          h("div", {
            style: {
              display: "flex",
              width: segments.redWidth,
              background: "#ff3366",
            },
          })
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              width: "100%",
              justifyContent: "space-between",
              marginTop: 20,
            },
          },
          h(
            "div",
            {
              style: {
                display: "flex",
                fontSize: 32,
                fontWeight: 700,
                color: "#19d8a0",
              },
            },
            `${summary.greenCount} close`
          ),
          h(
            "div",
            {
              style: {
                display: "flex",
                fontSize: 32,
                fontWeight: 700,
                color: "#ffcb47",
              },
            },
            `${summary.yellowCount} mid`
          ),
          h(
            "div",
            {
              style: {
                display: "flex",
                fontSize: 32,
                fontWeight: 700,
                color: "#ff5a83",
              },
            },
            `${summary.redCount} far`
          )
        )
      )
    )
  );
}

async function renderProgressCardBuffer({ player, puzzle, progress }) {
  const summary = summarizePlayerProgress(progress);
  const avatarDataUri = await getAvatarDataUri(player?.avatarUrl);
  const fonts = await getProgressCardFonts();
  const markup = buildProgressCardMarkup({
    player,
    puzzle,
    summary,
    avatarDataUri,
  });
  const svg = await satori(markup, {
    width: 720,
    height: 920,
    fonts,
  });
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: 720,
    },
  });

  return {
    summary,
    buffer: resvg.render().asPng(),
  };
}

function formatHintLabel(hintCount, compact = false) {
  if (hintCount <= 0) {
    return compact ? " / 0 hints" : "0 hints";
  }

  if (compact) {
    return ` / ${hintCount} ${hintCount === 1 ? "hint" : "hints"}`;
  }

  return `${hintCount} ${hintCount === 1 ? "hint" : "hints"}`;
}

function buildLeaderboardCardMarkup({ puzzle, entries, hiddenCount = 0 }) {
  const h = React.createElement;
  const winner = entries[0];
  const remainingEntries = entries.slice(1);
  const contextoNumber = getContextoNumber(puzzle);
  const cardWidth = 1600;
  const winnerHeight = 332;
  const rowHeight = 222;
  const footerHeight = hiddenCount > 0 ? 82 : 0;
  const cardHeight = 156 + winnerHeight + remainingEntries.length * rowHeight + footerHeight + 36;
  const winnerGuessDisplay = getProgressStatDisplay(
    winner.summary.status,
    "guesses",
    winner.summary.guessCount
  );
  const winnerHintDisplay = getProgressStatDisplay(
    winner.summary.status,
    "hints",
    winner.summary.hintCount
  );
  const winnerAvatar = renderAvatarNode(h, winner.player, winner.avatarDataUri, {
    size: 172,
    borderWidth: 8,
    borderColor: "#a56a00",
    fontSize: 64,
  });

  return h(
    "div",
    {
      style: {
        width: cardWidth,
        height: cardHeight,
        display: "flex",
        background: "#0c0d12",
        borderRadius: 42,
        padding: 22,
        color: "#f5f6fa",
      },
    },
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: 34,
          border: "3px solid #2b2d35",
          background: "#1a1b20",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "36px 44px",
            background: "#1b1c22",
            borderBottom: "3px solid #30323c",
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              fontSize: 44,
              fontWeight: 700,
            },
          },
          contextoNumber ? `Contexto #${contextoNumber} Leaderboard` : "Contexto Leaderboard"
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              fontSize: 40,
              color: "#9092a0",
            },
          },
          puzzle.date
        )
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 42,
            padding: "40px 44px",
            minHeight: winnerHeight,
            background: "#2a231d",
            borderBottom: remainingEntries.length > 0 ? "3px solid #30323c" : "none",
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 34,
              flex: 1,
            },
          },
          h(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 206,
              },
            },
            renderCrownIcon(h, 62),
            h(
              "div",
              {
                style: {
                  display: "flex",
                  marginTop: -10,
                },
              },
              winnerAvatar
            )
          ),
          h(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 24,
                flex: 1,
              },
            },
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 30,
                },
              },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 58,
                    fontWeight: 700,
                    lineHeight: 1,
                    flex: 1,
                  },
                },
                winner.player.displayName
              ),
              renderStatusBadge(h, winner.summary.status, {
                fontSize: 28,
                paddingY: 16,
                paddingX: 28,
                iconSize: 24,
                gap: 14,
              })
            ),
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 16,
                },
              },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 120,
                    fontWeight: 700,
                    lineHeight: 0.9,
                    letterSpacing: -2,
                    color: winnerGuessDisplay.color,
                  },
                },
                winnerGuessDisplay.value
              ),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 42,
                    color: "#8f92a0",
                    paddingBottom: 14,
                  },
                },
                "guesses"
              ),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 38,
                    color: "#7f8190",
                    paddingBottom: 12,
                  },
                },
                "/"
              ),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 120,
                    fontWeight: 700,
                    lineHeight: 0.9,
                    letterSpacing: -2,
                    color: winnerHintDisplay.color,
                  },
                },
                winnerHintDisplay.value
              ),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 42,
                    color: "#8f92a0",
                    paddingBottom: 14,
                  },
                },
                winner.summary.hintCount === 1 ? "hint" : "hints"
              )
            )
          )
        )
      ),
      ...remainingEntries.flatMap((entry, index) => {
        const guessDisplay = getProgressStatDisplay(entry.summary.status, "guesses", entry.summary.guessCount);
        const hintDisplay = getProgressStatDisplay(entry.summary.status, "hints", entry.summary.hintCount);
        const avatarNode = renderAvatarNode(h, entry.player, entry.avatarDataUri, {
          size: 104,
          borderWidth: 5,
          borderColor: "#2f313a",
          fontSize: 38,
        });

        return [
          h(
            "div",
            {
              key: `row-${entry.player.userId}`,
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 34,
                minHeight: rowHeight,
                padding: "30px 44px",
                background: "#1a1b20",
                borderBottom:
                  index === remainingEntries.length - 1 && hiddenCount === 0 ? "none" : "3px solid #30323c",
              },
            },
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 34,
                  flex: 1,
                },
              },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    width: 52,
                    justifyContent: "center",
                    fontSize: 42,
                    color: "#767987",
                    flexShrink: 0,
                  },
                },
                String(index + 2)
              ),
              avatarNode,
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: 20,
                    flex: 1,
                  },
                },
                h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      fontSize: 46,
                      fontWeight: 400,
                      lineHeight: 1,
                    },
                  },
                  entry.player.displayName
                ),
                renderStatusBadge(h, entry.summary.status, {
                  fontSize: 24,
                  paddingY: 12,
                  paddingX: 16,
                  iconSize: 20,
                  gap: 10,
                })
              )
            ),
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 12,
                  marginLeft: 26,
                },
              },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 88,
                    fontWeight: 700,
                    lineHeight: 0.9,
                    letterSpacing: -1.5,
                    color: guessDisplay.color,
                  },
                },
                guessDisplay.value
              ),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 34,
                    color: "#8f92a0",
                    paddingBottom: 12,
                  },
                },
                "guesses"
              ),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 32,
                    color: "#7f8190",
                    paddingBottom: 11,
                  },
                },
                "/"
              ),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 88,
                    fontWeight: 700,
                    lineHeight: 0.9,
                    letterSpacing: -1.5,
                    color: hintDisplay.color,
                  },
                },
                hintDisplay.value
              ),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    fontSize: 34,
                    color: "#8f92a0",
                    paddingBottom: 12,
                  },
                },
                entry.summary.hintCount === 1 ? "hint" : "hints"
              )
            )
          ),
        ];
      }),
      hiddenCount > 0
        ? h(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: footerHeight,
                padding: "18px 28px",
                color: "#8f92a0",
                fontSize: 30,
                background: "#18191f",
              },
            },
            `+${hiddenCount} more players`
          )
        : null
    )
  );
}

async function renderLeaderboardCardBuffer({ puzzle, entries }) {
  const hydratedEntries = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      avatarDataUri: await getAvatarDataUri(entry.player.avatarUrl),
    }))
  );
  const visibleEntries = hydratedEntries.slice(0, LEADERBOARD_ENTRY_LIMIT);
  const hiddenCount = Math.max(0, hydratedEntries.length - visibleEntries.length);
  const markup = buildLeaderboardCardMarkup({
    puzzle,
    entries: visibleEntries,
    hiddenCount,
  });
  const fonts = await getProgressCardFonts();
  const height =
    156 + 332 + Math.max(0, visibleEntries.length - 1) * 222 + (hiddenCount > 0 ? 82 : 0) + 36;
  const svg = await satori(markup, {
    width: 1600,
    height,
    fonts,
  });
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: 1600,
    },
  });

  return {
    buffer: resvg.render().asPng(),
    visibleEntries,
    hiddenCount,
  };
}

function buildProgressMessageContent({ player }) {
  return `${player.displayName} was playing Contexto`;
}

function buildLeaderboardMessageContent({ puzzle, entries, streak, timeframeLabel }) {
  const intro = `Your group is on a ${streak}-day streak! 🔥 Here are ${timeframeLabel} results:`;
  const scoreLines = entries.map((entry) => {
    const score = getLeaderboardScore(entry.summary);
    const hintPart =
      entry.summary.hintCount > 0
        ? ` (${entry.summary.guessCount} guesses, ${entry.summary.hintCount} ${
            entry.summary.hintCount === 1 ? "hint" : "hints"
          })`
        : "";
    return `<@${entry.player.userId}>: ${score} score${hintPart}`;
  });

  return [intro, ...scoreLines].join("\n");
}

async function loadLeaderboardMessageRecord({ puzzleId, channelId }) {
  if (!progressPool || !puzzleId || !channelId) {
    return null;
  }

  const result = await progressPool.query(
    `
      SELECT message_id
      FROM leaderboard_messages
      WHERE puzzle_id = $1 AND channel_id = $2
      LIMIT 1
    `,
    [puzzleId, channelId]
  );

  return result.rows[0]?.message_id || null;
}

async function saveLeaderboardMessageRecord({ puzzleId, guildId, channelId, messageId }) {
  if (!progressPool || !puzzleId || !channelId || !messageId) {
    return;
  }

  await progressPool.query(
    `
      INSERT INTO leaderboard_messages (
        puzzle_id,
        guild_id,
        channel_id,
        message_id
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (puzzle_id, channel_id)
      DO UPDATE SET
        guild_id = EXCLUDED.guild_id,
        message_id = EXCLUDED.message_id,
        updated_at = NOW()
    `,
    [puzzleId, guildId || null, channelId, messageId]
  );
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
  if (!rankingVocabularyPromise) {
    rankingVocabularyPromise = Promise.resolve().then(() => {
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
    });
  }

  return rankingVocabularyPromise;
}

async function getAllowedAnswers() {
  if (!allowedAnswersPromise) {
    allowedAnswersPromise = getOrderedAnswers().then((answers) => new Set(answers));
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

function serializeSemanticCache(semantic) {
  return {
    provider: semantic.provider,
    modelId: semantic.modelId,
    scoringVersion: semantic.scoringVersion,
    puzzleId: semantic.puzzleId,
    answer: semantic.answer,
    answerEmbedding: semantic.answerEmbedding,
    vocabularySize: semantic.vocabularySize,
    rankedWords: semantic.rankedWords,
    sortedScores: semantic.sortedScores,
    cachedGuessScores: Object.fromEntries(semantic.cachedGuessScoresMap || []),
  };
}

async function loadPersistedSemanticCache(puzzle, vocabularySize) {
  if (!progressPool) {
    return null;
  }

  await ensureProgressStorage();

  const result = await progressPool.query(
    `
      SELECT cache_json
      FROM daily_puzzle_cache
      WHERE puzzle_id = $1
      LIMIT 1
    `,
    [puzzle.id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const parsedCache = result.rows[0].cache_json;

  if (
    parsedCache?.provider === "openai" &&
    parsedCache?.modelId === OPENAI_EMBEDDING_MODEL &&
    parsedCache?.scoringVersion === SCORING_VERSION &&
    parsedCache?.puzzleId === puzzle.id &&
    parsedCache?.answer === puzzle.answer &&
    parsedCache?.vocabularySize === vocabularySize
  ) {
    return hydrateSemanticCache(parsedCache);
  }

  return null;
}

async function persistSemanticCache(semantic) {
  if (!progressPool) {
    return;
  }

  await ensureProgressStorage();

  const serialized = serializeSemanticCache(semantic);

  await progressPool.query(
    `
      INSERT INTO daily_puzzle_cache (
        puzzle_id,
        puzzle_date,
        answer,
        provider,
        model_id,
        scoring_version,
        vocabulary_size,
        cache_json,
        generated_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
      ON CONFLICT (puzzle_id)
      DO UPDATE SET
        puzzle_date = EXCLUDED.puzzle_date,
        answer = EXCLUDED.answer,
        provider = EXCLUDED.provider,
        model_id = EXCLUDED.model_id,
        scoring_version = EXCLUDED.scoring_version,
        vocabulary_size = EXCLUDED.vocabulary_size,
        cache_json = EXCLUDED.cache_json,
        updated_at = NOW()
    `,
    [
      semantic.puzzleId,
      semantic.puzzleId,
      semantic.answer,
      semantic.provider,
      semantic.modelId,
      semantic.scoringVersion,
      semantic.vocabularySize,
      JSON.stringify(serialized),
    ]
  );
}

async function generateSemanticCache(puzzle) {
  console.log(
    `Generating API-backed semantic cache for "${puzzle.answer}" using ${RANKING_VOCAB_SIZE} words...`
  );

  const [allowedAnswers, vocabulary] = await Promise.all([
    getAllowedAnswers(),
    buildRankingVocabulary(),
  ]);
  validatePuzzleAnswer(puzzle.answer, allowedAnswers);
  const answerEmbedding = (await embedTexts([puzzle.answer]))[0];
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

async function loadOrGenerateSemanticPuzzle(puzzle, { forceRefresh = false } = {}) {
  const [allowedAnswers, vocabulary] = await Promise.all([
    getAllowedAnswers(),
    buildRankingVocabulary(),
  ]);

  if (!PUZZLE_ANSWER_OVERRIDE) {
    validatePuzzleAnswer(puzzle.answer, allowedAnswers);
  }

  if (!forceRefresh) {
    const persistedCache = await loadPersistedSemanticCache(puzzle, vocabulary.length);

    if (persistedCache) {
      return {
        puzzle,
        semantic: persistedCache,
      };
    }
  }

  const semantic = await generateSemanticCache(puzzle);
  return {
    puzzle,
    semantic,
  };
}

async function getSemanticPuzzle({ forceRefresh = false } = {}) {
  const puzzle = await loadPuzzle();
  const promiseKey = forceRefresh ? `${puzzle.id}:force` : puzzle.id;

  for (const key of semanticPuzzlePromises.keys()) {
    if (!key.startsWith(puzzle.id)) {
      semanticPuzzlePromises.delete(key);
    }
  }

  if (!semanticPuzzlePromises.has(promiseKey)) {
    semanticPuzzlePromises.set(
      promiseKey,
      loadOrGenerateSemanticPuzzle(puzzle, { forceRefresh }).finally(() => {
        if (forceRefresh) {
          semanticPuzzlePromises.delete(promiseKey);
        }
      })
    );
  }

  return semanticPuzzlePromises.get(promiseKey);
}

async function precomputeTodayPuzzle({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    const puzzle = await loadPuzzle();
    semanticPuzzlePromises.delete(puzzle.id);
    semanticPuzzlePromises.delete(`${puzzle.id}:force`);
  }

  const result = await getSemanticPuzzle({ forceRefresh });

  if (forceRefresh) {
    semanticPuzzlePromises.delete(result.puzzle.id);
  }

  return {
    puzzleId: result.puzzle.id,
    date: result.puzzle.date,
    answer: result.puzzle.answer,
    vocabularySize: result.semantic.vocabularySize,
  };
}

async function triggerTodayPuzzlePrecompute({
  forceRefresh = false,
  source = "internal",
} = {}) {
  const puzzle = await loadPuzzle();
  const promiseKey = `${puzzle.id}:${forceRefresh ? "force" : "default"}`;

  if (!backgroundPrecomputePromises.has(promiseKey)) {
    const startedAt = Date.now();
    const task = precomputeTodayPuzzle({ forceRefresh })
      .then((result) => {
        const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(
          `[${source}] Background precompute ready for puzzle ${result.puzzleId} (${result.answer}) with ${result.vocabularySize} ranked words in ${elapsedSeconds}s.`
        );
        return result;
      })
      .catch((error) => {
        console.error(`[${source}] Background precompute failed for puzzle ${puzzle.id}:`, error);
        return null;
      })
      .finally(() => {
        backgroundPrecomputePromises.delete(promiseKey);
      });

    backgroundPrecomputePromises.set(promiseKey, task);

    return {
      puzzleId: puzzle.id,
      date: puzzle.date,
      forceRefresh,
      started: true,
    };
  }

  return {
    puzzleId: puzzle.id,
    date: puzzle.date,
    forceRefresh,
    started: false,
  };
}

async function scoreGuess(guess) {
  const normalizedGuess = parseGuessInput(guess);
  const acceptedWords = await getAcceptedWords();

  if (!acceptedWords.has(normalizedGuess)) {
    throw new Error("I don't recognize that word.");
  }

  const { puzzle, semantic } = await getSemanticPuzzle();

  const guessCacheKey = `${puzzle.id}:${normalizedGuess}`;
  const cachedGuess = guessScoreCache.get(guessCacheKey);
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

  guessScoreCache.set(guessCacheKey, result);
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

async function getStarterRevealGuess(existingGuesses = []) {
  const normalizedExistingWords = new Set(
    (Array.isArray(existingGuesses) ? existingGuesses : [])
      .map((entry) => normalizeGuess(entry?.guess))
      .filter(Boolean)
  );
  const { puzzle, semantic } = await getSemanticPuzzle();
  const preferredEntry = semantic.rankedWords[99];

  if (preferredEntry && preferredEntry.word !== puzzle.answer && !normalizedExistingWords.has(preferredEntry.word)) {
    return {
      guess: preferredEntry.word,
      rank: 100,
      solved: false,
      hinted: false,
      revealed: true,
      countsTowardScore: false,
    };
  }

  for (let index = 99; index < semantic.rankedWords.length; index += 1) {
    const entry = semantic.rankedWords[index];

    if (!entry || entry.word === puzzle.answer || normalizedExistingWords.has(entry.word)) {
      continue;
    }

    return {
      guess: entry.word,
      rank: index + 1,
      solved: false,
      hinted: false,
      revealed: true,
      countsTowardScore: false,
    };
  }

  return null;
}

function createPlayMessageComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(PLAY_BUTTON_ID)
        .setLabel("Play now!")
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

function createNoLeaderboardEntriesError(puzzle) {
  const error = new Error(`No leaderboard entries found for ${puzzle.date} yet.`);
  error.code = "NO_LEADERBOARD_ENTRIES";
  return error;
}

async function buildLeaderboardAttachment({ guildId, dateInput, defaultDayOffset = -1 }) {
  const targetPuzzleDateId =
    normalizePuzzleDateOverride(dateInput) ||
    shiftPuzzleDateId(getCurrentPuzzleDateId(), defaultDayOffset);
  const puzzle = await loadPuzzleForDateId(targetPuzzleDateId);
  const entries = await loadLeaderboardEntries({
    puzzleId: puzzle.id,
    guildId,
  });

  if (entries.length === 0) {
    throw createNoLeaderboardEntriesError(puzzle);
  }

  const streak = await getGuildSolveStreak({
    guildId,
    endingPuzzleId: puzzle.id,
  });
  const { buffer } = await renderLeaderboardCardBuffer({
    puzzle,
    entries,
  });
  const attachmentName = `contexto-leaderboard-${puzzle.id}.png`;
  const currentPuzzleDateId = getCurrentPuzzleDateId();
  const yesterdayPuzzleDateId = shiftPuzzleDateId(currentPuzzleDateId, -1);
  const timeframeLabel =
    puzzle.id === currentPuzzleDateId
      ? "today's"
      : puzzle.id === yesterdayPuzzleDateId
        ? "yesterday's"
        : `${puzzle.date}'s`;

  return {
    puzzle,
    entries,
    streak,
    timeframeLabel,
    attachment: new AttachmentBuilder(buffer, {
      name: attachmentName,
    }),
  };
}

async function buildLeaderboardMessagePayload({ guildId, dateInput, defaultDayOffset = -1 }) {
  const result = await buildLeaderboardAttachment({
    guildId,
    dateInput,
    defaultDayOffset,
  });

  return {
    ...result,
    payload: {
      content: buildLeaderboardMessageContent({
        puzzle: result.puzzle,
        entries: result.entries,
        streak: result.streak,
        timeframeLabel: result.timeframeLabel,
      }),
      files: [result.attachment],
      components: createPlayMessageComponents(),
      allowedMentions: {
        users: result.entries.map((entry) => entry.player.userId).filter(Boolean),
      },
    },
  };
}

async function syncLeaderboardMessage({ channelId, dateInput, defaultDayOffset = -1 }) {
  if (!client.isReady()) {
    throw new Error("Discord bot is not ready yet.");
  }

  const targetChannelId = normalizeOptionalText(channelId, 80) || LEADERBOARD_CHANNEL_ID || null;

  if (!targetChannelId) {
    throw new Error("Missing leaderboard channel. Set LEADERBOARD_CHANNEL_ID.");
  }

  const channel = await client.channels.fetch(targetChannelId).catch(() => null);

  if (!channel || !channel.isTextBased()) {
    throw new Error("Leaderboard target channel is missing or is not text-based.");
  }

  const guildId = normalizeOptionalText(channel.guildId, 80) || null;
  const { puzzle, payload } = await buildLeaderboardMessagePayload({
    guildId,
    dateInput,
    defaultDayOffset,
  });
  const existingMessageId = await loadLeaderboardMessageRecord({
    puzzleId: puzzle.id,
    channelId: targetChannelId,
  });

  if (existingMessageId) {
    const existingMessage = await channel.messages.fetch(existingMessageId).catch(() => null);

    if (existingMessage) {
      await existingMessage.edit({
        ...payload,
        attachments: [],
      });

      return {
        puzzle,
        channelId: targetChannelId,
        messageId: existingMessage.id,
        created: false,
      };
    }
  }

  const sentMessage = await channel.send(payload);
  await saveLeaderboardMessageRecord({
    puzzleId: puzzle.id,
    guildId,
    channelId: targetChannelId,
    messageId: sentMessage.id,
  });

  return {
    puzzle,
    channelId: targetChannelId,
    messageId: sentMessage.id,
    created: true,
  };
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

async function handleInternalPrecompute(req, res) {
  try {
    if (PRECOMPUTE_TRIGGER_TOKEN) {
      const providedToken = String(
        req.headers["x-precompute-token"] || req.body?.token || req.query?.token || ""
      ).trim();

      if (providedToken !== PRECOMPUTE_TRIGGER_TOKEN) {
        res.status(401).json({
          ok: false,
          error: "Unauthorized precompute request.",
        });
        return;
      }
    }

    const forceRefresh =
      String(req.body?.force || req.query?.force || "")
        .trim()
        .toLowerCase() === "true";
    const waitForCompletion =
      String(req.body?.wait || req.query?.wait || "")
        .trim()
        .toLowerCase() === "true";

    if (waitForCompletion) {
      const result = await precomputeTodayPuzzle({
        forceRefresh,
      });

      res.json({
        ok: true,
        mode: "completed",
        ...result,
      });
      return;
    }

    const result = await triggerTodayPuzzlePrecompute({
      forceRefresh,
      source: "internal-precompute",
    });

    res.json({
      ok: true,
      mode: "accepted",
      ...result,
    });
  } catch (error) {
    console.error("Failed to precompute today's puzzle:", error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Failed to precompute puzzle.",
    });
  }
}

app.get("/internal/precompute", handleInternalPrecompute);
app.post("/internal/precompute", handleInternalPrecompute);

async function handleInternalPostLeaderboard(req, res) {
  try {
    if (LEADERBOARD_TRIGGER_TOKEN) {
      const providedToken = String(
        req.headers["x-leaderboard-token"] || req.body?.token || req.query?.token || ""
      ).trim();

      if (providedToken !== LEADERBOARD_TRIGGER_TOKEN) {
        res.status(401).json({
          ok: false,
          error: "Unauthorized leaderboard post request.",
        });
        return;
      }
    }

    const result = await syncLeaderboardMessage({
      channelId: req.body?.channelId || req.query?.channelId || null,
      dateInput: req.body?.date || req.query?.date || null,
      defaultDayOffset:
        String(req.body?.timeframe || req.query?.timeframe || "")
          .trim()
          .toLowerCase() === "today"
          ? 0
          : -1,
    });

    res.json({
      ok: true,
      puzzleId: result.puzzle.id,
      date: result.puzzle.date,
      channelId: result.channelId,
      messageId: result.messageId,
      created: result.created,
    });
  } catch (error) {
    if (error?.code === "NO_LEADERBOARD_ENTRIES") {
      console.log(error.message);
      res.json({
        ok: true,
        skipped: true,
        reason: "no_entries",
        error: error.message,
      });
      return;
    }

    console.error("Failed to post leaderboard:", error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Failed to post leaderboard.",
    });
  }
}

app.get("/internal/post-leaderboard", handleInternalPostLeaderboard);
app.post("/internal/post-leaderboard", handleInternalPostLeaderboard);

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
    const existingProgress = await loadPlayerProgress(player, puzzle.id);
    const { progress, starterRevealAdded, starterReveal } = await ensureStarterRevealProgress({
      player,
      puzzleId: puzzle.id,
      progress: existingProgress,
    });

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
      starterRevealAdded,
      starterReveal,
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
    } else if (interaction.commandName === "contexto-leaderboard") {
      if (!interaction.guildId) {
        throw new Error("Leaderboards can only be generated inside a server.");
      }

      await interaction.deferReply();

      const requestedDate = interaction.options.getString("date");
      const { puzzle, entries, streak, timeframeLabel, attachment } = await buildLeaderboardAttachment({
        guildId: interaction.guildId,
        dateInput: requestedDate,
      });

      await interaction.editReply({
        content: buildLeaderboardMessageContent({ puzzle, entries, streak, timeframeLabel }),
        files: [attachment],
        allowedMentions: {
          users: entries.map((entry) => entry.player.userId).filter(Boolean),
        },
      });
    } else if (interaction.commandName === "contexto-leaderboard-today") {
      if (!interaction.guildId) {
        throw new Error("Leaderboards can only be generated inside a server.");
      }

      await interaction.deferReply();

      const { puzzle, entries, streak, timeframeLabel, attachment } = await buildLeaderboardAttachment({
        guildId: interaction.guildId,
        defaultDayOffset: 0,
      });

      await interaction.editReply({
        content: buildLeaderboardMessageContent({ puzzle, entries, streak, timeframeLabel }),
        files: [attachment],
        allowedMentions: {
          users: entries.map((entry) => entry.player.userId).filter(Boolean),
        },
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

  precomputeTodayPuzzle()
    .then((result) => {
      console.log(
        `Startup prewarm ready for puzzle ${result.puzzleId} (${result.answer}) with ${result.vocabularySize} ranked words.`
      );
    })
    .catch((error) => {
      console.error("Startup prewarm failed:", error);
    });

  await client.login(DISCORD_BOT_TOKEN);
})().catch((error) => {
  console.error("Startup failed:", error);

  if (server) {
    server.close();
  }

  process.exit(1);
});
