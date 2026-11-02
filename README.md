# folio — portfolio generator

Folio is a student portfolio builder with a Node.js/Express server and MongoDB persistence. It supports accounts, editable portfolios, public slug URLs, GitHub repo import, static ZIP export, browser-generated CV PDFs, view analytics, and an optional SMTP contact form.

## Run locally

Requirements: Node.js 20+ and MongoDB. If Docker Compose is installed, the included `compose.yaml` starts MongoDB for local development.

1. Start the local database with `docker compose up -d mongodb`, or create a MongoDB database named `folio` yourself.
2. Copy `.env.example` to `.env`; set `MONGODB_URI`, `MONGODB_DB`, and a long random `SESSION_SECRET`.
3. Install and launch:

   ```sh
   npm install
   npm start
   ```

4. Open `http://localhost:3000`. The schema and session table are initialized on startup.

The MongoDB connection must be available before starting the server. Set `COOKIE_SECURE=true` behind HTTPS. For contact form delivery, configure the `SMTP_*` and `MAIL_FROM` values in `.env`; otherwise visitors can still use the portfolio owner’s displayed email address.

## Features

- Sign up and sign in with password hashing and server sessions.
- Edit bio, skills, education, experience, social links, slug, theme, color, and font.
- Create, edit, and remove projects, including screenshot URLs and live/GitHub links.
- Import public repositories from the GitHub REST API.
- Preview three themes and publish at `http://localhost:3000/your-slug`.
- Export a static ZIP for GitHub Pages or Netlify.
- Print a CV assembled from the same profile and project data; choose “Save as PDF” in the browser print dialog.
- Record server-side portfolio views and inspect a seven-day chart.
- Accept contact messages and deliver them through SMTP when configured.

The editor also works as a browser-only prototype when `index.html` is opened directly, but accounts and shared data require the server. Existing PostgreSQL data is not migrated automatically; export/import it separately before switching databases.
