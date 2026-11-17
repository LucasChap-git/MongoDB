/**
 * (Re)création de la base « festival_live » avec une seule collection.
 * Chaque document de concerts contient le concert, son artiste, sa scène
 * et tous ses billets.
 *
 * Usage : mongosh "mongodb://localhost:27017" db/init.js
 *
 * ATTENTION : le script supprime les anciennes collections du projet.
 */
const fdb = db.getSiblingDB("festival_live");

const GENRES = ["rock", "pop", "electro", "jazz", "hip-hop", "folk", "metal", "reggae"];
const CATEGORIES = ["standard", "vip", "reduced", "early_bird"];
const CONCERT_STATUSES = ["scheduled", "on_sale", "sold_out", "cancelled", "completed"];
const TICKET_STATUSES = ["valid", "used", "cancelled"];

["tickets", "concerts", "stages", "artists"].forEach(name => fdb.getCollection(name).drop());

fdb.createCollection("concerts", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["artist", "stage", "startAt", "endAt", "status", "capacity", "ticketsSold", "tickets", "prices", "minPrice"],
      additionalProperties: false,
      properties: {
        _id: { bsonType: "objectId" },
        artist: {
          bsonType: "object",
          required: ["_id", "name", "genres", "country", "createdAt"],
          additionalProperties: false,
          properties: {
            _id: { bsonType: "objectId" },
            name: { bsonType: "string", minLength: 1, maxLength: 100 },
            genres: { bsonType: "array", minItems: 1, uniqueItems: true, items: { enum: GENRES } },
            country: { bsonType: "string", pattern: "^[A-Z]{2}$" },
            bio: { bsonType: "string", maxLength: 2000 },
            members: {
              bsonType: "array",
              items: {
                bsonType: "object",
                required: ["name"],
                additionalProperties: false,
                properties: {
                  name: { bsonType: "string" },
                  role: { bsonType: "string" }
                }
              }
            },
            links: {
              bsonType: "object",
              additionalProperties: false,
              properties: {
                website: { bsonType: "string" },
                instagram: { bsonType: "string" }
              }
            },
            createdAt: { bsonType: "date" }
          }
        },
        stage: {
          bsonType: "object",
          required: ["_id", "name", "capacity", "type"],
          additionalProperties: false,
          properties: {
            _id: { bsonType: "objectId" },
            name: { bsonType: "string", minLength: 2, maxLength: 80 },
            capacity: { bsonType: "int", minimum: 1, maximum: 100000 },
            type: { enum: ["outdoor", "indoor", "tent"] },
            location: {
              bsonType: "object",
              required: ["zone"],
              additionalProperties: false,
              properties: {
                zone: { bsonType: "string" },
                coordinates: { bsonType: "array", minItems: 2, maxItems: 2, items: { bsonType: "number" } }
              }
            },
            equipment: { bsonType: "array", uniqueItems: true, items: { bsonType: "string" } },
            accessiblePMR: { bsonType: "bool" }
          }
        },
        startAt: { bsonType: "date" },
        endAt: { bsonType: "date" },
        status: { enum: CONCERT_STATUSES },
        capacity: { bsonType: "int", minimum: 1 },
        ticketsSold: { bsonType: "int", minimum: 0 },
        tickets: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["code", "buyer", "category", "price", "purchasedAt", "status"],
            additionalProperties: false,
            properties: {
              code: { bsonType: "string", pattern: "^FL-[A-Z0-9]{8}$" },
              buyer: {
                bsonType: "object",
                required: ["firstName", "lastName", "email"],
                additionalProperties: false,
                properties: {
                  firstName: { bsonType: "string", minLength: 1 },
                  lastName: { bsonType: "string", minLength: 1 },
                  email: { bsonType: "string", pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" }
                }
              },
              category: { enum: CATEGORIES },
              price: { bsonType: "number", minimum: 0, maximum: 500 },
              purchasedAt: { bsonType: "date" },
              status: { enum: TICKET_STATUSES },
              usedAt: { bsonType: "date" }
            }
          }
        },
        prices: {
          bsonType: "array",
          minItems: 1,
          items: {
            bsonType: "object",
            required: ["category", "price"],
            additionalProperties: false,
            properties: {
              category: { enum: CATEGORIES },
              price: { bsonType: "number", minimum: 0, maximum: 500 }
            }
          }
        },
        minPrice: { bsonType: "number", minimum: 0, maximum: 500 },
        description: { bsonType: "string", maxLength: 2000 },
        history: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["at", "action"],
            additionalProperties: false,
            properties: {
              at: { bsonType: "date" },
              action: { enum: ["created", "updated", "status_changed", "price_changed"] },
              by: { bsonType: "string" },
              details: { bsonType: "object" }
            }
          }
        }
      }
    },
    $expr: {
      $and: [
        { $lte: ["$ticketsSold", "$capacity"] },
        { $eq: ["$ticketsSold", { $size: "$tickets" }] },
        { $eq: ["$capacity", "$stage.capacity"] },
        { $lt: ["$startAt", "$endAt"] }
      ]
    }
  },
  validationLevel: "strict",
  validationAction: "error"
});

fdb.concerts.createIndex({ status: 1, startAt: 1 }, { name: "idx_concert_status_date" });
fdb.concerts.createIndex({ "stage._id": 1, startAt: 1 }, { name: "idx_concert_stage_date" });
fdb.concerts.createIndex({ "artist.genres": 1, startAt: 1 }, { name: "idx_concert_genre_date" });
fdb.concerts.createIndex({ minPrice: 1 }, { name: "idx_concert_minprice" });
fdb.concerts.createIndex({ "artist.name": "text" }, { name: "idx_concert_artist_text", default_language: "none" });
fdb.concerts.createIndex({ "tickets.code": 1 }, { name: "idx_ticket_code", unique: true, sparse: true });
fdb.concerts.createIndex({ "tickets.status": 1 }, { name: "idx_ticket_status" });
fdb.concerts.createIndex({ "tickets.buyer.email": 1 }, { name: "idx_ticket_buyer_email" });
fdb.concerts.createIndex({ "tickets.purchasedAt": 1 }, { name: "idx_ticket_purchased" });

let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const created = new Date("2027-01-10T09:00:00Z");
const artistsData = [
  { name: "Les Cratères", genres: ["rock"], country: "FR", bio: "Rock volcanique né sur les pentes du Velay.", members: [{ name: "Jules Bard", role: "chant" }, { name: "Mia Roc", role: "guitare" }] },
  { name: "Nova Lune", genres: ["pop"], country: "FR", bio: "Pop lumineuse et synthés rêveurs." },
  { name: "Quartet Velay", genres: ["jazz"], country: "FR", bio: "Jazz de chambre, standards revisités.", members: [{ name: "Anna Sax", role: "saxophone" }] },
  { name: "Basalte", genres: ["electro"], country: "BE", bio: "Techno minérale, basses profondes." },
  { name: "MC Sucs", genres: ["hip-hop"], country: "FR", bio: "Rap des hauts plateaux." },
  { name: "Fanfare des Orgues", genres: ["folk"], country: "FR", bio: "Fanfare folk et cuivres déchaînés." },
  { name: "Magma Rising", genres: ["metal"], country: "DE", bio: "Metal progressif, riffs en fusion." },
  { name: "Dub Vellave", genres: ["reggae"], country: "FR", bio: "Reggae-dub, sound system artisanal." },
  { name: "Lady Dentelle", genres: ["pop", "electro"], country: "FR", bio: "Électro-pop dentelée." },
  { name: "Cendres", genres: ["metal", "rock"], country: "NO", bio: "Rock noir venu du nord." },
  { name: "Orbite 43", genres: ["electro"], country: "FR", bio: "Live electro modulaire." },
  { name: "Trio Chaudron", genres: ["jazz", "folk"], country: "FR", bio: "Jazz manouche et folk des volcans." }
].map(artist => ({ ...artist, _id: new ObjectId(), createdAt: created }));

const stagesData = [
  { name: "Grande Scène", capacity: 800, type: "outdoor", location: { zone: "Esplanade", coordinates: [3.8845, 45.0436] }, equipment: ["sonorisation 20kW", "écran LED"], accessiblePMR: true },
  { name: "Scène Volcan", capacity: 400, type: "outdoor", location: { zone: "Parc" }, equipment: ["sonorisation 10kW"], accessiblePMR: true },
  { name: "Chapiteau Jazz", capacity: 200, type: "tent", location: { zone: "Jardin" }, equipment: ["piano", "sonorisation 5kW"], accessiblePMR: false }
].map(stage => ({ ...stage, _id: new ObjectId() }));

const at = (day, hour, minute = 0) => new Date(Date.UTC(2027, 6, 9 + day, hour - 2, minute));
const plan = [
  { a: 0, s: 0, d: 0, h: 21, m: 0, dur: 90, base: 40, fill: 0.85, status: "on_sale" },
  { a: 1, s: 1, d: 0, h: 19, m: 0, dur: 75, base: 25, fill: 0.60, status: "on_sale" },
  { a: 2, s: 2, d: 0, h: 20, m: 0, dur: 80, base: 20, fill: 0.50, status: "on_sale" },
  { a: 3, s: 0, d: 1, h: 22, m: 0, dur: 90, base: 45, fill: 1.00, status: "sold_out" },
  { a: 4, s: 1, d: 1, h: 20, m: 30, dur: 70, base: 25, fill: 0.70, status: "on_sale" },
  { a: 5, s: 2, d: 1, h: 18, m: 0, dur: 60, base: 15, fill: 0.40, status: "on_sale" },
  { a: 6, s: 0, d: 2, h: 21, m: 30, dur: 90, base: 42, fill: 0.90, status: "on_sale" },
  { a: 7, s: 1, d: 2, h: 19, m: 30, dur: 75, base: 22, fill: 0.55, status: "on_sale" },
  { a: 8, s: 0, d: 1, h: 19, m: 30, dur: 80, base: 35, fill: 0.75, status: "on_sale" },
  { a: 9, s: 1, d: 2, h: 22, m: 0, dur: 80, base: 30, fill: 0.00, status: "cancelled" },
  { a: 10, s: 2, d: 2, h: 21, m: 0, dur: 70, base: 18, fill: 0.65, status: "on_sale" },
  { a: 11, s: 2, d: 0, h: 22, m: 0, dur: 70, base: 18, fill: 0.00, status: "scheduled" }
];

const concerts = plan.map(item => {
  const artist = artistsData[item.a];
  const stage = stagesData[item.s];
  const startAt = at(item.d, item.h, item.m);
  const prices = [
    { category: "standard", price: item.base },
    { category: "vip", price: Math.round(item.base * 2.2) },
    { category: "reduced", price: Math.round(item.base * 0.7) }
  ];
  const history = [{ at: new Date("2027-01-15T10:00:00Z"), action: "created", by: "admin" }];
  if (item.status === "cancelled") {
    history.push({ at: new Date("2027-05-02T08:30:00Z"), action: "status_changed", by: "admin", details: { from: "on_sale", to: "cancelled" } });
  }
  const capacity = stage.capacity;
  return {
    artist,
    stage,
    startAt,
    endAt: new Date(startAt.getTime() + item.dur * 60000),
    status: item.status,
    capacity,
    ticketsSold: Math.round(capacity * item.fill),
    tickets: [],
    prices,
    minPrice: Math.min(...prices.map(price => price.price)),
    description: `${artist.name} en concert sur la ${stage.name}.`,
    history
  };
});

const FIRST = ["lea", "hugo", "emma", "louis", "chloe", "jules", "manon", "adam", "ines", "paul"];
const LAST = ["martin", "bernard", "dubois", "thomas", "robert", "petit", "durand", "leroy", "moreau", "simon"];
let counter = 0;
concerts.forEach(concert => {
  for (let i = 0; i < concert.ticketsSold; i++) {
    counter++;
    const r = rnd();
    const category = r < 0.70 ? "standard" : r < 0.85 ? "vip" : "reduced";
    const used = concert.startAt < new Date("2027-07-10T00:00:00Z") && rnd() < 0.4;
    const firstName = FIRST[counter % FIRST.length];
    const lastName = LAST[Math.floor(counter / FIRST.length) % LAST.length];
    const ticket = {
      code: "FL-" + (Math.pow(36, 7) + counter).toString(36).toUpperCase(),
      buyer: { firstName, lastName, email: `${firstName}.${lastName}${counter}@example.com` },
      category,
      price: concert.prices.find(price => price.category === category).price,
      purchasedAt: new Date(Date.UTC(2027, 2, 1) + Math.floor(rnd() * 120 * 86400000)),
      status: used ? "used" : "valid"
    };
    if (used) ticket.usedAt = new Date(concert.startAt.getTime() - 30 * 60000);
    concert.tickets.push(ticket);
  }
});

fdb.concerts.insertMany(concerts);
print("Base « festival_live » créée :");
print(`  concerts   ${fdb.concerts.countDocuments()} documents`);
print(`  billets    ${fdb.concerts.aggregate([{ $unwind: "$tickets" }, { $count: "total" }]).toArray()[0].total} intégrés aux concerts`);
