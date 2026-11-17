/**
 * init.js : (re)création complète de la base « festival_live »
 *   - collections + validateurs $jsonSchema
 *   - index
 *   - jeu d'essai (artistes, scènes, concerts sur 3 jours, billets vendus/consommés)
 *
 * Usage :
 *   mongosh "mongodb://localhost:27017" db/init.js
 *   mongosh "mongodb+srv://user:mdp@cluster.mongodb.net" db/init.js   (Atlas)
 *
 * ATTENTION : le script supprime les collections existantes avant de les recréer.
 */
const fdb = db.getSiblingDB("festival_live");

// ---------------------------------------------------------------------------
// 0. Énumérations partagées (statuts, catégories, genres autorisés)
// ---------------------------------------------------------------------------
const GENRES = ["rock", "pop", "electro", "jazz", "hip-hop", "folk", "metal", "reggae"];
const CATEGORIES = ["standard", "vip", "reduced", "early_bird"];
const CONCERT_STATUSES = ["scheduled", "on_sale", "sold_out", "cancelled", "completed"];
const TICKET_STATUSES = ["valid", "used", "cancelled"];

// ---------------------------------------------------------------------------
// 1. Suppression des anciennes collections
// ---------------------------------------------------------------------------
["tickets", "concerts", "stages", "artists"].forEach(n => fdb.getCollection(n).drop());

// ---------------------------------------------------------------------------
// 2. Collections + validateurs $jsonSchema
//    validationAction "error" : la base REFUSE le document invalide.
//    Remarque : un entier JS est stocké en int32 par le driver Node, d'où
//    bsonType "int" pour les compteurs et "number" pour les prix (int ou double).
// ---------------------------------------------------------------------------

// --- artists ---------------------------------------------------------------
fdb.createCollection("artists", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["name", "genres", "country", "createdAt"],
      additionalProperties: false,
      properties: {
        _id: { bsonType: "objectId" },
        name: { bsonType: "string", minLength: 1, maxLength: 100 },
        genres: { bsonType: "array", minItems: 1, uniqueItems: true, items: { enum: GENRES } },
        country: { bsonType: "string", pattern: "^[A-Z]{2}$", description: "code ISO 3166-1 alpha-2" },
        bio: { bsonType: "string", maxLength: 2000 },
        members: {                                   // sous-documents embarqués
          bsonType: "array",
          items: {
            bsonType: "object", required: ["name"], additionalProperties: false,
            properties: { name: { bsonType: "string" }, role: { bsonType: "string" } }
          }
        },
        links: {
          bsonType: "object", additionalProperties: false,
          properties: { website: { bsonType: "string" }, instagram: { bsonType: "string" } }
        },
        createdAt: { bsonType: "date" }
      }
    }
  },
  validationLevel: "strict", validationAction: "error"
});

// --- stages ----------------------------------------------------------------
fdb.createCollection("stages", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["name", "capacity", "type"],
      additionalProperties: false,
      properties: {
        _id: { bsonType: "objectId" },
        name: { bsonType: "string", minLength: 2, maxLength: 80 },
        capacity: { bsonType: "int", minimum: 1, maximum: 100000 },
        type: { enum: ["outdoor", "indoor", "tent"] },
        location: {
          bsonType: "object", required: ["zone"], additionalProperties: false,
          properties: {
            zone: { bsonType: "string" },
            coordinates: { bsonType: "array", minItems: 2, maxItems: 2, items: { bsonType: "number" } }
          }
        },
        equipment: { bsonType: "array", uniqueItems: true, items: { bsonType: "string" } },
        accessiblePMR: { bsonType: "bool" }
      }
    }
  },
  validationLevel: "strict", validationAction: "error"
});

// --- concerts --------------------------------------------------------------
// Le validateur combine $jsonSchema et $expr :
//   - ticketsSold <= capacity : dernier rempart contre la survente
//   - startAt < endAt         : cohérence des dates
fdb.createCollection("concerts", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["artist", "stageId", "startAt", "endAt", "status", "capacity", "ticketsSold", "prices", "minPrice"],
      additionalProperties: false,
      properties: {
        _id: { bsonType: "objectId" },
        artist: {                                    // snapshot embarqué de l'artiste
          bsonType: "object", required: ["_id", "name", "genres"], additionalProperties: false,
          properties: {
            _id: { bsonType: "objectId" },
            name: { bsonType: "string" },
            genres: { bsonType: "array", minItems: 1, items: { enum: GENRES } }
          }
        },
        stageId: { bsonType: "objectId" },           // référence vers stages
        startAt: { bsonType: "date" },
        endAt: { bsonType: "date" },
        status: { enum: CONCERT_STATUSES },
        capacity: { bsonType: "int", minimum: 1 },   // copie de la capacité de la scène
        ticketsSold: { bsonType: "int", minimum: 0 },// compteur (vente atomique)
        prices: {                                    // grille tarifaire embarquée
          bsonType: "array", minItems: 1,
          items: {
            bsonType: "object", required: ["category", "price"], additionalProperties: false,
            properties: {
              category: { enum: CATEGORIES },
              price: { bsonType: "number", minimum: 0, maximum: 500 }
            }
          }
        },
        minPrice: { bsonType: "number", minimum: 0, maximum: 500 }, // dénormalisé (tri/filtre)
        description: { bsonType: "string", maxLength: 2000 },
        history: {                                   // bonus : historique des modifications
          bsonType: "array",
          items: {
            bsonType: "object", required: ["at", "action"], additionalProperties: false,
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
    $expr: { $and: [{ $lte: ["$ticketsSold", "$capacity"] }, { $lt: ["$startAt", "$endAt"] }] }
  },
  validationLevel: "strict", validationAction: "error"
});

// --- tickets ---------------------------------------------------------------
fdb.createCollection("tickets", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["concertId", "code", "buyer", "category", "price", "purchasedAt", "status"],
      additionalProperties: false,
      properties: {
        _id: { bsonType: "objectId" },
        concertId: { bsonType: "objectId" },         // référence vers concerts
        code: { bsonType: "string", pattern: "^FL-[A-Z0-9]{8}$" },
        buyer: {                                     // acheteur embarqué
          bsonType: "object", required: ["firstName", "lastName", "email"], additionalProperties: false,
          properties: {
            firstName: { bsonType: "string", minLength: 1 },
            lastName: { bsonType: "string", minLength: 1 },
            email: { bsonType: "string", pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" }
          }
        },
        category: { enum: CATEGORIES },
        price: { bsonType: "number", minimum: 0, maximum: 500 }, // prix payé (figé à l'achat)
        purchasedAt: { bsonType: "date" },
        status: { enum: TICKET_STATUSES },
        usedAt: { bsonType: "date" }
      }
    }
  },
  validationLevel: "strict", validationAction: "error"
});

// ---------------------------------------------------------------------------
// 3. Index (chacun sert une requête précise de l'application)
// ---------------------------------------------------------------------------
fdb.artists.createIndex({ name: 1 }, { name: "idx_artist_name", unique: true });
fdb.artists.createIndex({ genres: 1 }, { name: "idx_artist_genres" });          // multikey
fdb.stages.createIndex({ name: 1 }, { name: "idx_stage_name", unique: true });

// Programme : filtre par statut + tri/période par date  -> COMPOSÉ
fdb.concerts.createIndex({ status: 1, startAt: 1 }, { name: "idx_concert_status_date" });
// Programme d'une scène triée par date                    -> COMPOSÉ
fdb.concerts.createIndex({ stageId: 1, startAt: 1 }, { name: "idx_concert_stage_date" });
// Filtre par genre + tri par date                          -> COMPOSÉ multikey
fdb.concerts.createIndex({ "artist.genres": 1, startAt: 1 }, { name: "idx_concert_genre_date" });
// Filtre / tri par tarif
fdb.concerts.createIndex({ minPrice: 1 }, { name: "idx_concert_minprice" });
// Recherche texte libre sur le nom de l'artiste (pas de stemming pour des noms propres)
fdb.concerts.createIndex({ "artist.name": "text" }, { name: "idx_concert_artist_text", default_language: "none" });

// Contrôle d'entrée : recherche par code (unique = intégrité)
fdb.tickets.createIndex({ code: 1 }, { name: "idx_ticket_code", unique: true });
// Billets d'un concert selon leur statut (contrôle, remplissage, stats)
fdb.tickets.createIndex({ concertId: 1, status: 1 }, { name: "idx_ticket_concert_status" });
// Billets d'un acheteur
fdb.tickets.createIndex({ "buyer.email": 1 }, { name: "idx_ticket_buyer_email" });
// Tendance des ventes jour par jour
fdb.tickets.createIndex({ purchasedAt: 1 }, { name: "idx_ticket_purchased" });

// ---------------------------------------------------------------------------
// 4. Jeu d'essai : festival fictif « Volcans Live », Le Puy-en-Velay, 9-11 juillet 2027
// ---------------------------------------------------------------------------
// Générateur pseudo-aléatoire à graine fixe -> jeu d'essai reproductible
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
].map(a => ({ ...a, createdAt: created }));
const artistIds = Object.values(fdb.artists.insertMany(artistsData).insertedIds);

const stagesData = [
  { name: "Grande Scène", capacity: 800, type: "outdoor", location: { zone: "Esplanade", coordinates: [3.8845, 45.0436] }, equipment: ["sonorisation 20kW", "écran LED"], accessiblePMR: true },
  { name: "Scène Volcan", capacity: 400, type: "outdoor", location: { zone: "Parc" }, equipment: ["sonorisation 10kW"], accessiblePMR: true },
  { name: "Chapiteau Jazz", capacity: 200, type: "tent", location: { zone: "Jardin" }, equipment: ["piano", "sonorisation 5kW"], accessiblePMR: false }
];
const stageIds = Object.values(fdb.stages.insertMany(stagesData).insertedIds);

// Heure locale (Paris, été = UTC+2) -> Date UTC
const at = (d, h, m = 0) => new Date(Date.UTC(2027, 6, 9 + d, h - 2, m));
// a = artiste, s = scène, d = jour (0..2), h/m = heure, dur = durée (min), base = prix standard
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

const concerts = plan.map(p => {
  const a = artistsData[p.a], st = stagesData[p.s], start = at(p.d, p.h, p.m);
  const prices = [
    { category: "standard", price: p.base },
    { category: "vip", price: Math.round(p.base * 2.2) },
    { category: "reduced", price: Math.round(p.base * 0.7) }
  ];
  const history = [{ at: new Date("2027-01-15T10:00:00Z"), action: "created", by: "admin" }];
  if (p.status === "cancelled") {
    history.push({ at: new Date("2027-05-02T08:30:00Z"), action: "status_changed", by: "admin", details: { from: "on_sale", to: "cancelled" } });
  }
  return {
    artist: { _id: artistIds[p.a], name: a.name, genres: a.genres },
    stageId: stageIds[p.s],
    startAt: start,
    endAt: new Date(start.getTime() + p.dur * 60000),
    status: p.status,
    capacity: st.capacity,
    ticketsSold: Math.round(st.capacity * p.fill),
    prices,
    minPrice: Math.min(...prices.map(x => x.price)),
    description: `${a.name} en concert sur la ${st.name}.`,
    history
  };
});
const concertIds = Object.values(fdb.concerts.insertMany(concerts).insertedIds);

// Billets : exactement ticketsSold billets par concert (compteur cohérent)
const FIRST = ["lea", "hugo", "emma", "louis", "chloe", "jules", "manon", "adam", "ines", "paul"];
const LAST = ["martin", "bernard", "dubois", "thomas", "robert", "petit", "durand", "leroy", "moreau", "simon"];
let counter = 0;
const tickets = [];
concerts.forEach((c, i) => {
  for (let k = 0; k < c.ticketsSold; k++) {
    counter++;
    const r = rnd();
    const category = r < 0.70 ? "standard" : r < 0.85 ? "vip" : "reduced";
    // Démo du contrôle d'entrée : ~40 % des billets du jour 1 sont déjà « scannés »
    const used = c.startAt < new Date("2027-07-10T00:00:00Z") && rnd() < 0.4;
    const first = FIRST[counter % FIRST.length];
    const last = LAST[Math.floor(counter / FIRST.length) % LAST.length];
    const t = {
      concertId: concertIds[i],
      // Code séquentiel pour le jeu d'essai ; l'API générera des codes aléatoires (crypto)
      code: "FL-" + (Math.pow(36, 7) + counter).toString(36).toUpperCase(),
      buyer: { firstName: first, lastName: last, email: `${first}.${last}${counter}@example.com` },
      category,
      price: c.prices.find(p => p.category === category).price,
      purchasedAt: new Date(Date.UTC(2027, 2, 1) + Math.floor(rnd() * 120 * 86400000)),
      status: used ? "used" : "valid"
    };
    if (used) t.usedAt = new Date(c.startAt.getTime() - 30 * 60000);
    tickets.push(t);
  }
});
for (let i = 0; i < tickets.length; i += 1000) fdb.tickets.insertMany(tickets.slice(i, i + 1000));

print("Base « festival_live » créée :");
["artists", "stages", "concerts", "tickets"].forEach(n => print(`  ${n.padEnd(9)} ${fdb.getCollection(n).countDocuments()} documents`));
