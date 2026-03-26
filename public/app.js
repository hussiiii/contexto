const homeScreen = document.getElementById("home-screen");
const gameScreen = document.getElementById("game-screen");
const playTodayButton = document.getElementById("play-today-button");
const backButton = document.getElementById("back-button");
const guessForm = document.getElementById("guess-form");
const guessSubmitButton = document.getElementById("guess-submit-button");
const statusText = document.getElementById("status");
const guessInput = document.getElementById("guess-input");
const guessCountText = document.getElementById("guess-count");
const vocabCountText = document.getElementById("vocab-count");
const emptyState = document.getElementById("empty-state");
const latestGuessSection = document.getElementById("latest-guess-section");
const latestGuess = document.getElementById("latest-guess");
const guessList = document.getElementById("guess-list");
const solveBanner = document.getElementById("solve-banner");
const solveCopy = document.getElementById("solve-copy");
const heroDateText = document.getElementById("hero-date");
const gameDateText = document.getElementById("game-date");

const isEmbedded = window.self !== window.top;

let requestedBy = "contexto-web-ui";
let launchChannelId = null;
let currentScreen = "home";
let puzzle = null;
let guesses = [];
let guessedWords = new Set();
let resultPosted = false;
let activityLabel = "A player";
let solvedAnswer = null;

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

  if (!onHome) {
    window.setTimeout(() => {
      guessInput.focus();
    }, 50);
  }
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

function updateGuessCount() {
  guessCountText.textContent = String(guesses.length);
}

function bestRank() {
  if (guesses.length === 0) {
    return null;
  }

  return Math.min(...guesses.map((entry) => entry.rank));
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

  if (guesses.length > 0) {
    latestGuess.append(createGuessRow(guesses[0], { isNew: true }));
  }

  const sortedGuesses = [...guesses].sort((left, right) => left.rank - right.rank);

  for (const entry of sortedGuesses) {
    guessList.append( createGuessRow(entry) );
  }
}

function setSolvedState(answer) {
  solveBanner.hidden = false;
  solveCopy.textContent = `The answer was "${answer}". You solved today's puzzle in ${guesses.length} guesses.`;
  guessInput.disabled = true;
  guessSubmitButton.disabled = true;
}

async function loadPuzzle() {
  const response = await fetch("/api/puzzle");
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Failed to load puzzle.");
  }

  puzzle = data.puzzle;
  vocabCountText.textContent = `${puzzle.totalRankedWords} ranked words`;
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

async function initializeDiscordSdk(clientId) {
  if (!isEmbedded) {
    return;
  }

  const { DiscordSDK } = await import("/vendor/embedded-app-sdk/index.mjs");
  const discordSdk = new DiscordSDK(clientId);

  await Promise.race([
    discordSdk.ready(),
    new Promise((_, reject) => {
      window.setTimeout(() => {
        reject(new Error("Discord SDK handshake timed out."));
      }, 8000);
    }),
  ]);

  requestedBy = "contexto-activity-ui";
  launchChannelId = discordSdk.channelId;
  activityLabel = "A Discord player";
}

async function postResult() {
  if (!puzzle || guesses.length === 0 || !solvedAnswer) {
    return;
  }

  setStatus("Posting result...");

  try {
    const response = await fetch("/api/post-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channelId: launchChannelId || undefined,
        requestedBy: activityLabel,
        guessCount: guesses.length,
        bestRank: bestRank(),
        answer: solvedAnswer,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Request failed.");
    }

    resultPosted = true;
    setStatus(`Posted result to channel ${data.channelId}.`, "success");
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Failed to post result.",
      "error"
    );
  }
}

async function submitGuess(event) {
  event.preventDefault();

  if (!puzzle) {
    setStatus("Puzzle is still loading.", "error");
    return;
  }

  const guess = guessInput.value.trim().toLowerCase();

  if (!guess) {
    setStatus("Enter a word first.", "error");
    return;
  }

  if (guessedWords.has(guess)) {
    setStatus("You already tried that word.", "error");
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
      body: JSON.stringify({ guess }),
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Guess failed.");
    }

    guessedWords.add(data.guess);
    guesses.unshift({
      attempt: guesses.length + 1,
      guess: data.guess,
      rank: data.rank,
      solved: data.solved,
    });
    guessInput.value = "";
    renderGuesses();

    if (data.solved) {
      solvedAnswer = data.answer;
      setSolvedState(data.answer);
      setStatus("You found the secret word.", "success");

      if (!resultPosted) {
        await postResult();
      }
    } else {
      setStatus(`"${data.guess}" is rank ${data.rank}.`);
    }
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
  setDates();
  renderGuesses();

  try {
    const config = await loadConfig();
    await loadPuzzle();
    await initializeDiscordSdk(config.clientId);

    if (launchChannelId) {
      setStatus(`Ready to post back into ${launchChannelId}.`);
    } else {
      setStatus("Ready.");
    }
  } catch (error) {
    setSdkStatus("Unavailable");
    setStatus(
      error instanceof Error ? error.message : "Failed to initialize app.",
      "error"
    );
  }
}

bootstrap();
playTodayButton.addEventListener("click", () => showScreen("game"));
backButton.addEventListener("click", () => showScreen("home"));
guessForm.addEventListener("submit", submitGuess);
