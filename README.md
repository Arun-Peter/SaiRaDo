# SaiRaDo

SaiRaDo is a browser-based chat and calling app built with Node.js, Express, and Socket.IO. It supports account sign-up and login, direct and group chats, blocking, audio/video calls, and a small image-attachment pilot.

## Requirements

- Node.js 18 or later
- npm

## Run locally

```sh
npm install
JWT_SECRET="$(openssl rand -hex 32)" npm start
```

Open [http://localhost:3000](http://localhost:3000). Set `JWT_SECRET` to a stable, private value; changing it invalidates existing login tokens. Do not commit the secret to the repository.

## Deploy to Render

This repository includes `render.yaml` for Render Blueprint deployment. In Render, create or update the service from the repository's Blueprint and confirm the service uses the directory containing `server.js`, `package.json`, and `render.yaml` as its root.

The Blueprint installs dependencies with `npm install`, starts the app with `node server.js`, and asks Render to generate `JWT_SECRET`. Keep that value private and stable across deploys. If a signing secret was ever committed to GitHub, rotate it in Render and remove the hard-coded secret from the deployed source.

After deployment, verify the site loads and that project/data paths such as `/server.js`, `/package.json`, `/users.json`, `/chats.json`, `/app_state.json`, and `/gps_logs.json` return 404. Static assets should be served from `public/` only.

## Data and persistence

The server stores data in JSON files next to `server.js`:

- `users.json` — usernames and password hashes
- `chats.json` — direct and group messages
- `app_state.json` — groups and blocked-user state
- `gps_logs.json` — call-related location diagnostics when the browser reports them

These are runtime data files, not source files. Do not commit real user data, chat history, credentials, or location logs. The app can migrate legacy `data.json` into the split files above when it starts.

### Media attachment pilot

The chat composer accepts one JPEG, PNG, GIF, or WebP image smaller than 1 MB, or one MP4 or WebM video smaller than 5 MB, per message, optionally with a caption. Images display inline and open in an enlarged viewer; videos play inline and have an enlarged player. Uploads use authenticated HTTP endpoints, are checked against their file signatures, and are saved in the private `uploads/` directory. Only participants in the direct chat or members of the group can retrieve an attachment. Deleting the corresponding chat history or group removes its uploaded files from the app's filesystem.

This pilot stores attachment metadata with chat messages and media bytes separately; it does not send file data through Socket.IO. Upload files are runtime data and must not be committed. Deleting a file is not a guaranteed secure erase and cannot remove copies a user saved or any infrastructure-level backups. Like the JSON data, files in `uploads/` can be lost when Render's ephemeral filesystem is cleared.

Render's default filesystem for a web service is ephemeral. Files written at runtime can be lost when the service restarts or redeploys. Use an appropriately configured persistent disk or an external database if data must survive restarts, and plan backups separately.

## Privacy notes

The app does not implement end-to-end encryption. The server handles messages in readable form and stores chat data as plaintext JSON. HTTPS protects network traffic in transit when served over HTTPS; it does not encrypt stored files or prevent access by the server operator. Do not use this app for highly sensitive conversations.

The app also requests browser geolocation during call diagnostics and sends the result to the server for logging. Users should grant location permission only if they understand and want this behavior.

## Repository hygiene

Commit application source and configuration, such as `server.js`, `package.json`, `render.yaml`, and the contents of `public/`. Do not commit `node_modules/`, local secrets, or runtime data files.
