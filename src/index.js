import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";
import {
  ActionRowBuilder,
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
import { words as popularWords } from "popular-english-words";

dotenv.config();

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  DEFAULT_CHANNEL_ID,
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
const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const RANKING_VOCAB_SIZE = Number(process.env.RANKING_VOCAB_SIZE || "10000");
const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || "128");
const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: OPENAI_BASE_URL || undefined,
    })
  : null;

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
let semanticPuzzlePromise;

const slashCommands = [
  new SlashCommandBuilder()
    .setName("contexto-test")
    .setDescription("Send a test message from the Contexto MVP bot.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Optional channel override for the test message.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("contexto-play")
    .setDescription("Launch the Contexto activity in Discord.")
    .toJSON(),
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

async function sendTestMessage({ channelId, requestedBy = "web-ui" }) {
  const targetChannelId = channelId || DEFAULT_CHANNEL_ID;

  if (!targetChannelId) {
    throw new Error(
      "No channel ID provided. Set DEFAULT_CHANNEL_ID or pass channelId in the request."
    );
  }

  const channel = await client.channels.fetch(targetChannelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error("Target channel is missing or is not a text channel.");
  }

  const content = `Test\nTriggered by: ${requestedBy}`;
  await channel.send({ content });

  return {
    channelId: targetChannelId,
    content,
  };
}

async function loadPuzzle() {
  const rawPuzzle = await fs.readFile(puzzleFilePath, "utf8");
  return JSON.parse(rawPuzzle);
}

function normalizeGuess(guess) {
  return String(guess || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
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

function buildRankingVocabulary(answer) {
  const filteredWords = popularWords.getMostPopularFilter(
    RANKING_VOCAB_SIZE,
    (word) => /^[a-z]+$/.test(word) && word.length >= 3 && word.length <= 16
  );

  const uniqueWords = new Set(filteredWords);
  uniqueWords.add(answer);

  return [...uniqueWords];
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
  const vocabulary = buildRankingVocabulary(puzzle.answer);
  const rankedWords = [];

  for (let index = 0; index < vocabulary.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = vocabulary.slice(index, index + EMBEDDING_BATCH_SIZE);
    const embeddings = await embedTexts(batch);

    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      rankedWords.push({
        word: batch[batchIndex],
        score: dotProduct(answerEmbedding, embeddings[batchIndex]),
      });
    }
  }

  rankedWords.sort((left, right) => right.score - left.score);

  const cache = {
    provider: "openai",
    modelId: OPENAI_EMBEDDING_MODEL,
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

  console.log("Semantic ranking cache generated.");
  return hydratedCache;
}

async function getSemanticPuzzle() {
  if (!semanticPuzzlePromise) {
    semanticPuzzlePromise = (async () => {
      const puzzle = await loadPuzzle();

      try {
        const rawCache = await fs.readFile(semanticCacheFilePath, "utf8");
        const parsedCache = JSON.parse(rawCache);

        if (
          parsedCache.provider === "openai" &&
          parsedCache.modelId === OPENAI_EMBEDDING_MODEL &&
          parsedCache.puzzleId === puzzle.id &&
          parsedCache.answer === puzzle.answer &&
          parsedCache.vocabularySize === buildRankingVocabulary(puzzle.answer).length
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
  const normalizedGuess = normalizeGuess(guess);

  if (!normalizedGuess) {
    throw new Error("Enter a valid word.");
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
    score = dotProduct(semantic.answerEmbedding, guessEmbedding);
    rank = findRankFromSortedScores(semantic.sortedScores, score);

    semantic.cachedGuessScoresMap.set(normalizedGuess, { rank, score });
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

async function sendResultMessage({
  channelId,
  requestedBy = "A player",
  guessCount,
  answer,
  bestRank,
}) {
  const targetChannelId = channelId || DEFAULT_CHANNEL_ID;

  if (!targetChannelId) {
    throw new Error(
      "No channel ID provided. Set DEFAULT_CHANNEL_ID or pass channelId in the request."
    );
  }

  const channel = await client.channels.fetch(targetChannelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error("Target channel is missing or is not a text channel.");
  }

  const content = [
    "Contexto Result",
    `${requestedBy} solved today's puzzle in ${guessCount} guesses.`,
    `Answer: ${answer}`,
    `Best rank reached: ${bestRank}`,
  ].join("\n");

  await channel.send({ content });

  return {
    channelId: targetChannelId,
    content,
  };
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
  });
});

app.get("/api/puzzle", async (_req, res) => {
  try {
    const { puzzle, semantic } = await getSemanticPuzzle();

    res.json({
      ok: true,
      puzzle: {
        id: puzzle.id,
        date: puzzle.date,
        answerLength: puzzle.answer.length,
        totalRankedWords: semantic.vocabularySize,
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

app.post("/api/guess", async (req, res) => {
  try {
    const result = await scoreGuess(req.body?.guess);

    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("Failed to score guess:", error);
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/send-test-message", async (req, res) => {
  try {
    const { channelId, requestedBy } = req.body ?? {};
    const result = await sendTestMessage({ channelId, requestedBy });

    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("Failed to send test message:", error);
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/post-result", async (req, res) => {
  try {
    const { channelId, requestedBy, guessCount, bestRank, answer } = req.body ?? {};

    if (!guessCount || !answer) {
      throw new Error("Missing guessCount or answer.");
    }

    const result = await sendResultMessage({
      channelId,
      requestedBy,
      guessCount,
      answer,
      bestRank: bestRank || 1,
    });

    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("Failed to post result:", error);
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
    if (interaction.commandName === "contexto-test") {
      const selectedChannel = interaction.options.getChannel("channel");
      const result = await sendTestMessage({
        channelId: selectedChannel?.id,
        requestedBy: interaction.user.username,
      });

      await interaction.reply({
        content: `Sent a test message to <#${result.channelId}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "contexto-play") {
      await interaction.launchActivity();
      return;
    }

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

const server = app.listen(Number(PORT), () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

client.login(DISCORD_BOT_TOKEN).catch((error) => {
  console.error("Discord login failed:", error);
  server.close();
  process.exit(1);
});
