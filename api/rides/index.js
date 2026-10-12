// AutoSathi rides API (Azure Functions, Node).
// Routes:
//   GET  /api/rides?driverId=..        open rides + this driver's rides (no OTPs)
//   GET  /api/rides/{id}?token=..       one ride; OTP included only with the rider's token
//   POST /api/rides                     create a ride  -> { ride, token }
//   POST /api/rides/{id}/{action}       accept | start | complete | cancel
const crypto = require("crypto");

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TABLE = "rides";
const PK = "ride";
const DAY = 24 * 60 * 60 * 1000;

// ---------- storage: Azure Table Storage, or in-memory if not configured ----------
let client = null, ready = null;
const mem = new Map();
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

// ---------- helpers ----------
const json = (status, body) => ({ status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body });
const clean = (s, n) => String(s ?? "").trim().slice(0, n);
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
// What anyone may see. Phone only goes to the assigned driver; OTP only to the rider.
function view(r, { driverId, token } = {}) {
  const mine = driverId && r.driver && r.driver.id === driverId;
  const out = { id: r.id, city: r.city, from: r.from, to: r.to, km: r.km, fare: r.fare, pay: r.pay,
    name: r.name, status: r.status, cancelled: r.cancelled, at: r.at,
    driver: r.driver ? { name: r.driver.name, auto: r.driver.auto } : null };
  if (mine) out.phone = r.phone;
  if (token && sha(token) === r.tokenHash) { out.otp = r.otp; out.phone = r.phone; }
  return out;
}

module.exports = async function (context, req) {
  const { id, action } = context.bindingData;
  const b = req.body || {};
  try {
    if (req.method === "GET" && !id) {
      const driverId = clean(req.query.driverId, 40);
      const all = await recentRides();
      const list = all.filter(r => (!r.cancelled && r.status === 0) || (driverId && r.driver && r.driver.id === driverId))
        .sort((a, b) => b.at - a.at).slice(0, 50).map(r => view(r, { driverId }));
      context.res = json(200, { rides: list, storage: CONN ? "azure-table" : "memory" });
      return;
    }
    if (req.method === "GET" && id) {
      const got = await getRide(clean(id, 40));
      context.res = got ? json(200, view(got.ride, { token: req.query.token, driverId: clean(req.query.driverId, 40) })) : json(404, { error: "Ride not found" });
      return;
    }
    if (req.method === "POST" && !id) {
      const name = clean(b.name, 40), phone = clean(b.phone, 10);
      if (!name) return (context.res = json(400, { error: "Name is required" }));
      if (!/^[6-9]\d{9}$/.test(phone)) return (context.res = json(400, { error: "Enter a valid 10-digit Indian mobile number" }));
      const km = Number(b.km), fare = Number(b.fare);
      if (!(km > 0 && km < 100) || !(fare >= 30 && fare < 5000)) return (context.res = json(400, { error: "Invalid trip" }));
      const token = crypto.randomBytes(16).toString("hex");
      const ride = { id: Date.now().toString(36) + crypto.randomBytes(2).toString("hex"),
        city: clean(b.city, 30), from: clean(b.from, 60), to: clean(b.to, 60), km, fare,
        pay: b.pay === "UPI" ? "UPI" : "Cash", name, phone, status: 0, cancelled: false,
        otp: String(crypto.randomInt(1000, 10000)), tokenHash: sha(token), at: Date.now(), driver: null };
      await putRide(ride);
      context.res = json(201, { ride: view(ride, { token }), token });
      return;
    }
    if (req.method === "POST" && id && action) {
      const got = await getRide(clean(id, 40));
      if (!got) return (context.res = json(404, { error: "Ride not found" }));
      const { ride: r, etag } = got;
      const driverId = clean(b.driverId, 40);
      const isDriver = driverId && r.driver && r.driver.id === driverId;
      if (r.cancelled) return (context.res = json(409, { error: "Ride was cancelled" }));
      switch (action) {
        case "accept":
          if (r.status !== 0) return (context.res = json(409, { error: "Ride already taken" }));
          if (!driverId || !clean(b.name, 40) || !clean(b.auto, 20)) return (context.res = json(400, { error: "Driver name and auto number required" }));
          r.driver = { id: driverId, name: clean(b.name, 40), auto: clean(b.auto, 20).toUpperCase() }; r.status = 1; break;
        case "start":
          if (!isDriver || r.status !== 1) return (context.res = json(409, { error: "Can't start this ride" }));
          if (String(b.otp) !== r.otp) return (context.res = json(400, { error: "Wrong OTP" }));
          r.status = 2; break;
        case "complete":
          if (!isDriver || r.status !== 2) return (context.res = json(409, { error: "Can't complete this ride" }));
          r.status = 3; break;
        case "cancel":
          if (!(b.token && sha(b.token) === r.tokenHash) || r.status >= 2) return (context.res = json(409, { error: "Can't cancel this ride" }));
          r.cancelled = true; break;
        default: return (context.res = json(400, { error: "Unknown action" }));
      }
      try { await putRide(r, etag); }
      catch (e) { if (e.statusCode === 412) return (context.res = json(409, { error: "Ride changed, try again" })); throw e; }
      context.res = json(200, view(r, { driverId, token: b.token }));
      return;
    }
    context.res = json(405, { error: "Not allowed" });
  } catch (e) {
    context.log.error(e);
    context.res = json(500, { error: "Server error", detail: String(e.code || e.statusCode || e.name || "") + ": " + String(e.message || "").split("\n")[0].slice(0, 160) });
  }
};
