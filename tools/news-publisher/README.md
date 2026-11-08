# Llamble news publisher

Write "Llamble news" that shows up on the Home page of every Llamble instance. Only you can publish it, because every post is signed with a key that lives on your PC.

## Run it

```
node tools/news-publisher/publish.mjs
```

It opens a page in your browser (http://127.0.0.1:4791, only reachable from your own PC). Add, edit or delete posts, then:

- **Publish** signs everything and writes `site/news.json`. Commit and push it yourself.
- **Publish & push to GitHub** does the commit and push for you.

The website (llamble.com, from the repo's `site/` folder) serves the file. Each Llamble instance checks it every few hours, so new posts reach everyone within about 6 hours. No Llamble update needed.

To check the file without opening the page: `node tools/news-publisher/publish.mjs --verify`.

## Your signing key (important)

The first time you run it, it creates your private key here:

- Windows: `%APPDATA%\LlambleNewsPublisher\private-key.pem`
- Mac/Linux: `~/.config/llamble-news-publisher/private-key.pem`

**Back that file up somewhere safe**, such as a USB stick or a password manager. Anyone who has it can publish Llamble news. If you lose it, you'll have to create a new one and ship its public key in a Llamble update, because older instances won't trust the new key until they update.

The matching **public** key goes into `server/news_pubkey.txt` automatically on first run. Commit that file. Instances only trust news signed with the key that was in that file when they were built. The private key never goes into the repo; the tool refuses to run if its key folder and the repo overlap.

## What instances do with it

- Each instance downloads `news.json`, checks the signature against its built-in public key, and throws away anything that doesn't match, so a hacked website or GitHub account can't fake news.
- Instance admins can turn Llamble news off in their instance settings.

## File format

`site/news.json`:

```json
{ "payload": "{\"version\":1,\"items\":[...]}", "signature": "<base64 Ed25519 signature of payload>" }
```

Each item: `id` (lowercase, dashes), `title` (up to 120), `body` (markdown, up to 8000), optional `url` and `image` (https only), `published_at` (ms). At most 50 items, newest first.
