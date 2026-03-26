# Contexto Discord MVP

Minimal starter for a Discord-based Contexto prototype:

- `discord.js` bot
- Express API
- tiny web UI with a single "Send Test Message" button

## What this MVP proves

- the bot can join your server
- a slash command can trigger a bot message
- the web UI can call your backend
- the backend can tell the bot to send a message

## Project structure

- `src/index.js`: bot + API server
- `scripts/build-answer-list.js`: one-time curated answer list generator
- `public/index.html`: minimal UI
- `public/app.js`: button logic
- `public/styles.css`: simple styling

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the env file and fill in your Discord values:

   ```bash
   cp .env.example .env
   ```

3. Generate the curated answer list:

   ```bash
   npm run generate:answers
   ```

   This creates `data/generated/allowed-answers.json`, which the app uses to validate secret words.

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000`

On the first run, the server will call the embeddings API to build a cached ranking set for the current puzzle answer. Later runs reuse the generated cache in `data/generated`.

## Required Discord values

- `DISCORD_BOT_TOKEN`: your bot token
- `DISCORD_CLIENT_ID`: application ID from the Discord developer portal
- `DISCORD_GUILD_ID`: the server ID where you want fast slash command registration
- `DEFAULT_CHANNEL_ID`: the text channel where test messages should go by default
- `OPENAI_API_KEY`: API key for embeddings-based semantic scoring
- `OPENAI_EMBEDDING_MODEL`: embeddings model to use, defaults to `text-embedding-3-small`
- `OPENAI_BASE_URL`: optional, for OpenAI-compatible providers
- `RANKING_VOCAB_SIZE`: size of the fixed ranking universe used for deterministic ranks
- `ANSWER_TARGET_COUNT`: number of curated secret-answer words to keep
- `ANSWER_CANDIDATE_POOL_SIZE`: number of popular real-word candidates to review during answer generation
- `ANSWER_SCORING_BATCH_SIZE`: batch size for the answer-list scoring pass
- `ANSWER_SCORING_MODEL`: OpenAI model used to score candidate answer quality

## Current test flows

### Slash command

Use:

```text
/contexto-test
/contexto-play
/contexto-post
```

- `/contexto-test`: send a bot test message
- `/contexto-play`: launch the Contexto activity directly
- `/contexto-post`: post a text-channel prompt with a `Play Contexto` button

`/contexto-test` and `/contexto-post` both support an optional channel override.

### Web UI

Open the page and play the current puzzle.

When launched inside Discord as an Activity, the UI will automatically use the channel it was launched from.

## Semantic Scoring

Gameplay now uses an embeddings API-backed scorer:

- a fixed candidate vocabulary is embedded once per puzzle day
- those words are ranked against the answer and cached in `data/generated`
- arbitrary user guesses are embedded live
- out-of-vocabulary guesses are inserted into the same ranked distribution
- repeated guesses are cached on disk for deterministic reuse

This keeps the game shared and deterministic while still allowing much broader user guess input than a tiny hardcoded word list.

### Current ranking behavior

- the fixed ranking universe defaults to `50000` words
- that universe is now built from `popular-english-words`, filtered through `word-list`
- common low-information stop words such as `the`, `and`, `but`, etc. are filtered out
- puzzle answers must come from the generated curated answer list in `data/generated/allowed-answers.json`
- ranking uses an adjusted score:
  - semantic similarity from embeddings
  - minus lexical penalties for edit-distance, substring, and character-overlap traps

### Curated answer generation

Use the generator any time you want to refresh the set of valid secret words:

```bash
npm run generate:answers
```

What it does:

- builds a candidate pool from the most popular words that also exist in `word-list`
- filters out stopwords and anything listed in `data/filters/blocked-answer-words.txt`
- uses an OpenAI model to score which candidates make strong Contexto-style answer words
- writes:
  - `data/generated/allowed-answers.json`: the final curated answer list used at runtime
  - `data/generated/answer-candidate-scores.json`: detailed generation output for inspection

Recommended workflow:

1. Run `npm run generate:answers`.
2. Spot-check a handful of generated words instead of manually reviewing all `10,000`.
3. Commit `data/generated/allowed-answers.json` so production has the same answer universe.

## Turning this into a Discord Activity

This MVP now supports both a normal browser launch and an embedded Discord Activity launch.

### Fastest local-dev path

1. Keep the app running locally:

   ```bash
   npm run dev
   ```

2. Install and run a tunnel to expose your local server over HTTPS:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

3. Copy the generated HTTPS domain, for example:

   ```text
   https://your-subdomain.trycloudflare.com
   ```

4. In the Discord Developer Portal:
   - open your app
   - go to `Activities`
   - enable Activities / Embedded App support
   - go to `Activities -> URL Mappings`
   - add a mapping with:
     - `PREFIX`: `/`
     - `TARGET`: `your-subdomain.trycloudflare.com`
   - go to `Activities -> Settings`
   - make sure desktop is enabled under supported platforms

5. In Discord:
   - enable Developer Mode
   - open a server text channel
   - use the app launcher / entry point for your app in that channel
   - launch your app

When launched inside Discord, the page will show `Launch mode: Discord Activity`, the SDK status should switch to connected, and the UI will auto-target the current channel ID for posting.

### Production path later

Once you want a stable URL, deploy this app to a host with HTTPS and replace the URL mapping target with your real domain.
