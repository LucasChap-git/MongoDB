/**
 * tests.js : démonstrations à montrer au correcteur
 *   1. les validateurs refusent bien les documents invalides
 *   2. la vente atomique empêche la survente
 *   3. comparaison explain() avant / après indexation
 *   4. pipelines d'agrégation du tableau de bord
 *
 * Usage : mongosh "<URI>" db/tests.js   (après db/init.js)
 */
const fdb = db.getSiblingDB("festival_live");

// ===========================================================================
// 1. Validateurs : chaque insertion ci-dessous DOIT être refusée
// ===========================================================================
print("\n=== 1. Validateurs $jsonSchema ===");
function expectRejected(label, fn) {
  try { fn(); print("  ✘ ACCEPTÉ (anormal) : " + label); }
  catch (e) { print(`  ✔ refusé : ${label}  [code ${e.code}]`); }
}
const tpl = fdb.concerts.findOne({ status: "on_sale" });
delete tpl._id;
expectRejected("statut inconnu", () => fdb.concerts.insertOne({ ...tpl, status: "foo" }));
expectRejected("prix négatif", () => fdb.concerts.insertOne({ ...tpl, prices: [{ category: "standard", price: -5 }] }));
expectRejected("catégorie de billet inconnue", () => fdb.concerts.insertOne({ ...tpl, prices: [{ category: "gratuit", price: 0 }] }));
expectRejected("ticketsSold > capacity", () => fdb.concerts.insertOne({ ...tpl, ticketsSold: tpl.capacity + 1 }));
expectRejected("fin avant début", () => fdb.concerts.insertOne({ ...tpl, endAt: new Date(tpl.startAt.getTime() - 1000) }));
expectRejected("date en chaîne de caractères", () => fdb.concerts.insertOne({ ...tpl, startAt: "2027-07-09" }));
expectRejected("champ inconnu", () => fdb.concerts.insertOne({ ...tpl, foo: 1 }));
expectRejected("champ obligatoire manquant", () => { const x = { ...tpl }; delete x.stageId; fdb.concerts.insertOne(x); });
expectRejected("genre d'artiste inconnu", () => fdb.artists.insertOne({ name: "X", genres: ["schlager"], country: "FR", createdAt: new Date() }));
expectRejected("capacité de scène négative", () => fdb.stages.insertOne({ name: "Test", capacity: -3, type: "indoor" }));
const tk = fdb.tickets.findOne(); delete tk._id;
expectRejected("code de billet dupliqué (index unique)", () => fdb.tickets.insertOne(tk));
expectRejected("email acheteur invalide", () => fdb.tickets.insertOne({ ...tk, code: "FL-ZZZZZZZZ", buyer: { ...tk.buyer, email: "pas-un-email" } }));

// ===========================================================================
// 2. Vente atomique : la condition de capacité est DANS le filtre de l'update,
//    donc deux ventes simultanées ne peuvent pas dépasser la capacité
//    (pas besoin de transaction -> fonctionne aussi sur un MongoDB local standalone).
// ===========================================================================
print("\n=== 2. Vente atomique / capacité ===");
const randomCode = () => "FL-" + Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

function sellTicket(concertId, buyer, category) {
  const concert = fdb.concerts.findOne({ _id: concertId });
  if (!concert) return { ok: false, http: 404, error: "concert introuvable" };
  const tarif = concert.prices.find(p => p.category === category);
  if (!tarif) return { ok: false, http: 400, error: "catégorie inconnue pour ce concert" };

  // 1) Réservation atomique d'une place
  const r = fdb.concerts.updateOne(
    { _id: concertId, status: "on_sale", $expr: { $lt: ["$ticketsSold", "$capacity"] } },
    { $inc: { ticketsSold: 1 } }
  );
  if (r.modifiedCount === 0) return { ok: false, http: 409, error: "concert complet ou vente fermée" };

  // 2) Création du billet (compensation si l'insertion échoue)
  const ticket = { concertId, code: randomCode(), buyer, category, price: tarif.price, purchasedAt: new Date(), status: "valid" };
  try { fdb.tickets.insertOne(ticket); }
  catch (e) { fdb.concerts.updateOne({ _id: concertId }, { $inc: { ticketsSold: -1 } }); throw e; }

  // 3) Dernière place vendue -> sold_out
  fdb.concerts.updateOne({ _id: concertId, status: "on_sale", $expr: { $gte: ["$ticketsSold", "$capacity"] } }, { $set: { status: "sold_out" } });
  return { ok: true, http: 201, code: ticket.code };
}

// Concert de test à 2 places
const testConcert = { ...tpl, capacity: 2, ticketsSold: 0, status: "on_sale" };
const testId = fdb.concerts.insertOne(testConcert).insertedId;
const buyer = { firstName: "Test", lastName: "Demo", email: "test@example.com" };
[1, 2, 3].forEach(n => print(`  vente n°${n} (capacité 2) :`, JSON.stringify(sellTicket(testId, buyer, "standard"))));
print("  statut final du concert de test :", fdb.concerts.findOne({ _id: testId }).status);
fdb.tickets.deleteMany({ concertId: testId });
fdb.concerts.deleteOne({ _id: testId });                       // nettoyage

// ===========================================================================
// 3. explain() avant / après indexation
// ===========================================================================
print("\n=== 3. explain() : avant / après index ===");
function plan(label, cursor) {
  const e = cursor.explain("executionStats"), s = e.executionStats;
  const strat = JSON.stringify(e.queryPlanner.winningPlan).includes("COLLSCAN") ? "COLLSCAN" : "IXSCAN ";
  print(`  ${label.padEnd(8)} ${strat} | docs examinés=${String(s.totalDocsExamined).padStart(5)} | clés examinées=${String(s.totalKeysExamined).padStart(4)} | retournés=${String(s.nReturned).padStart(4)} | ${s.executionTimeMillis} ms`);
}
const cid = fdb.concerts.findOne({ "artist.name": "Les Cratères" })._id;
const email = fdb.tickets.findOne().buyer.email;
const q1 = () => fdb.tickets.find({ concertId: cid, status: "used" });
const q2 = () => fdb.tickets.find({ "buyer.email": email });

fdb.tickets.dropIndex("idx_ticket_concert_status");
fdb.tickets.dropIndex("idx_ticket_buyer_email");
print(" Requête A : billets scannés d'un concert { concertId, status }");
plan("AVANT", q1());
print(" Requête B : billets d'un acheteur { buyer.email }");
plan("AVANT", q2());

fdb.tickets.createIndex({ concertId: 1, status: 1 }, { name: "idx_ticket_concert_status" });
fdb.tickets.createIndex({ "buyer.email": 1 }, { name: "idx_ticket_buyer_email" });
print(" Après création des index :");
plan("A APRÈS", q1());
plan("B APRÈS", q2());

// ===========================================================================
// 4. Pipelines d'agrégation du tableau de bord (à reprendre dans l'API)
// ===========================================================================
print("\n=== 4. Tableau de bord ===");
const countsRevenue = ["valid", "used"];                          // un billet annulé ne rapporte rien

// 4.1 Recettes par jour et par scène : on groupe d'abord par concert (12 groupes),
//     puis on joint concerts/scènes sur ces quelques groupes seulement.
const recettesParJourEtScene = [
  { $match: { status: { $in: countsRevenue } } },
  { $group: { _id: "$concertId", revenue: { $sum: "$price" }, tickets: { $sum: 1 } } },
  { $lookup: { from: "concerts", localField: "_id", foreignField: "_id", as: "c" } },
  { $unwind: "$c" },
  { $group: {
      _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$c.startAt", timezone: "Europe/Paris" } }, stageId: "$c.stageId" },
      revenue: { $sum: "$revenue" }, tickets: { $sum: "$tickets" } } },
  { $lookup: { from: "stages", localField: "_id.stageId", foreignField: "_id", as: "stage" } },
  { $unwind: "$stage" },
  { $project: { _id: 0, day: "$_id.day", stage: "$stage.name", revenue: 1, tickets: 1 } },
  { $sort: { day: 1, stage: 1 } }
];
print("-- Recettes par jour et par scène");
fdb.tickets.aggregate(recettesParJourEtScene).forEach(d => printjson(d));

// 4.2 Taux de remplissage par scène (concerts annulés exclus)
const remplissageParScene = [
  { $match: { status: { $ne: "cancelled" } } },
  { $group: { _id: "$stageId", sold: { $sum: "$ticketsSold" }, capacity: { $sum: "$capacity" } } },
  { $lookup: { from: "stages", localField: "_id", foreignField: "_id", as: "stage" } },
  { $unwind: "$stage" },
  { $project: { _id: 0, stage: "$stage.name", sold: 1, capacity: 1,
      fillRate: { $round: [{ $multiply: [{ $divide: ["$sold", "$capacity"] }, 100] }, 1] } } },
  { $sort: { fillRate: -1 } }
];
print("-- Taux de remplissage par scène (%)");
fdb.concerts.aggregate(remplissageParScene).forEach(d => printjson(d));

// 4.3 Artistes ayant vendu le plus de billets
const topArtistes = [
  { $group: { _id: "$artist._id", artist: { $first: "$artist.name" }, tickets: { $sum: "$ticketsSold" } } },
  { $sort: { tickets: -1 } }, { $limit: 5 },
  { $project: { _id: 0, artist: 1, tickets: 1 } }
];
print("-- Top 5 artistes");
fdb.concerts.aggregate(topArtistes).forEach(d => printjson(d));

// 4.4 Bonus : recettes par catégorie de billet
const recettesParCategorie = [
  { $match: { status: { $in: countsRevenue } } },
  { $group: { _id: "$category", revenue: { $sum: "$price" }, tickets: { $sum: 1 } } },
  { $sort: { revenue: -1 } }
];
print("-- Recettes par catégorie de billet");
fdb.tickets.aggregate(recettesParCategorie).forEach(d => printjson(d));

// 4.5 Bonus : tendance des ventes par mois
const tendanceVentes = [
  { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$purchasedAt" } }, tickets: { $sum: 1 }, revenue: { $sum: "$price" } } },
  { $sort: { _id: 1 } }
];
print("-- Tendance des ventes par mois");
fdb.tickets.aggregate(tendanceVentes).forEach(d => printjson(d));
