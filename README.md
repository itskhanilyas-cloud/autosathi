# autosathi
AutoSathi - book an auto-rickshaw in seconds

## Live map & location sharing
Once a driver accepts a ride, the rider and driver both see a live map with each other's
location, the pickup and the drop. Each phone shares its GPS position every few seconds
(the browser asks for location permission).

**Google Maps setup:** add an app setting named `GOOGLE_MAPS_API_KEY` in Azure Portal →
your Static Web App → Settings → Environment variables. Use a key with the *Maps JavaScript API*
enabled, and restrict it to your site's URL in Google Cloud Console. Without a key the app
falls back to OpenStreetMap, so the map still works.

## Cancellation rules
- Riders can cancel any time before the ride starts. Drivers can cancel after accepting,
  before the ride starts; the rider is then matched with another driver.
- Cancelling costs **₹20** if it's 2+ minutes after the driver accepted, or if the driver and
  rider are within 200 m of each other. Cancelling before a driver accepts is free.
- A rider's fee is added to their next ride's fare. A driver's fee is deducted from their earnings.
