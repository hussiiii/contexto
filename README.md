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
- `public/index.html`: minimal UI
- `public/app.js`: button logic
- `public/styles.css`: simple styling
- `data/generated/answers.json`: ordered answer list used by the app

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the env file and fill in your Discord values:

   ```bash
   cp .env.example .env
   ```

3. Make sure `data/generated/answers.json` exists and contains your ordered puzzle answers.

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

## Current test flows

### Slash command

Use:

```text
/contexto-post
```

- `/contexto-post`: post a text-channel prompt with a `Play Contexto` button

`/contexto-post` supports an optional channel override.

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
- that universe is now built from the top `RANKING_VOCAB_SIZE` entries in `popular-english-words`
- common low-information stop words such as `the`, `and`, `but`, etc. are filtered out
- puzzle answers must come from the ordered answer list in `data/generated/answers.json`
- guess validation uses the full `popular-english-words` list, plus everything in `answers.json`
- ranking uses an adjusted score:
  - semantic similarity from embeddings
  - minus lexical penalties for edit-distance, substring, and character-overlap traps

### Curated answers

The app reads its valid secret words from `data/generated/answers.json`.

- keep this file committed so production and local stay in sync
- the order matters if you want to use it as a day-by-day answer schedule
- the daily puzzle is now derived from the current Los Angeles date plus the ordered answer list
- for local testing, use `PUZZLE_DATE_OVERRIDE` and/or `PUZZLE_ANSWER_OVERRIDE`

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
