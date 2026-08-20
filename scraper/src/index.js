const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const crypto = require("crypto");

const START_URL = "https://books.toscrape.com/catalogue/page-1.html";
const CACHE_DIR = path.join(__dirname, "..", "cache");

const USER_AGENT =
  "FlyRankInternship-A9/1.0 (https://github.com/Ebraheim/polite-scraper)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function safeFilename(url) {
  const hash = crypto.createHash("sha256").update(url).digest("hex");
  return `book-${hash}.html`;
}

async function fetchWithCache(url, cacheFilename = null) {
  ensureCacheDir();

  const filename = cacheFilename || safeFilename(url);
  const cachePath = path.join(CACHE_DIR, filename);

  if (fs.existsSync(cachePath)) {
    const html = fs.readFileSync(cachePath, "utf8");
    console.log(`CACHE HIT ${url}`);
    return html;
  }

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

    return html;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverBooks() {
  let currentUrl = START_URL;

  const books = [];
  let cataloguePages = 0;

  while (currentUrl && cataloguePages < 3) {
    cataloguePages++;

    const cacheFilename = `catalogue-page-${cataloguePages}.html`;

    const html = await fetchWithCache(currentUrl, cacheFilename);

    const $ = cheerio.load(html);

    $("article.product_pod h3 a").each((_, element) => {
      const href = $(element).attr("href");

      if (href) {
        books.push({
          product_url: new URL(href, currentUrl).href,
          source_page: currentUrl,
        });
      }
    });

    const nextHref = $("li.next a").attr("href");

    if (nextHref && cataloguePages < 3) {
      currentUrl = new URL(nextHref, currentUrl).href;
    } else {
      currentUrl = null;
    }
  }

  const seen = new Set();

  const uniqueBooks = books.filter((book) => {
    if (seen.has(book.product_url)) {
      return false;
    }

    seen.add(book.product_url);
    return true;
  });

  console.log("");
  console.log(`catalogue_pages=${cataloguePages}`);
  console.log(`discovered=${books.length}`);
  console.log(`unique_urls=${uniqueBooks.length}`);
  console.log("");

  return uniqueBooks;
}

function extractRating($) {
  const ratingClass = $("p.star-rating").attr("class") || "";

  const parts = ratingClass.split(/\s+/);

  return parts.find((part) =>
    ["One", "Two", "Three", "Four", "Five"].includes(part)
  ) || null;
}

function extractDescription($) {
  const heading = $("#product_description");

  if (!heading.length) {
    return null;
  }

  const description = heading.next("p").text().trim();

  return description || null;
}

async function extractBook(book) {
  const html = await fetchWithCache(book.product_url);

  const $ = cheerio.load(html);

  return {
    title: $(".product_main h1").first().text().trim(),
    product_url: book.product_url,
    price_text: $(".product_main .price_color").first().text().trim(),
    availability_text: $(".product_main .availability")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim(),
    rating_text: extractRating($),
    description: extractDescription($),
    source_page: book.source_page,
    fetched_at: new Date().toISOString(),
  };
}

async function main() {
  const books = await discoverBooks();

  const rawRecords = [];

  for (let i = 0; i < books.length; i++) {
    const record = await extractBook(books[i]);

    rawRecords.push(record);

    console.log(`detail ${i + 1}/${books.length}`);
  }

  console.log("");
  console.log("SAMPLE RAW RECORD:");
  console.log(JSON.stringify(rawRecords[0], null, 2));
  console.log("");
  console.log(`detail_pages=${rawRecords.length}`);
}

main().catch((error) => {
  console.error(`Scraper failed: ${error.message}`);
  process.exitCode = 1;
});