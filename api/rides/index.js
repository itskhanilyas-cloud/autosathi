// AutoSathi rides API (Azure Functions, Node).
// Routes:
//   GET  /api/rides?driverId=..        open rides + this driver's rides (no OTPs)
//   GET  /api/rides/{id}?token=..       one ride; OTP included only with the rider's token
//   POST /api/rides                     create a ride  -> { ride, token }
//   POST /api/rides/{id}/{action}       accept | start | complete | cancel | location
//
// Cancellation rules:
//   - Rider can cancel before the ride starts. Driver can cancel after accepting, before the
//     ride starts; the ride then goes back to "searching" for another driver.
//   - Whoever cancels pays a ₹20 fee if it's 2+ minutes since the driver accepted, or if the
//     driver and rider are within 200 m of each other. Cancelling before any driver accepts is free.
//   - A rider's fee is added to their next ride's fare (tracked by phone number).
//     A driver's fee is deducted from their earnings.
const crypto = require("crypto");

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TABLE = "rides";
const PK = "ride", LOC_PK = "loc", DUE_PK = "due";
const DAY = 24 * 60 * 60 * 1000;
const FEE = 20;                       // ₹ cancellation fee
const FEE_AFTER_MS = 2 * 60 * 1000;   // 2 minutes after the driver accepts
const FEE_NEAR_M = 200;               // driver and rider within 200 metres
const LOC_FRESH_MS = 2 * 60 * 1000;   // a location older than this doesn't count for the fee
const LOC_SHOW_MS = 10 * 60 * 1000;   // ...or for the map

// ---------- storage: Azure Table Storage, or in-memory if not configured ----------
let client = null, ready = null;
const mem = new Map(), memLoc = new Map(), memDue = new Map();
async function table() {
  if (!CONN) return null;
  if (!client) {
    const { TableClient, AzureNamedKeyCredential } = require("@azure/data-tables");
    const val = CONN.trim();
    if (/AccountName=|UseDevelopmentStorage/i.test(val)) {
      client = TableClient.fromConnectionString(val, TABLE, { allowInsecureConnection: /=http:\/\/|UseDevelopmentStorage/i.test(val) });
    } else {
      // Only the account key was provided: connect using the account name.
      const account = process.env.AZURE_STORAGE_ACCOUNT || "autosathirides1012";
      client = new TableClient(`https://${account}.table.core.windows.net`, TABLE, new AzureNamedKeyCredential(account, val));
    }
    ready = client.createTable().catch(e => { if (e.statusCode !== 409) throw e; });
  }
  await ready;
  return client;
}
async function getRide(id) {
  const t = await table();
  if (!t) { const r = mem.get(id); return r ? { ride: structuredClone(r), etag: null } : null; }
  try { const e = await t.getEntity(PK, id); return { ride: JSON.parse(e.data), etag: e.etag }; }
  catch (e) { if (e.statusCode === 404) return null; throw e; }
}
async function putRide(ride, etag) {
  const t = await table();
  if (!t) { mem.set(ride.id, structuredClone(ride)); return; }
  const entity = { partitionKey: PK, rowKey: ride.id, data: JSON.stringify(ride), at: ride.at };
  if (etag) await t.updateEntity(entity, "Replace", { etag }); // fails (412) if someone else changed it
  else await t.createEntity(entity);
}
async function recentRides() {
  const t = await table();
  const since = Date.now() - DAY;
  if (!t) return [...mem.values()].filter(r => r.at > since);
  const out = [];
  for await (const e of t.listEntities({ queryOptions: { filter: `PartitionKey eq '${PK}'` } })) {
    const r = JSON.parse(e.data); if (r.at > since) out.push(r);
  }
  return out;
}
// Live locations live in their own rows so GPS updates never clash with ride changes.
async function getLoc(rideId, who) {
  const key = `${rideId}_${who}`, t = await table();
  if (!t) return memLoc.get(key) || null;
  try { const e = await t.getEntity(LOC_PK, key); return { lat: e.lat, lng: e.lng, t: e.t, by: e.by }; }
  catch (e) { if (e.statusCode === 404) return null; throw e; }
}
async function putLoc(rideId, who, loc) {
  const key = `${rideId}_${who}`, t = await table();
  if (!t) { memLoc.set(key, loc); return; }
  await t.upsertEntity({ partitionKey: LOC_PK, rowKey: key, ...loc }, "Replace");
}
// Unpaid rider cancellation fees, keyed by phone number.
async function getDue(phone) {
  const t = await table();
  if (!t) return memDue.get(phone) || 0;
  try { return Number((await t.getEntity(DUE_PK, phone)).amount) || 0; }
  catch (e) { if (e.statusCode === 404) return 0; throw e; }
}
async function setDue(phone, amount) {
  const t = await table();
  if (!t) { memDue.set(phone, amount); return; }
  await t.upsertEntity({ partitionKey: DUE_PK, rowKey: phone, amount }, "Replace");
}

// ---------- helpers ----------
const json = (status, body) => ({ status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body });
const clean = (s, n) => String(s ?? "").trim().slice(0, n);
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const live = r => !r.cancelled && (r.status === 1 || r.status === 2) && r.driver;
function meters(a, b) {
  const R = 6371000, t = x => x * Math.PI / 180, dLa = t(b.lat - a.lat), dLo = t(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Both live locations for a ride in progress (driver's only if it's from the current driver).
async function locsFor(r) {
  if (!live(r)) return {};
  const [rider, driver] = await Promise.all([getLoc(r.id, "rider"), getLoc(r.id, "driver")]);
  return { rider, driver: driver && driver.by === r.driver.id ? driver : null };
}
// What it would cost to cancel right now (same rule for rider and driver).
function feeInfo(r, locs) {
  if (r.cancelled || r.status !== 1) return { fee: 0, reason: "" };
  const now = Date.now(), fresh = l => l && now - l.t < LOC_FRESH_MS;
  const dist = fresh(locs.rider) && fresh(locs.driver) ? meters(locs.rider, locs.driver) : null;
  if (dist !== null && dist <= FEE_NEAR_M) return { fee: FEE, reason: "near", dist };
  if (now - (r.acceptedAt || r.at) >= FEE_AFTER_MS) return { fee: FEE, reason: "late", dist };
  return { fee: 0, reason: "", dist, freeUntil: (r.acceptedAt || r.at) + FEE_AFTER_MS };
}
const pub = l => (l && Date.now() - l.t < LOC_SHOW_MS ? { lat: l.lat, lng: l.lng, t: l.t } : null);

// What anyone may see. Phone only goes to the assigned driver; OTP and driver's location only to the rider.
function view(r, { driverId, token, locs = {} } = {}) {
  const mine = driverId && r.driver && r.driver.id === driverId;
  const isRider = token && sha(token) === r.tokenHash;
  const cancels = r.cancels || [];
  const out = { id: r.id, city: r.city, from: r.from, to: r.to, km: r.km, fare: r.fare, due: r.due || 0,
    total: r.fare + (r.due || 0), pay: r.pay, name: r.name, status: r.status, cancelled: r.cancelled,
    cancelledBy: r.cancelledBy || null, at: r.at, acceptedAt: r.acceptedAt || null,
    driver: r.driver ? { name: r.driver.name, auto: r.driver.auto } : null };
  if (mine) {
    out.phone = r.phone;
    out.riderLoc = pub(locs.rider);
  }
  if (driverId) {
    const own = cancels.filter(c => c.by === "driver" && c.driverId === driverId);
    if (own.length) { out.iCancelled = true; out.myFee = own.reduce((s, c) => s + c.fee, 0); out.myCancelAt = own[own.length - 1].at; }
  }
  if (isRider) {
    out.otp = r.otp; out.phone = r.phone;
    out.driverLoc = pub(locs.driver);
    out.riderFee = r.cancelledBy === "rider" ? r.cancelFee || 0 : 0;
    out.driverCancelled = r.status === 0 && cancels.some(c => c.by === "driver");
  }
  if (mine || isRider) Object.assign(out, (({ fee, reason, dist, freeUntil }) => ({ cancelFee: fee, cancelReason: reason, distance: dist ?? null, freeUntil: freeUntil || null }))(feeInfo(r, locs)));
  return out;
}

module.exports = async function (context, req) {
  const { id, action } = context.bindingData;
  const b = req.body || {};
  try {
    if (req.method === "GET" && !id) {
      const driverId = clean(req.query.driverId, 40);
      const all = await recentRides();
      const mineOrCancelled = r => driverId && ((r.driver && r.driver.id === driverId) ||
        (r.cancels || []).some(c => c.by === "driver" && c.driverId === driverId));
      const list = all.filter(r => (!r.cancelled && r.status === 0) || mineOrCancelled(r))
        .sort((a, b) => b.at - a.at).slice(0, 50);
      const out = await Promise.all(list.map(async r =>
        view(r, { driverId, locs: driverId && r.driver && r.driver.id === driverId ? await locsFor(r) : {} })));
      context.res = json(200, { rides: out, storage: CONN ? "azure-table" : "memory" });
      return;
    }
    if (req.method === "GET" && id) {
      const got = await getRide(clean(id, 40));
      if (!got) return (context.res = json(404, { error: "Ride not found" }));
      context.res = json(200, view(got.ride, { token: req.query.token, driverId: clean(req.query.driverId, 40), locs: await locsFor(got.ride) }));
      return;
    }
    if (req.method === "POST" && !id) {
      const name = clean(b.name, 40), phone = clean(b.phone, 10);
      if (!name) return (context.res = json(400, { error: "Name is required" }));
      if (!/^[6-9]\d{9}$/.test(phone)) return (context.res = json(400, { error: "Enter a valid 10-digit Indian mobile number" }));
      const km = Number(b.km), fare = Number(b.fare);
      if (!(km > 0 && km < 100) || !(fare >= 30 && fare < 5000)) return (context.res = json(400, { error: "Invalid trip" }));
      const token = crypto.randomBytes(16).toString("hex");
      const due = await getDue(phone); // unpaid cancellation fees get added to this ride
      const ride = { id: Date.now().toString(36) + crypto.randomBytes(2).toString("hex"),
        city: clean(b.city, 30), from: clean(b.from, 60), to: clean(b.to, 60), km, fare, due,
        pay: b.pay === "UPI" ? "UPI" : "Cash", name, phone, status: 0, cancelled: false,
        otp: String(crypto.randomInt(1000, 10000)), tokenHash: sha(token), at: Date.now(), driver: null };
      await putRide(ride);
      if (due) await setDue(phone, 0);
      context.res = json(201, { ride: view(ride, { token }), token });
      return;
    }
    if (req.method === "POST" && id && action) {
      const got = await getRide(clean(id, 40));
      if (!got) return (context.res = json(404, { error: "Ride not found" }));
      const { ride: r, etag } = got;
      const driverId = clean(b.driverId, 40);
      const isDriver = driverId && r.driver && r.driver.id === driverId;
      const isRider = b.token && sha(b.token) === r.tokenHash;
      if (r.cancelled) return (context.res = json(409, { error: "Ride was cancelled" }));

      if (action === "location") { // live GPS from rider or driver; doesn't change the ride itself
        const lat = Number(b.lat), lng = Number(b.lng);
        if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return (context.res = json(400, { error: "Bad location" }));
        if (!live(r) || !(isRider || isDriver)) return (context.res = json(409, { error: "Not sharing location for this ride" }));
        await putLoc(r.id, isRider ? "rider" : "driver", { lat, lng, t: Date.now(), by: isRider ? "rider" : driverId });
        context.res = json(200, { ok: true });
        return;
      }

      let chargeRider = 0;
      switch (action) {
        case "accept":
          if (r.status !== 0) return (context.res = json(409, { error: "Ride already taken" }));
          if (!driverId || !clean(b.name, 40) || !clean(b.auto, 20)) return (context.res = json(400, { error: "Driver name and auto number required" }));
          if ((r.cancels || []).some(c => c.by === "driver" && c.driverId === driverId)) return (context.res = json(409, { error: "You cancelled this ride earlier" }));
          r.driver = { id: driverId, name: clean(b.name, 40), auto: clean(b.auto, 20).toUpperCase() }; r.status = 1; r.acceptedAt = Date.now(); break;
        case "start":
          if (!isDriver || r.status !== 1) return (context.res = json(409, { error: "Can't start this ride" }));
          if (String(b.otp) !== r.otp) return (context.res = json(400, { error: "Wrong OTP" }));
          r.status = 2; r.startedAt = Date.now(); break;
        case "complete":
          if (!isDriver || r.status !== 2) return (context.res = json(409, { error: "Can't complete this ride" }));
          r.status = 3; break;
        case "cancel": {
          if (!(isRider || isDriver) || r.status >= 2) return (context.res = json(409, { error: "Can't cancel this ride" }));
          const { fee, reason } = feeInfo(r, await locsFor(r));
          r.cancels = r.cancels || [];
          if (isRider) {
            r.cancelled = true; r.cancelledBy = "rider"; r.cancelFee = fee;
            r.cancels.push({ by: "rider", fee, reason, at: Date.now() });
            chargeRider = fee;
          } else {
            // Driver backs out: rider goes back to searching for another driver.
            r.cancels.push({ by: "driver", driverId, driverName: r.driver.name, fee, reason, at: Date.now() });
            r.driver = null; r.status = 0; r.acceptedAt = null;
          }
          break;
        }
        default: return (context.res = json(400, { error: "Unknown action" }));
      }
      try { await putRide(r, etag); }
      catch (e) { if (e.statusCode === 412) return (context.res = json(409, { error: "Ride changed, try again" })); throw e; }
      if (chargeRider) await setDue(r.phone, (await getDue(r.phone)) + chargeRider);
      context.res = json(200, view(r, { driverId, token: b.token, locs: await locsFor(r) }));
      return;
    }
    context.res = json(405, { error: "Not allowed" });
  } catch (e) {
    context.log.error(e);
    context.res = json(500, { error: "Server error", detail: String(e.code || e.statusCode || e.name || "") + ": " + String(e.message || "").split("\n")[0].slice(0, 160) });
  }
};
