# Orbit

Orbit is a self-hosted agent workbench. Each conversation receives its own Ubuntu 22.04 desktop container; the model can search the public web, open Chrome, run shell commands, and read or write files in that desktop. The UI shows the run history beside an embedded noVNC view and exposes generated files as downloads.

Attach TXT, CSV, PDF, Word, Excel, and PowerPoint files to provide task context. Attachments are uploaded into that conversation's isolated desktop; generated files remain in its Downloads folder.

## Start with Docker

1. Copy `.env.example` to `.env` and set `MODEL_API_KEY`.
2. Build the desktop image and start Orbit:

   ```sh
   docker compose --profile build build desktop-image
   docker compose up --build -d orbit
   ```

3. Open `http://localhost:3000`.

The application mounts the Docker socket so it can create one isolated desktop container per conversation. Compose binds Orbit to localhost by default. Before exposing it publicly, set `ORBIT_PASSWORD` and serve it through an HTTPS reverse proxy. Orbit then requests HTTP Basic authentication. Session transcripts are stored in the `orbit-data` volume. Deleting a conversation in the sidebar also removes its desktop container.

## Run without Compose

Build the desktop image with `docker build -f Dockerfile.desktop -t orbit-desktop:22.04 .`, set `MODEL_API_KEY` in the environment, then run `npm start`. Docker must be installed and available to the same host user.

## Models

The default API uses an OpenAI-compatible endpoint. Set `MODEL_BASE_URL`, `MODEL_API_KEY`, and `DEFAULT_MODEL` in the server environment. Select a built-in model in the UI or choose `自定义模型…` and enter a provider model ID.

## Desktop cleanup

Stopping the Orbit service does not remove desktop containers. To inspect them, run `docker ps --filter label=orbit.session`. Delete a conversation from Orbit when that UI action is available, or remove a desktop with `docker rm -f <container>`.
