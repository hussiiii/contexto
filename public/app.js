const homeScreen = document.getElementById("home-screen");
const gameScreen = document.getElementById("game-screen");
const playTodayButton = document.getElementById("play-today-button");
const backButton = document.getElementById("back-button");
const menuButton = document.getElementById("menu-button");
const menuDropdown = document.getElementById("menu-dropdown");
const hintButton = document.getElementById("hint-button");
const giveUpButton = document.getElementById("give-up-button");
const guessForm = document.getElementById("guess-form");
const guessSubmitButton = document.getElementById("guess-submit-button");
const statusText = document.getElementById("status");
const guessInput = document.getElementById("guess-input");
const guessCountText = document.getElementById("guess-count");
const hintCountText = document.getElementById("hint-count");
const emptyState = document.getElementById("empty-state");
const latestGuessSection = document.getElementById("latest-guess-section");
const latestGuess = document.getElementById("latest-guess");
const guessList = document.getElementById("guess-list");
const solveBanner = document.getElementById("solve-banner");
const solveTitle = document.getElementById("solve-title");
const solveCopy = document.getElementById("solve-copy");
const showTopWordsButton = document.getElementById("show-top-words-button");
const heroDateText = document.getElementById("hero-date");
const gameDateText = document.getElementById("game-date");
const topWordsModal = document.getElementById("top-words-modal");
const closeTopWordsButton = document.getElementById("close-top-words-button");
const topWordsStatus = document.getElementById("top-words-status");
const topWordsList = document.getElementById("top-words-list");
const confettiLayer = document.getElementById("confetti-layer");
const giveUpModal = document.getElementById("give-up-modal");
const closeGiveUpButton = document.getElementById("close-give-up-button");
const cancelGiveUpButton = document.getElementById("cancel-give-up-button");
const confirmGiveUpButton = document.getElementById("confirm-give-up-button");

const isEmbedded = window.self !== window.top;
const LOCAL_PLAYER_STORAGE_KEY = "contexto-local-player-v1";
const LOCAL_SESSION_STORAGE_KEY = "contexto-discord-session-v1";
const COMMON_WORDS = new Set([
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

let launchChannelId = null;
let currentScreen = "home";
let puzzle = null;
let guesses = [];
let guessedWords = new Set();
let solvedAnswer = null;
let topWords = null;
let gameFinished = false;
let gaveUp = false;
let confettiTimeoutId = null;
let currentPlayer = null;
let currentSessionToken = null;
let discordSdk = null;

function formatToday() {
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).format(new Date());
}

function showScreen(screenName) {
  currentScreen = screenName;
  const onHome = screenName === "home";

  homeScreen.classList.toggle("screen-active", onHome);
  gameScreen.classList.toggle("screen-active", !onHome);
  closeMenu();
}

function setDates() {
  const today = puzzle?.date || formatToday();
  heroDateText.textContent = today;
  gameDateText.textContent = today;
}

function setStatus(message, type = "neutral") {
  statusText.textContent = message;
  statusText.dataset.state = type;
}

function setGuessControlsEnabled(enabled) {
  guessInput.disabled = !enabled;
  guessSubmitButton.disabled = !enabled;
}

async function reportClientLog(level, message, extra = {}) {
  try {
    await fetch("/api/client-log", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        level,
        message,
        extra,
      }),
      keepalive: true,
    });
  } catch (_error) {
    // Ignore best-effort client log failures.
  }
}

function syncModalState() {
  const hasOpenModal = !topWordsModal.hidden || !giveUpModal.hidden;
  document.body.classList.toggle("modal-open", hasOpenModal);
}

function getOrCreateLocalPlayer() {
  try {
    const rawPlayer = window.localStorage.getItem(LOCAL_PLAYER_STORAGE_KEY);

    if (rawPlayer) {
      const parsed = JSON.parse(rawPlayer);

      if (parsed?.userId && parsed?.displayName) {
        return parsed;
      }
    }
  } catch (_error) {
    // Ignore malformed local debug identity and regenerate it below.
  }

  const generatedPlayer = {
    userId: `web-${crypto.randomUUID()}`,
    displayName: "Web Player",
    avatarUrl: null,
    guildId: null,
    channelId: null,
  };

  window.localStorage.setItem(
    LOCAL_PLAYER_STORAGE_KEY,
    JSON.stringify(generatedPlayer)
  );

  return generatedPlayer;
}

function buildPlayerPayload() {
  if (!currentPlayer) {
    return null;
  }

  return {
    userId: currentPlayer.userId,
    displayName: currentPlayer.displayName,
    avatarUrl: currentPlayer.avatarUrl,
    guildId: currentPlayer.guildId || null,
    channelId: launchChannelId || currentPlayer.channelId || null,
  };
}

function getSessionContext() {
  return {
    guildId: discordSdk?.guildId || currentPlayer?.guildId || null,
    channelId: launchChannelId || discordSdk?.channelId || currentPlayer?.channelId || null,
  };
}

function buildAuthPayload(extra = {}) {
  if (currentSessionToken) {
    return {
      sessionToken: currentSessionToken,
      ...getSessionContext(),
      ...extra,
    };
  }

  return {
    player: buildPlayerPayload(),
    ...extra,
  };
}

function loadStoredSessionToken() {
  try {
    return window.localStorage.getItem(LOCAL_SESSION_STORAGE_KEY);
  } catch (_error) {
    return null;
  }
}

function storeSessionToken(sessionToken) {
  currentSessionToken = sessionToken || null;

  try {
    if (sessionToken) {
      window.localStorage.setItem(LOCAL_SESSION_STORAGE_KEY, sessionToken);
    } else {
      window.localStorage.removeItem(LOCAL_SESSION_STORAGE_KEY);
    }
  } catch (_error) {
    // Ignore storage failures and continue with in-memory session state.
  }
}

function resetGameState() {
  guesses = [];
  guessedWords = new Set();
  solvedAnswer = null;
  topWords = null;
  gameFinished = false;
  gaveUp = false;
  solveBanner.hidden = true;
  solveBanner.dataset.state = "";
  solveTitle.textContent = "You solved it!";
  solveCopy.textContent = "";
  showTopWordsButton.hidden = true;
  setGuessControlsEnabled(false);
  hintButton.disabled = false;
  giveUpButton.disabled = false;
  menuButton.disabled = false;
  guessInput.value = "";
  closeMenu();
}

function renderTopWords(entries) {
  topWordsList.innerHTML = "";

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "top-word-row";

    const rank = document.createElement("span");
    rank.className = "top-word-rank";
    rank.textContent = String(entry.rank);

    const word = document.createElement("span");
    word.className = "top-word-value";
    word.textContent = entry.word;

    row.append(rank, word);
    topWordsList.append(row);
  }
}

function openTopWordsModal() {
  topWordsModal.hidden = false;
  syncModalState();
}

function closeTopWordsModal() {
  topWordsModal.hidden = true;
  syncModalState();
}

function openGiveUpModal() {
  giveUpModal.hidden = false;
  syncModalState();
}

function closeGiveUpModal() {
  giveUpModal.hidden = true;
  syncModalState();
}

function openMenu() {
  if (gameFinished) {
    return;
  }

  menuDropdown.hidden = false;
  menuButton.setAttribute("aria-expanded", "true");
}

function closeMenu() {
  menuDropdown.hidden = true;
  menuButton.setAttribute("aria-expanded", "false");
}

function toggleMenu() {
  if (menuDropdown.hidden) {
    openMenu();
  } else {
    closeMenu();
  }
}

async function loadTopWords() {
  if (topWords) {
    renderTopWords(topWords);
    topWordsStatus.hidden = true;
    return;
  }

  topWordsStatus.hidden = false;
  topWordsStatus.textContent = "Loading...";
  topWordsList.innerHTML = "";

  const response = await fetch("/api/top-words");
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Failed to load top words.");
  }

  topWords = data.topWords || [];
  renderTopWords(topWords);
  topWordsStatus.hidden = topWords.length > 0;
  topWordsStatus.textContent = topWords.length > 0 ? "" : "No words available.";
}

async function showTopWords() {
  openTopWordsModal();

  try {
    await loadTopWords();
  } catch (error) {
    topWordsStatus.hidden = false;
    topWordsStatus.textContent =
      error instanceof Error ? error.message : "Failed to load top words.";
  }
}

function normalizeClientGuessInput(rawGuess) {
  const trimmedGuess = rawGuess.trim().toLowerCase();

  if (!trimmedGuess) {
    throw new Error("Type a word to make a guess.");
  }

  if (/\s/.test(trimmedGuess)) {
    throw new Error("One word only please.");
  }

  const normalizedGuess = trimmedGuess.replace(/[^a-z]/g, "");

  if (!normalizedGuess) {
    throw new Error("That doesn't look like a valid word.");
  }

  if (COMMON_WORDS.has(normalizedGuess)) {
    throw new Error("This word doesn't count, it's too common.");
  }

  return normalizedGuess;
}

function updateGuessCount() {
  guessCountText.textContent = String(getScoreGuessCount());
}

function getHintCount() {
  return guesses.filter((entry) => entry.hinted).length;
}

function updateHintCount() {
  hintCountText.textContent = String(getHintCount());
}

function getScoredGuesses() {
  return guesses.filter((entry) => entry.countsTowardScore !== false);
}

function getScoreGuessCount() {
  return getScoredGuesses().length;
}

function bestRank() {
  const scoredGuesses = getScoredGuesses();

  if (scoredGuesses.length === 0) {
    return null;
  }

  return Math.min(...scoredGuesses.map((entry) => entry.rank));
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

function getGuessFillPercent(rank) {
  const maxRank = Math.max(puzzle?.totalRankedWords || 10000, rank, 2);
  const normalized = 1 - Math.log(rank) / Math.log(maxRank);

  return Math.max(2, Math.min(100, Math.round(normalized * 100)));
}

function createGuessRow(entry, { isNew = false } = {}) {
  const row = document.createElement("div");
  row.className = `guess-row guess-row-${getGuessTone(entry.rank)}${
    entry.solved ? " guess-row-solved" : ""
  }`;

  if (isNew) {
    row.classList.add("guess-row-new");
  }

  const fill = document.createElement("div");
  fill.className = "guess-fill";
  fill.style.width = `${getGuessFillPercent(entry.rank)}%`;

  const content = document.createElement("div");
  content.className = "guess-content";

  const word = document.createElement("span");
  word.className = "guess-word";
  word.textContent = entry.guess;

  const rank = document.createElement("span");
  rank.className = "guess-rank";
  rank.textContent = String(entry.rank);

  content.append(word, rank);
  row.append(fill, content);

  return row;
}

function renderGuesses() {
  guessList.innerHTML = "";
  latestGuess.innerHTML = "";
  emptyState.hidden = guesses.length > 0;
  latestGuessSection.hidden = guesses.length === 0;
  updateGuessCount();
  updateHintCount();

  if (guesses.length > 0) {
    latestGuess.append(createGuessRow(guesses[0], { isNew: true }));
  }

  const sortedGuesses = [...guesses].sort((left, right) => left.rank - right.rank);

  for (const entry of sortedGuesses) {
    guessList.append( createGuessRow(entry) );
  }
}

function launchConfetti() {
  if (!confettiLayer) {
    return;
  }

  if (confettiTimeoutId) {
    window.clearTimeout(confettiTimeoutId);
  }

  confettiLayer.innerHTML = "";
  const colors = ["#86efac", "#facc15", "#60a5fa", "#f472b6", "#fb923c", "#c084fc"];
  const pieceCount = 64;

  for (let index = 0; index < pieceCount; index += 1) {
    const piece = document.createElement("span");
    const left = `${Math.random() * 100}%`;
    const delay = `${Math.random() * 220}ms`;
    const duration = `${3200 + Math.random() * 1900}ms`;
    const driftOne = `${(Math.random() - 0.5) * 180}px`;
    const driftTwo = `${(Math.random() - 0.5) * 260}px`;
    const driftThree = `${(Math.random() - 0.5) * 360}px`;
    const rotateStart = `${Math.random() * 180 - 90}deg`;
    const rotateOne = `${Math.random() * 540 - 270}deg`;
    const rotateTwo = `${Math.random() * 900 - 450}deg`;
    const rotateThree = `${Math.random() * 1260 - 630}deg`;
    const color = colors[index % colors.length];
    const size = 6 + Math.round(Math.random() * 8);
    const fallDistance = `${92 + Math.random() * 24}vh`;
    const top = `${-24 - Math.random() * 120}px`;

    piece.className = "confetti-piece";
    piece.style.left = left;
    piece.style.top = top;
    piece.style.width = `${size}px`;
    piece.style.height = `${Math.round(size * (1.2 + Math.random() * 1.1))}px`;
    piece.style.background = color;
    piece.style.borderRadius = `${1 + Math.random() * 4}px`;
    piece.style.opacity = "0";
    piece.style.animationDelay = delay;
    piece.style.animationDuration = duration;
    piece.style.setProperty("--confetti-drift-one", driftOne);
    piece.style.setProperty("--confetti-drift-two", driftTwo);
    piece.style.setProperty("--confetti-drift-three", driftThree);
    piece.style.setProperty("--confetti-rotate-start", rotateStart);
    piece.style.setProperty("--confetti-rotate-one", rotateOne);
    piece.style.setProperty("--confetti-rotate-two", rotateTwo);
    piece.style.setProperty("--confetti-rotate-three", rotateThree);
    piece.style.setProperty("--confetti-fall-distance", fallDistance);
    confettiLayer.append(piece);
  }

  confettiTimeoutId = window.setTimeout(() => {
    confettiLayer.innerHTML = "";
  }, 7800);
}

function setGameFinishedState(answer, { solved, celebrate = true } = {}) {
  gameFinished = true;
  gaveUp = !solved;
  solveBanner.hidden = false;
  solveBanner.dataset.state = solved ? "solved" : "gave-up";
  solveTitle.textContent = solved ? "You solved it!" : "Better luck next time";
  solveCopy.textContent = solved
    ? `The answer was "${answer}". You solved today's puzzle in ${getScoreGuessCount()} guesses.`
    : `The answer was "${answer}". You can still view the top 100 similar words below.`;
  showTopWordsButton.hidden = false;
  hintButton.disabled = true;
  giveUpButton.disabled = true;
  menuButton.disabled = true;
  closeMenu();

  if (solved && celebrate) {
    launchConfetti();
  }
}

function applyGuessResult(
  data,
  { hinted = false, countsTowardScore = true, freshSolve = data.solved } = {}
) {
  guessedWords.add(data.guess);
  guesses.unshift({
    attempt: guesses.length + 1,
    guess: data.guess,
    rank: data.rank,
    solved: data.solved,
    hinted,
    countsTowardScore,
  });
  guessInput.value = "";
  renderGuesses();

  if (freshSolve) {
    solvedAnswer = data.answer;
    setGameFinishedState(data.answer, { solved: true });
    return {
      status: "You found the secret word.",
      statusType: "success",
      solved: true,
    };
  }

  return {
    status: hinted
      ? `Hint used: "${data.guess}" is rank ${data.rank}.`
      : `"${data.guess}" is rank ${data.rank}.`,
    statusType: hinted ? "success" : "neutral",
    solved: false,
  };
}

function revealAnswerAsGuess(answer) {
  if (!answer || guessedWords.has(answer)) {
    return;
  }

  guessedWords.add(answer);
  guesses.unshift({
    attempt: guesses.length + 1,
    guess: answer,
    rank: 1,
    solved: true,
    hinted: false,
    revealed: true,
    countsTowardScore: false,
  });
  renderGuesses();
}

async function loadPuzzle() {
  const response = await fetch("/api/puzzle");
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Failed to load puzzle.");
  }

  puzzle = data.puzzle;
  setDates();
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error("Failed to load app config.");
  }

  return data;
}

async function restoreStoredSession(sessionToken) {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionToken,
      ...getSessionContext(),
    }),
  });

  if (response.status === 401) {
    return null;
  }

  const data = await response.json();

  if (!response.ok || !data.ok || !data.player) {
    throw new Error(data.error || "Failed to restore Discord session.");
  }

  return data.player;
}

async function loginWithDiscordCode(code) {
  const response = await fetch("/api/discord/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      ...getSessionContext(),
    }),
  });
  const data = await response.json();

  if (!response.ok || !data.ok || !data.player || !data.sessionToken) {
    throw new Error(data.error || "Failed to authenticate Discord user.");
  }

  return data;
}

function describeSdkError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch (_stringifyError) {
    return String(error);
  }
}

async function authorizeWithDiscord(config, promptMode) {
  const authorizePayload = {
    client_id: config.clientId,
    response_type: "code",
    state: "contexto-activity-auth",
    scope: ["identify", "applications.commands"],
  };

  if (promptMode) {
    authorizePayload.prompt = promptMode;
  }

  return discordSdk.commands.authorize(authorizePayload);
}

async function initializeDiscordSdk(config) {
  if (!isEmbedded) {
    currentPlayer = getOrCreateLocalPlayer();
    return;
  }

  setStatus("Connecting to Discord...");
  const { DiscordSDK } = await import("/vendor/embedded-app-sdk/index.mjs");
  discordSdk = new DiscordSDK(config.clientId);

  await Promise.race([
    discordSdk.ready(),
    new Promise((_, reject) => {
      window.setTimeout(() => {
        reject(new Error("Discord SDK handshake timed out."));
      }, 8000);
    }),
  ]);

  launchChannelId = discordSdk.channelId;
  await reportClientLog("info", "Discord SDK ready.", {
    channelId: launchChannelId,
    guildId: discordSdk.guildId,
  });

  if (!config.discordAuthEnabled) {
    await reportClientLog(
      "error",
      "Discord auth disabled because client secret is missing."
    );
    console.warn(
      "Discord Activity auth is disabled because DISCORD_CLIENT_SECRET is not configured."
    );
    return;
  }

  if (!config.redirectUri) {
    throw new Error("DISCORD_REDIRECT_URI is not configured on the server.");
  }

  const storedSessionToken = loadStoredSessionToken();

  if (storedSessionToken) {
    setStatus("Restoring your session...");

    try {
      const restoredPlayer = await restoreStoredSession(storedSessionToken);

      if (restoredPlayer) {
        currentPlayer = restoredPlayer;
        storeSessionToken(storedSessionToken);
        await reportClientLog("info", "Restored existing app session.", {
          userId: currentPlayer.userId,
          displayName: currentPlayer.displayName,
        });
        return;
      }

      await reportClientLog("warn", "Stored app session expired; requesting fresh Discord auth.");
      storeSessionToken(null);
    } catch (error) {
      await reportClientLog("error", "Stored app session restore failed.", {
        message: error instanceof Error ? error.message : String(error),
      });
      storeSessionToken(null);
    }
  }

  setStatus("Authorizing with Discord...");
  let code;

  try {
    const authorizeResult = await authorizeWithDiscord(config, "none");
    code = authorizeResult.code;
    await reportClientLog("info", "Discord authorize succeeded silently.");
  } catch (silentError) {
    await reportClientLog("warn", "Silent Discord authorize failed; retrying interactively.", {
      message: describeSdkError(silentError),
    });

    try {
      const authorizeResult = await authorizeWithDiscord(config);
      code = authorizeResult.code;
      await reportClientLog("info", "Discord authorize succeeded interactively.");
    } catch (interactiveError) {
      await reportClientLog("error", "Discord authorize failed.", {
        silentMessage: describeSdkError(silentError),
        interactiveMessage: describeSdkError(interactiveError),
      });
      throw interactiveError;
    }
  }

  setStatus("Signing you in...");
  const login = await loginWithDiscordCode(code);
  currentPlayer = login.player;
  storeSessionToken(login.sessionToken);
  await reportClientLog("info", "Discord login succeeded.", {
    userId: currentPlayer.userId,
    displayName: currentPlayer.displayName,
  });
}

async function loadSavedProgress() {
  if (!currentPlayer) {
    await reportClientLog("warn", "Skipping saved progress load because no player identity is available.");
    return;
  }

  setStatus("Loading your saved progress...");
  const response = await fetch("/api/progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildAuthPayload()),
  });
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Failed to restore saved progress.");
  }

  const progress = data.progress;

  if (!progress) {
    return;
  }

  guesses = Array.isArray(progress.guesses) ? progress.guesses : [];
  guessedWords = new Set(guesses.map((entry) => entry.guess));
  solvedAnswer = progress.solvedAnswer || null;
  renderGuesses();

  if (solvedAnswer) {
    setGameFinishedState(solvedAnswer, {
      solved: !progress.gaveUp,
      celebrate: false,
    });
  }
}

async function useHint() {
  if (!puzzle || gameFinished) {
    return;
  }

  closeMenu();
  setStatus("Finding a hint...");
  hintButton.disabled = true;

  try {
    const response = await fetch("/api/hint", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...buildAuthPayload(),
        guessedWords: [...guessedWords],
        bestRank: bestRank(),
      }),
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Failed to load hint.");
    }

    if (guessedWords.has(data.guess)) {
      throw new Error("No hint available.");
    }

    const result = applyGuessResult(data, {
      hinted: true,
      countsTowardScore: data.countsTowardScore !== false,
    });
    setStatus(result.status, result.statusType);
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Failed to load hint.",
      "error"
    );
  } finally {
    hintButton.disabled = gameFinished;
  }
}

async function confirmGiveUp() {
  if (!puzzle || gameFinished) {
    return;
  }

  confirmGiveUpButton.disabled = true;
  cancelGiveUpButton.disabled = true;
  closeGiveUpButton.disabled = true;

  try {
    const response = await fetch("/api/give-up", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...buildAuthPayload(),
      }),
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Failed to reveal answer.");
    }

    solvedAnswer = data.answer;
    revealAnswerAsGuess(data.answer);
    closeGiveUpModal();
    setGameFinishedState(data.answer, { solved: false });
    setStatus(`The answer was "${data.answer}".`, "error");
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Failed to reveal answer.",
      "error"
    );
  } finally {
    confirmGiveUpButton.disabled = false;
    cancelGiveUpButton.disabled = false;
    closeGiveUpButton.disabled = false;
  }
}

async function submitGuess(event) {
  event.preventDefault();

  if (!puzzle) {
    setStatus("Puzzle is still loading.", "error");
    return;
  }

  let guess;

  try {
    guess = normalizeClientGuessInput(guessInput.value);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Invalid guess.", "error");
    return;
  }

  if (guessedWords.has(guess)) {
    setStatus("You've already guessed that word. Try a new one.", "error");
    return;
  }

  setStatus("Checking guess...");
  guessSubmitButton.disabled = true;

  try {
    const response = await fetch("/api/guess", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        guess,
        ...buildAuthPayload(),
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Guess failed.");
    }

    const result = applyGuessResult(data, {
      countsTowardScore: data.countsTowardScore !== false,
      freshSolve: Boolean(data.freshSolve),
    });
    setStatus(result.status, result.statusType);
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Failed to submit guess.",
      "error"
    );
  } finally {
    guessSubmitButton.disabled = false;
  }
}

async function bootstrap() {
  resetGameState();
  setDates();
  renderGuesses();

  try {
    const config = await loadConfig();
    await loadPuzzle();
    await initializeDiscordSdk(config);
    setGuessControlsEnabled(true);

    if (currentPlayer) {
      setGuessControlsEnabled(false);
      setStatus("Fetching progress...");
      await loadSavedProgress();
      setGuessControlsEnabled(true);
    }

    if (solvedAnswer) {
      setStatus("Restored your saved progress.", "success");
    } else if (guesses.length > 0) {
      setStatus("Restored your saved progress.", "success");
    } else if (launchChannelId) {
      setStatus(`Ready to post back into ${launchChannelId}.`);
    } else {
      setStatus("Ready.");
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to initialize app.";
    await reportClientLog("error", "App bootstrap failed.", {
      message,
      isEmbedded,
      hasCurrentPlayer: Boolean(currentPlayer),
      channelId: launchChannelId,
    });
    setStatus(
      `${message} Progress will not be saved until Discord sign-in works.`,
      "error"
    );
    setGuessControlsEnabled(Boolean(puzzle));
  }
}

bootstrap();
playTodayButton.addEventListener("click", () => showScreen("game"));
backButton.addEventListener("click", () => showScreen("home"));
menuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu();
});
hintButton.addEventListener("click", useHint);
giveUpButton.addEventListener("click", () => {
  closeMenu();
  openGiveUpModal();
});
guessForm.addEventListener("submit", submitGuess);
showTopWordsButton.addEventListener("click", showTopWords);
closeTopWordsButton.addEventListener("click", closeTopWordsModal);
closeGiveUpButton.addEventListener("click", closeGiveUpModal);
cancelGiveUpButton.addEventListener("click", closeGiveUpModal);
confirmGiveUpButton.addEventListener("click", confirmGiveUp);
topWordsModal.addEventListener("click", (event) => {
  if (event.target === topWordsModal) {
    closeTopWordsModal();
  }
});
giveUpModal.addEventListener("click", (event) => {
  if (event.target === giveUpModal) {
    closeGiveUpModal();
  }
});
document.addEventListener("click", (event) => {
  if (!menuDropdown.hidden && !event.target.closest(".header-menu")) {
    closeMenu();
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !giveUpModal.hidden) {
    closeGiveUpModal();
    return;
  }

  if (event.key === "Escape" && !topWordsModal.hidden) {
    closeTopWordsModal();
    return;
  }

  if (event.key === "Escape" && !menuDropdown.hidden) {
    closeMenu();
  }
});
