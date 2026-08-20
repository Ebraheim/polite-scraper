const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const START_URL = "https://books.toscrape.com/catalogue/page-1.html";

const CACHE_DIR = path.join(__dirname, "..", "cache");

const USER_AGENT =
  "FlyRankInternship-A9/1.0 (https://github.com/Ebraheim/polite-scraper)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithCache(url, cacheFilename) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const cachePath = path.join(CACHE_DIR, cacheFilename);

  if (fs.existsSync(cachePath)) {
    const html = fs.readFileSync(cachePath, "utf8");

    console.log(`CACHE HIT ${url}`);
    return html;
  }

  // Be polite before making a real request
  await sleep(600);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    console.log(`FETCH ${url}`);

    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    if (response.status !== 200) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const html = await response.text();

    fs.writeFileSync(cachePath, html, "utf8");

    console.log(`status=${response.status}`);
    console.log(`saved=${cachePath}`);

    return html;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverBooks() {
  let currentUrl = START_URL;

  const discoveredUrls = [];
  let cataloguePages = 0;

  while (currentUrl && cataloguePages < 3) {
    cataloguePages++;

    const cacheFilename = `catalogue-page-${cataloguePages}.html`;

    const html = await fetchWithCache(currentUrl, cacheFilename);

    const $ = cheerio.load(html);

    // Find every book link on the catalogue page
    $("article.product_pod h3 a").each((_, element) => {
      const href = $(element).attr("href");

      if (href) {
        const absoluteUrl = new URL(href, currentUrl).href;
        discoveredUrls.push(absoluteUrl);
      }
    });

    // Follow the site's own Next link
    const nextHref = $("li.next a").attr("href");

    if (nextHref && cataloguePages < 3) {
      currentUrl = new URL(nextHref, currentUrl).href;
    } else {
      currentUrl = null;
    }
  }

  const uniqueUrls = [...new Set(discoveredUrls)];

  console.log("");
  console.log(`catalogue_pages=${cataloguePages}`);
  console.log(`discovered=${discoveredUrls.length}`);
  console.log(`unique_urls=${uniqueUrls.length}`);
}

discoverBooks().catch((error) => {
  console.error(`Scraper failed: ${error.message}`);
  process.exitCode = 1;
});