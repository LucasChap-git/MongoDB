/**
 * Démonstrations MongoDB : validations, vente atomique, index et agrégations.
 * Usage : mongosh "<URI>" db/tests.js (après db/init.js)
 */
const fdb = db.getSiblingDB("festival_live");

print("\n=== 0. Une seule collection ===");
const collectionNames = fdb.getCollectionNames();
if (collectionNames.length !== 1) throw new Error("La base doit contenir une seule collection");
if (collectionNames[0] !== "concerts") throw new Error("La collection attendue est concerts");
print("  concerts contient les concerts, artistes, scènes et billets");

print("\n=== 1. Validations $jsonSchema ===");
function expectRejected(label, fn) {
  let rejected = false;
  try {
    fn();
  } catch (e) {
    rejected = true;
    print(`  ✔ refusé : ${label} [code ${e.code}]`);
  }
  if (!rejected) throw new Error("Document invalide accepté : " + label);
}

const tpl = fdb.concerts.findOne({ status: "on_sale" });
const emptyConcert = { ...tpl, tickets: [], ticketsSold: 0 };
delete emptyConcert._id;
expectRejected("statut inconnu", () => fdb.concerts.insertOne({ ...emptyConcert, status: "foo" }));
expectRejected("prix négatif", () => fdb.concerts.insertOne({ ...emptyConcert, prices: [{ category: "standard", price: -5 }] }));
expectRejected("catégorie de billet inconnue", () => fdb.concerts.insertOne({ ...emptyConcert, prices: [{ category: "gratuit", price: 0 }] }));
expectRejected("ticketsSold supérieur à la capacité", () => fdb.concerts.insertOne({ ...emptyConcert, ticketsSold: emptyConcert.capacity + 1 }));
expectRejected("fin avant début", () => fdb.concerts.insertOne({ ...emptyConcert, endAt: new Date(emptyConcert.startAt.getTime() - 1000) }));
expectRejected("date en chaîne de caractères", () => fdb.concerts.insertOne({ ...emptyConcert, startAt: "2027-07-09" }));
expectRejected("champ inconnu", () => fdb.concerts.insertOne({ ...emptyConcert, foo: 1 }));
expectRejected("capacité de scène négative", () => fdb.concerts.insertOne({
  ...emptyConcert,
  stage: { ...emptyConcert.stage, capacity: -3 }
}));
expectRejected("genre d'artiste inconnu", () => fdb.concerts.insertOne({
  ...emptyConcert,
  artist: { ...emptyConcert.artist, genres: ["schlager"] }
}));

const invalidEmailTicket = {
  code: "FL-INVALID1",
  buyer: { firstName: "Test", lastName: "Demo", email: "pas-un-email" },
  category: "standard",
  price: 10,
  purchasedAt: new Date(),
  status: "valid"
};
expectRejected("email acheteur invalide", () => fdb.concerts.insertOne({
  ...emptyConcert,
  tickets: [invalidEmailTicket],
  ticketsSold: 1
}));

const ticketSource = fdb.concerts.findOne({ "tickets.0": { $exists: true } });
const duplicateCodeConcert = { ...ticketSource };
delete duplicateCodeConcert._id;
expectRejected("code de billet déjà utilisé dans un autre concert", () => fdb.concerts.insertOne(duplicateCodeConcert));

print("\n=== 2. Vente atomique / capacité ===");
const randomCode = () => "FL-" + Array.from(
  { length: 8 },
  () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]
).join("");

function sellTicket(concertId, buyer, category) {
  const concert = fdb.concerts.findOne({ _id: concertId });
  if (!concert) return { ok: false, http: 404, error: "concert introuvable" };
  const tarif = concert.prices.find(price => price.category === category);
  if (!tarif) return { ok: false, http: 400, error: "catégorie inconnue pour ce concert" };

  const ticket = {
    code: randomCode(),
    buyer,
    category,
    price: tarif.price,
    purchasedAt: new Date(),
    status: "valid"
  };
  const result = fdb.concerts.updateOne(
    {
      _id: concertId,
      status: "on_sale",
      tickets: { $not: { $elemMatch: { code: ticket.code } } },
      $expr: { $lt: ["$ticketsSold", "$capacity"] }
    },
    { $inc: { ticketsSold: 1 }, $push: { tickets: ticket } }
  );
  if (result.modifiedCount === 0) return { ok: false, http: 409, error: "concert complet ou vente fermée" };

  fdb.concerts.updateOne(
    { _id: concertId, status: "on_sale", $expr: { $gte: ["$ticketsSold", "$capacity"] } },
    { $set: { status: "sold_out" } }
  );
  return { ok: true, http: 201, code: ticket.code };
}

const testConcert = {
  ...emptyConcert,
  capacity: 2,
  stage: { ...emptyConcert.stage, capacity: 2 },
  ticketsSold: 0,
  tickets: [],
  status: "on_sale"
};
const testId = fdb.concerts.insertOne(testConcert).insertedId;
const buyer = { firstName: "Test", lastName: "Demo", email: "test@example.com" };
try {
  const firstSale = sellTicket(testId, buyer, "standard");
  const secondSale = sellTicket(testId, buyer, "standard");
  const thirdSale = sellTicket(testId, buyer, "standard");
  print("  ventes 1 et 2 :", JSON.stringify(firstSale), JSON.stringify(secondSale));
  print("  vente 3 (capacité atteinte) :", JSON.stringify(thirdSale));
  const soldConcert = fdb.concerts.findOne({ _id: testId });
  if (soldConcert.tickets.length !== 2) throw new Error("Deux billets doivent être intégrés au concert");
  if (soldConcert.status !== "sold_out") throw new Error("Le concert doit être complet");
  if (thirdSale.ok) throw new Error("La troisième vente doit être refusée");
} finally {
  fdb.concerts.deleteOne({ _id: testId });
}

print("\n=== 3. explain() avant / après index ===");
function plan(label, cursor) {
  const explain = cursor.explain("executionStats");
  const stats = explain.executionStats;
  const strategy = JSON.stringify(explain.queryPlanner.winningPlan).includes("COLLSCAN") ? "COLLSCAN" : "IXSCAN";
  print(`  ${label.padEnd(8)} ${strategy} | documents examinés=${stats.totalDocsExamined} | clés examinées=${stats.totalKeysExamined} | retournés=${stats.nReturned} | ${stats.executionTimeMillis} ms`);
}

const email = fdb.concerts.findOne({ "tickets.0": { $exists: true } }).tickets[0].buyer.email;
const ticketsUsed = () => fdb.concerts.find({ "tickets.status": "used" });
const ticketByEmail = () => fdb.concerts.find({ "tickets.buyer.email": email });
fdb.concerts.dropIndex("idx_ticket_status");
fdb.concerts.dropIndex("idx_ticket_buyer_email");
print(" Requête A : concerts avec au moins un billet scanné");
plan("AVANT", ticketsUsed());
print(" Requête B : concert d'un acheteur { tickets.buyer.email }");
plan("AVANT", ticketByEmail());

fdb.concerts.createIndex({ "tickets.status": 1 }, { name: "idx_ticket_status" });
fdb.concerts.createIndex({ "tickets.buyer.email": 1 }, { name: "idx_ticket_buyer_email" });
print(" Après création des index :");
plan("A APRÈS", ticketsUsed());
plan("B APRÈS", ticketByEmail());

print("\n=== 4. Tableau de bord ===");
const revenueStatuses = ["valid", "used"];

const recettesParJourEtScene = [
  { $unwind: "$tickets" },
  { $match: { "tickets.status": { $in: revenueStatuses } } },
  {
    $group: {
      _id: {
        day: { $dateToString: { format: "%Y-%m-%d", date: "$startAt", timezone: "Europe/Paris" } },
        stage: "$stage.name"
      },
      revenue: { $sum: "$tickets.price" },
      tickets: { $sum: 1 }
    }
  },
  { $project: { _id: 0, day: "$_id.day", stage: "$_id.stage", revenue: 1, tickets: 1 } },
  { $sort: { day: 1, stage: 1 } }
];
print("-- Recettes par jour et par scène");
fdb.concerts.aggregate(recettesParJourEtScene).forEach(printjson);

const remplissageParScene = [
  { $match: { status: { $ne: "cancelled" } } },
  {
    $group: {
      _id: "$stage.name",
      sold: { $sum: "$ticketsSold" },
      capacity: { $sum: "$capacity" }
    }
  },
  {
    $project: {
      _id: 0,
      stage: "$_id",
      sold: 1,
      capacity: 1,
      fillRate: { $round: [{ $multiply: [{ $divide: ["$sold", "$capacity"] }, 100] }, 1] }
    }
  },
  { $sort: { fillRate: -1 } }
];
print("-- Taux de remplissage par scène (%)");
fdb.concerts.aggregate(remplissageParScene).forEach(printjson);

const topArtistes = [
  {
    $group: {
      _id: "$artist._id",
      artist: { $first: "$artist.name" },
      tickets: { $sum: "$ticketsSold" }
    }
  },
  { $sort: { tickets: -1 } },
  { $limit: 5 },
  { $project: { _id: 0, artist: 1, tickets: 1 } }
];
print("-- Top 5 artistes");
fdb.concerts.aggregate(topArtistes).forEach(printjson);

const recettesParCategorie = [
  { $unwind: "$tickets" },
  { $match: { "tickets.status": { $in: revenueStatuses } } },
  {
    $group: {
      _id: "$tickets.category",
      revenue: { $sum: "$tickets.price" },
      tickets: { $sum: 1 }
    }
  },
  { $sort: { revenue: -1 } }
];
print("-- Recettes par catégorie de billet");
fdb.concerts.aggregate(recettesParCategorie).forEach(printjson);

const tendanceVentes = [
  { $unwind: "$tickets" },
  { $match: { "tickets.status": { $in: revenueStatuses } } },
  {
    $group: {
      _id: { $dateToString: { format: "%Y-%m", date: "$tickets.purchasedAt" } },
      tickets: { $sum: 1 },
      revenue: { $sum: "$tickets.price" }
    }
  },
  { $sort: { _id: 1 } }
];
print("-- Tendance des ventes par mois");
fdb.concerts.aggregate(tendanceVentes).forEach(printjson);
