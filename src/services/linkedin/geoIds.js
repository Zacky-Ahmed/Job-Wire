// geoIds.js
//
// LinkedIn's internal ID for a place. A WRONG VALUE FAILS SILENTLY — the
// search returns results for some other country and nothing errors, so
// the user just never gets the alerts they expected.
//
// `verified` means it was probed against live LinkedIn by
// `npm run verify-geoids`, which searches each id and checks the returned
// job locations actually mention that country. Never flip one to true by
// hand.
//
// The flag is for us, not for users: the picker shows country names only.
// Unverified entries are simply not offered.

export const COUNTRIES = [
  { geoId: "100446352", name: "Sri Lanka", verified: true },
  { geoId: "102713980", name: "India", verified: true },
  { geoId: "103644278", name: "United States", verified: true },
  { geoId: "101165590", name: "United Kingdom", verified: true },
  { geoId: "101174742", name: "Canada", verified: true },
  { geoId: "101452733", name: "Australia", verified: true },
  { geoId: "105490917", name: "New Zealand", verified: true },
  { geoId: "102454443", name: "Singapore", verified: true },
  { geoId: "104305776", name: "United Arab Emirates", verified: true },
  { geoId: "100459316", name: "Saudi Arabia", verified: true },
  { geoId: "104170880", name: "Qatar", verified: true },
  { geoId: "106808692", name: "Malaysia", verified: true },
  { geoId: "102478259", name: "Indonesia", verified: true },
  { geoId: "103121230", name: "Philippines", verified: true },
  { geoId: "105146118", name: "Thailand", verified: true },
  { geoId: "104195383", name: "Vietnam", verified: true },
  { geoId: "101022442", name: "Pakistan", verified: true },
  { geoId: "106215326", name: "Bangladesh", verified: true },
  { geoId: "101355337", name: "Japan", verified: true },
  { geoId: "105149562", name: "South Korea", verified: true },
  { geoId: "103291313", name: "Hong Kong", verified: true },
  { geoId: "101282230", name: "Germany", verified: true },
  { geoId: "105015875", name: "France", verified: true },
  { geoId: "102890719", name: "Netherlands", verified: true },
  { geoId: "100565514", name: "Belgium", verified: true },
  { geoId: "104738515", name: "Ireland", verified: true },
  { geoId: "105646813", name: "Spain", verified: true },
  { geoId: "103350119", name: "Italy", verified: true },
  { geoId: "100364837", name: "Portugal", verified: true },
  { geoId: "105117694", name: "Sweden", verified: true },
  { geoId: "103819153", name: "Norway", verified: true },
  { geoId: "104514075", name: "Denmark", verified: true },
  { geoId: "100456013", name: "Finland", verified: true },
  { geoId: "106693272", name: "Switzerland", verified: true },
  { geoId: "103883259", name: "Austria", verified: true },
  { geoId: "105072130", name: "Poland", verified: true },
  { geoId: "104508036", name: "Czechia", verified: true },
  { geoId: "102105699", name: "Turkey", verified: true },
  { geoId: "104035573", name: "South Africa", verified: true },
  { geoId: "105365761", name: "Nigeria", verified: true },
  { geoId: "100710459", name: "Kenya", verified: true },
  { geoId: "106155005", name: "Egypt", verified: true },
  { geoId: "103323778", name: "Mexico", verified: true },
  { geoId: "106057199", name: "Brazil", verified: true },
  { geoId: "100446943", name: "Argentina", verified: true },
];

const byId = new Map(COUNTRIES.map((c) => [c.geoId, c]));

export function findGeo(geoId) {
  return byId.get(String(geoId)) || null;
}

export function isKnownGeo(geoId) {
  return byId.has(String(geoId));
}

/** What the picker offers: verified only, alphabetical. */
export function selectableCountries() {
  return COUNTRIES.filter((c) => c.verified).sort((a, b) => a.name.localeCompare(b.name));
}
