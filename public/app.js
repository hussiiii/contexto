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
const giveUpModal = document.getElementById("give-up-modal");
const closeGiveUpButton = document.getElementById("close-give-up-button");
const cancelGiveUpButton = document.getElementById("cancel-give-up-button");
const confirmGiveUpButton = document.getElementById("confirm-give-up-button");

const isEmbedded = window.self !== window.top;
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

let requestedBy = "contexto-web-ui";
let launchChannelId = null;
let currentScreen = "home";
let puzzle = null;
let guesses = [];
let guessedWords = new Set();
let resultPosted = false;
let activityLabel = "A player";
let solvedAnswer = null;
let topWords = null;
let gameFinished = false;
let gaveUp = false;

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

function syncModalState() {
  const hasOpenModal = !topWordsModal.hidden || !giveUpModal.hidden;
  document.body.classList.toggle("modal-open", hasOpenModal);
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

  if (guesses.length > 0) {
    latestGuess.append(createGuessRow(guesses[0], { isNew: true }));
  }

  const sortedGuesses = [...guesses].sort((left, right) => left.rank - right.rank);

  for (const entry of sortedGuesses) {
    guessList.append( createGuessRow(entry) );
  }
}

function setGameFinishedState(answer, { solved }) {
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
}

function applyGuessResult(data, { hinted = false, countsTowardScore = true } = {}) {
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

  if (data.solved) {
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

    const result = applyGuessResult(data, { hinted: true });
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
      body: JSON.stringify({ guess }),
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Guess failed.");
    }

    const result = applyGuessResult(data, {
      countsTowardScore: !gameFinished,
    });
    setStatus(result.status, result.statusType);

    if (result.solved) {
      if (!resultPosted) {
        await postResult();
      }
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
