// Paste your Google OAuth 2.0 "Web application" Client ID here.
// See ../GOOGLE_DRIVE_SETUP.md for the one-time Google Cloud Console steps.
// A client ID is a public identifier (not a secret) — it's fine to commit.
export const GOOGLE_CLIENT_ID = "1016365344593-t1i4mrovunf2uq4do79isjeti1q29etq.apps.googleusercontent.com";

// Paste a Google API key here (Credentials -> Create Credentials -> API key,
// same Cloud project as the Client ID above). Used by ../../channel.html to
// stream from a *publicly shared* Drive folder without anyone signing in —
// unlike the OAuth token above, an API key doesn't expire and needs no
// browser session, which is what an unattended 24/7 channel needs.
// Restrict it in Cloud Console to: API restriction = Google Drive API,
// Application restriction = HTTP referrers = your domain(s).
// See ../GOOGLE_DRIVE_SETUP.md for details.
export const GOOGLE_API_KEY = "";
