// verify-geoids.js
//
// Probes every geoId against live LinkedIn and checks the jobs it returns
// are actually in that country.
//
// A wrong geoId does not error — it silently searches somewhere else, so
// the only way to know is to look at the results. For each id we search a
// generic term and compare the location text on the returned cards against
// the country name and its major cities.
//
// Writes the verified flags straight back into geoIds.js.
//
// Run:  npm run verify-geoids

import fs from "fs";
import path from "path";
import { COUNTRIES } from "../src/services/linkedin/geoIds.js";
import { fetchLinkedIn } from "../src/services/linkedin/fetch.js";
import { parseJobs, classifyResponse } from "../src/services/linkedin/parse.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cities that would appear in a location string but not contain the
// country's own name, so a match still counts as correct.
const CITIES = {
  // US locations are almost always "City, ST", so the state codes carry
  // the signal — a handful of city names missed all ten results.
  "United States": [
    "united states", "usa",
    ...("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN " +
        "MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA " +
        "WA WV WI WY DC").split(" ").map((s) => ", " + s.toLowerCase()),
    "maui", "lahaina", "honolulu", "new york", "san francisco", "chicago",
  ],
  "United Kingdom": ["london", "manchester", "birmingham", "england", "scotland", "wales", "bristol", "leeds"],
  "United Arab Emirates": ["dubai", "abu dhabi", "sharjah", "uae"],
  "South Korea": ["seoul", "busan", "korea"],
  "Hong Kong": ["hong kong", "kowloon"],
  Netherlands: ["amsterdam", "rotterdam", "utrecht", "eindhoven"],
  Germany: ["berlin", "munich", "münchen", "hamburg", "frankfurt", "cologne", "köln"],
  France: ["paris", "lyon", "toulouse", "marseille"],
  Spain: ["madrid", "barcelona", "valencia", "sevilla"],
  Italy: ["milan", "milano", "rome", "roma", "turin", "torino"],
  Switzerland: ["zurich", "zürich", "geneva", "genève", "basel", "lausanne"],
  Ireland: ["dublin", "cork", "galway"],
  Sweden: ["stockholm", "gothenburg", "göteborg", "malmö"],
  Norway: ["oslo", "bergen", "trondheim"],
  Denmark: ["copenhagen", "københavn", "aarhus"],
  Finland: ["helsinki", "espoo", "tampere"],
  Poland: ["warsaw", "warszawa", "krakow", "kraków", "wroclaw"],
  Czechia: ["prague", "praha", "brno", "czech"],
  Austria: ["vienna", "wien", "graz", "salzburg"],
  Belgium: ["brussels", "bruxelles", "antwerp", "ghent"],
  Portugal: ["lisbon", "lisboa", "porto"],
  Turkey: ["istanbul", "ankara", "izmir", "türkiye"],
  Japan: ["tokyo", "osaka", "kyoto", "yokohama"],
  Singapore: ["singapore"],
  Malaysia: ["kuala lumpur", "penang", "selangor", "johor"],
  Indonesia: ["jakarta", "bandung", "surabaya"],
  Philippines: ["manila", "makati", "cebu", "taguig", "quezon"],
  Thailand: ["bangkok", "chiang mai", "phuket"],
  Vietnam: ["hanoi", "ho chi minh", "da nang"],
  India: ["bengaluru", "bangalore", "mumbai", "delhi", "hyderabad", "pune", "chennai", "gurugram", "noida"],
  Pakistan: ["karachi", "lahore", "islamabad", "rawalpindi"],
  Bangladesh: ["dhaka", "chittagong", "chattogram"],
  "Sri Lanka": ["colombo", "kandy", "galle", "negombo", "malabe", "moratuwa", "gampaha", "kadawatha"],
  Canada: ["toronto", "vancouver", "montreal", "montréal", "ottawa", "calgary", "ontario", "quebec", "québec", "alberta"],
  Australia: ["sydney", "melbourne", "brisbane", "perth", "adelaide", "nsw", "victoria", "queensland"],
  "New Zealand": ["auckland", "wellington", "christchurch"],
  "South Africa": ["johannesburg", "cape town", "durban", "pretoria", "gauteng"],
  Nigeria: ["lagos", "abuja", "ibadan"],
  Kenya: ["nairobi", "mombasa"],
  Egypt: ["cairo", "giza", "alexandria"],
  "Saudi Arabia": ["riyadh", "jeddah", "dammam", "saudi"],
  Qatar: ["doha", "qatar"],
  Mexico: ["mexico city", "ciudad de méxico", "guadalajara", "monterrey", "cdmx"],
  Brazil: ["são paulo", "sao paulo", "rio de janeiro", "brasil", "belo horizonte"],
  Argentina: ["buenos aires", "córdoba", "rosario"],
};

function looksRight(country, jobs) {
  const needles = [country.toLowerCase(), ...(CITIES[country] || [])];
  const hits = jobs.filter((j) => {
    const where = (j.location || "").toLowerCase();
    return needles.some((n) => where.includes(n));
  });
  return { hits: hits.length, total: jobs.length };
}

const results = [];
console.log("\nProbing each geoId against live LinkedIn.");
console.log("A geoId is only marked verified when the returned jobs are");
console.log("actually located in that country.\n");

for (const c of COUNTRIES) {
  const url =
    "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search" +
    `?keywords=Engineer&location=${encodeURIComponent(c.name)}` +
    `&geoId=${c.geoId}&f_TPR=r604800&sortBy=DD&start=0`;

  let verdict = "no data";
  let verified = false;
  try {
    const html = await fetchLinkedIn(url, { jitter: false });
    const shape = classifyResponse(html);
    const jobs = shape === "jobs" ? parseJobs(html) : [];
    if (!jobs.length) {
      verdict = shape === "empty" ? "no jobs returned" : "unrecognised response";
    } else {
      const { hits, total } = looksRight(c.name, jobs);
      const ratio = hits / total;
      verified = ratio >= 0.5;
      verdict = `${hits}/${total} located in ${c.name}`;
    }
  } catch (err) {
    verdict = "fetch failed: " + err.message.slice(0, 40);
  }

  results.push({ ...c, verified, verdict });
  console.log(
    `  ${verified ? "OK  " : "SKIP"}  ${c.name.padEnd(22)} ${c.geoId.padEnd(11)} ${verdict}`
  );
  await sleep(1600); // be a polite visitor
}

// Write the flags back.
const file = path.join(process.cwd(), "src/services/linkedin/geoIds.js");
let src = fs.readFileSync(file, "utf8");
for (const r of results) {
  src = src.replace(
    new RegExp(`\\{ geoId: "${r.geoId}", name: "${r.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}", verified: (true|false) \\}`),
    `{ geoId: "${r.geoId}", name: "${r.name}", verified: ${r.verified} }`
  );
}
fs.writeFileSync(file, src);

const ok = results.filter((r) => r.verified);
console.log(`\n  ${ok.length} of ${results.length} verified and now offered in the picker.`);
console.log(`  ${results.length - ok.length} withheld — better to omit a country than`);
console.log(`  silently search the wrong one.\n`);
