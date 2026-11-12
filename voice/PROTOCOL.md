# Voice sidecar protocol

Wendell (Bun) starts the voice sidecar (Node) as a child process. The sidecar owns the Discord voice connections: UDP, encryption (including DAVE), Opus, receiving speech and playing speech. It does not connect to the Discord gateway and does not know the bot token. Wendell sends and receives the gateway events for it.

Each message is one JSON object on one line (NDJSON). Wendell writes to the sidecar's stdin. The sidecar writes to stdout. The sidecar writes logs only as `log` messages, never as other text on stdout. Text on stderr is for crashes only.

All IDs are Discord snowflakes as strings. One guild has at most one voice connection.

## Wendell to sidecar

| `type` | Fields | What the sidecar does |
| --- | --- | --- |
| `configure` | `tts: { url, voice }`, `vad: { silenceMs, minSpeechMs, maxUtteranceMs }` | First message, sent once. `tts.url` is the base URL of the speech server (for example `http://127.0.0.1:8880`). |
| `join` | `guildId`, `channelId`, `userId` (Wendell's user ID) | Joins the channel, or moves to it. Sends a `gateway` message with the voice state update. |
| `leave` | `guildId` | Stops playback, leaves the channel, sends the `gateway` message for it, then `disconnected`. |
| `voiceStateUpdate` | `guildId`, `data` (the raw `VOICE_STATE_UPDATE` payload `d`) | Wendell forwards only the events for Wendell's own user. |
| `voiceServerUpdate` | `guildId`, `data` (the raw `VOICE_SERVER_UPDATE` payload `d`) | |
| `speak` | `guildId`, `id`, `text` | Adds the text to the guild's speech queue. It is spoken after the earlier items. |
| `stop` | `guildId` | Stops the current speech and clears the queue. Each removed item gets `speech` with state `interrupted`. |

## Sidecar to Wendell

| `type` | Fields | Meaning |
| --- | --- | --- |
| `gateway` | `guildId`, `payload` (a complete gateway payload, for example `{ "op": 4, "d": { … } }`) | Wendell sends it on the gateway connection of the guild without change. |
| `ready` | `guildId`, `channelId` | The voice connection is ready. Audio can play and is received. |
| `disconnected` | `guildId`, `reason` | The connection is gone and the sidecar does not try again. Also sent after `leave`. |
| `utterance` | `guildId`, `userId`, `wav` (base64), `durationMs` | One complete thing that one person said: 16 kHz, mono, 16-bit WAV. The sidecar sends it after `vad.silenceMs` of silence, or after `vad.maxUtteranceMs`. It drops speech shorter than `vad.minSpeechMs`. It sends utterances of every user, also bots. Wendell filters them. |
| `speech` | `guildId`, `id`, `state`: `started` \| `finished` \| `interrupted` \| `failed`, optional `error` | The state of a `speak` item. |
| `log` | `level`: `debug` \| `info` \| `warning` \| `error`, `message`, optional `fields` (object) | Never contains spoken text or tokens. |

## Speech

- The sidecar sends `POST {tts.url}/v1/audio/speech` with `{ "input": text, "voice": tts.voice, "response_format": "pcm", "stream": true }`. The answer is raw PCM: 24 kHz, mono, signed 16-bit little-endian, sent in chunks while it is made. The sample rate is also in the `X-Sample-Rate` header.
- Playback starts with the first chunk. It does not wait for the full answer.
- When a person speaks for longer than `vad.minSpeechMs` while Wendell speaks, the sidecar stops the current item and clears the queue (`interrupted` for each). It cancels the HTTP request, so the speech server stops.
- If the speech server fails, the item gets `failed` and the next item plays.

## Lifetime

- The sidecar exits when stdin closes. Before it exits, it leaves every channel.
- A line that is not valid JSON or has an unknown `type` gets a `log` with level `warning` and is otherwise ignored.
