// GET /api/config -> settings the browser needs.
// The Google Maps key is meant to be public (restrict it to your site's URL in Google Cloud Console).
// Set GOOGLE_MAPS_API_KEY in Azure: Static Web App > Settings > Environment variables.
module.exports = async function (context) {
  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: { mapsKey: process.env.GOOGLE_MAPS_API_KEY || "" }
  };
};
