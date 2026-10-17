# Abhi AI

Abhi AI is a browser website built with Flask. It has a black-and-neon English interface, a white animated humanoid assistant, a feature spotlight that changes every second, voice and text controls, local time/date answers, YouTube and Instagram links, a click-to-open phone dialer, and SQLite conversation history.

## Run locally

Use Python 3.10 or newer. From this project folder, create a virtual environment, install dependencies, add your own private API key to `.env`, and start the website server:

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirement.txt
python main.py
```

Open `http://localhost:3000`. The included `.env` contains a placeholder only. Replace `GROQ_API_KEY` with your own private key and restart the website server. `GROQ_MODEL` selects the chat model; `GROQ_STT_MODEL` selects the English transcription model. Keep the key in `.env` or a host's protected environment-variable settings—never put it in `index.html` or `static/app.js`.

## Voice and device actions

Mic capture requests the browser's echo cancellation, noise suppression and automatic gain control when supported. A local voice-activity detector waits for speech and treats about 650 ms of silence as the end of an utterance; the short recording is sent for English transcription, then its text goes to the assistant. When the mic is on, a sustained user voice can interrupt a spoken reply and start a new recording. Raw recordings are not saved by the website. Microphone access requires permission and a secure browser context (HTTPS or localhost); modern Chrome or Edge is recommended. Beamforming depends on the visitor's microphone hardware and is not guaranteed by a browser website. The mic button toggles recording, while the separate **Voice On/Off** button controls spoken replies.

Spoken replies use browser speech synthesis in English. The website prefers an installed voice with “Sargam” in its name, then an Indian-English female voice, and finally the browser's default voice. Voice names and availability depend on the visitor's device and browser; the website does not bundle a particular voice recording.

The website uses short, English gesture cues to animate the humanoid avatar (for example, a polite namaste, nod, smile, thoughtful look or wave). While voice replies are playing, the avatar moves its head, body and arms. Gesture cues are removed from the visible answer and spoken audio. The avatar is a stylized digital assistant, not a real person.

YouTube and Instagram open through allow-listed links after a user action. Local time and date come from the user's device. A call is not placed automatically: select **Call**, enter a phone number, and choose **Open dialer**; the user confirms the call on the device.

## Data and privacy

Conversation text is stored in `codelab.db` using SQLite. The UI includes a **Clear** control. The supplied database is initialized with an empty messages table. Voice recordings are held only long enough to request transcription and are not stored in SQLite. Do not send sensitive information. SQLite files on some cloud hosts may be temporary; configure durable storage before relying on cloud history.

The browser never receives the provider API key. Without a configured key, the website still answers local time/date and creator questions and opens supported links, but general AI chat and server-side voice transcription show a setup message. The creator response is set to: “I was created by Abhimanyu Rana. He is from Shamli and is pursuing an MCA at Galgotias.”

## Files

- `main.py` — Flask routes, private chat/transcription requests, rate limiting and SQLite persistence.
- `index.html` — English-only assistant website.
- `static/styles.css` — black/neon layout and humanoid animation states.
- `static/app.js` — feature spotlight, voice capture, controls, gestures and supported browser actions.
- `requirement.txt` — Python dependencies; `requirements.txt` is included as a compatibility alias.
- `.env` and `.env.example` — environment placeholders; `.env` is ignored by Git.
- `Procfile` — Gunicorn start command.
- `codelab.db` — initialized SQLite database.
