// Requirements are intentionally centralized here so you can change balance later.
// Both VC hours AND message count must be reached in order.
// "hours" means cumulative VC time.

const vehicles = [
  ["Bicycle", "🚲", "bike", 1, 50],
  ["Activa", "🛵", "bike", 3, 150],
  ["Ntorq", "🛵", "bike", 6, 300],
  ["Pulsar", "🏍️", "bike", 10, 500],
  ["Apache", "🏍️", "bike", 16, 800],
  ["KTM Duke", "🏍️", "bike", 24, 1200],
  ["Royal Enfield", "🏍️", "bike", 35, 1700],
  ["Ninja", "🏍️", "bike", 50, 2500],
  ["Hayabusa", "🏍️", "bike", 70, 3500],
  ["Ducati", "🏍️", "bike", 95, 5000],
  ["BMW S1000RR", "🏍️", "bike", 125, 7000],

  ["WagonR", "🚗", "car", 160, 8500],
  ["Thar", "🚙", "car", 200, 10000],
  ["Scorpio", "🚙", "car", 250, 12000],
  ["Fortuner", "🚙", "car", 310, 14500],
  ["Audi", "🚘", "car", 380, 17000],
  ["BMW M4", "🏎️", "car", 460, 20000],
  ["BMW M5", "🏎️", "car", 550, 24000],
  ["Mercedes-AMG", "🏎️", "car", 650, 28000],
  ["Lamborghini", "🏎️", "car", 750, 32000],
  ["Ferrari", "🏎️", "car", 850, 36000],
  ["McLaren", "🏎️", "car", 950, 40000],
  ["Porsche", "🏎️", "car", 1050, 44000],
  ["Aston Martin", "🏎️", "car", 1150, 48000],
  ["Bugatti", "🏎️", "car", 1300, 55000],
  ["Koenigsegg", "🏎️", "car", 1500, 65000],
  ["Hypercar", "🏁", "car", 1750, 80000],

  ["Small Plane", "✈️", "aircraft", 2050, 95000],
  ["Private Jet", "🛩️", "aircraft", 2400, 110000],
  ["Business Jet", "🛩️", "aircraft", 2800, 125000],
  ["Helicopter", "🚁", "aircraft", 3250, 140000],
  ["Luxury Aircraft", "✈️", "aircraft", 3750, 160000],
  ["Super Jet", "✈️", "aircraft", 4300, 185000],
  ["Ultimate Aircraft", "✈️", "aircraft", 5000, 220000]
].map((v, i) => ({
  id: i + 1,
  name: v[0],
  emoji: v[1],
  category: v[2],
  vcHours: v[3],
  messages: v[4]
}));

module.exports = { vehicles };