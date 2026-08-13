// geoIds.js
//
// LinkedIn's internal ID for a place. A WRONG VALUE FAILS SILENTLY —
// the search returns results for the wrong country and nothing errors.
// Verify each one by running the search in a browser and reading the
// geoId out of the address bar before trusting it.
//
// Sri Lanka is confirmed (it came from a real search URL). The rest are
// unverified and marked as such.

export const COUNTRIES = [
  { geoId: "100446352", name: "Sri Lanka", verified: true },
  { geoId: "102713980", name: "India", verified: false },
  { geoId: "103644278", name: "United States", verified: false },
  { geoId: "101165590", name: "United Kingdom", verified: false },
  { geoId: "102454443", name: "Singapore", verified: false },
  { geoId: "101174742", name: "Canada", verified: false },
  { geoId: "101452733", name: "Australia", verified: false },
  { geoId: "104305776", name: "United Arab Emirates", verified: false },
  { geoId: "101282230", name: "Germany", verified: false },
];

const byId = new Map(COUNTRIES.map((c) => [c.geoId, c]));

export function findGeo(geoId) {
  return byId.get(String(geoId)) || null;
}

export function isKnownGeo(geoId) {
  return byId.has(String(geoId));
}
