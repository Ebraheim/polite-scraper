const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");
const { z } = require("zod");

const START_URL = "https://books.toscrape.com/catalogue/page-1.html";
const CACHE_DIR = path.join(__dirname, "..", "cache");
const OUTPUT_DIR = path.join(__dirname, "..", "output");

const USER_AGENT =
  "FlyRankInternship-A9/1.0 (https://github.com/Ebraheim/polite-scraper)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeFilename(url) {
  const hash = crypto.createHash("sha256").update(url).digest("hex");
  return `book-${hash}.html`;
}

async function fetchWithCache(url, cacheFilename = null) {
  ensureDir(CACHE_DIR);

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

  return books.filter((book) => {
    if (seen.has(book.product_url)) return false;

    seen.add(book.product_url);
    return true;
  });
}

function extractRating($) {
  const ratingClass = $("p.star-rating").attr("class") || "";

  return (
    ratingClass
      .split(/\s+/)
      .find((part) =>
        ["One", "Two", "Three", "Four", "Five"].includes(part)
      ) || null
  );
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

function normalizePrice(priceText) {
  const cleaned = priceText.replace("£", "").trim();
  const value = Number.parseFloat(cleaned);

  return value;
}

const BookSchema = z.object({
  title: z.string().min(1),
  product_url: z.string().url(),
  price_text: z.string().min(1),
  price_gbp: z.number().finite().nonnegative(),
  availability_text: z.string().min(1),
  rating_text: z.enum(["One", "Two", "Three", "Four", "Five"]).nullable(),
  description: z.string().nullable(),
  source_page: z.string().url(),
  fetched_at: z.string().min(1),
});

async function main() {
  ensureDir(OUTPUT_DIR);

  const books = await discoverBooks();

  const validRecords = [];
  const errors = [];

  for (let i = 0; i < books.length; i++) {
    try {
      const raw = await extractBook(books[i]);

      const normalized = {
        ...raw,
        price_gbp: normalizePrice(raw.price_text),
      };

      const result = BookSchema.safeParse(normalized);

      if (result.success) {
        validRecords.push(result.data);
      } else {
        errors.push({
          product_url: books[i].product_url,
          reason: result.error.issues,
        });
      }

      console.log(`processed ${i + 1}/${books.length}`);
    } catch (error) {
      errors.push({
        product_url: books[i].product_url,
        reason: error.message,
      });
    }
  }

  const uniqueMap = new Map();

  for (const record of validRecords) {
    uniqueMap.set(record.product_url, record);
  }

  const uniqueRecords = [...uniqueMap.values()];

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "books.json"),
    JSON.stringify(uniqueRecords, null, 2)
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "errors.json"),
    JSON.stringify(errors, null, 2)
  );

  console.log("");
  console.log(`valid_records=${uniqueRecords.length}`);
  console.log(`invalid_records=${errors.length}`);
  console.log(`books_json=${path.join(OUTPUT_DIR, "books.json")}`);
  console.log(`errors_json=${path.join(OUTPUT_DIR, "errors.json")}`);
}

main().catch((error) => {
  console.error(`Scraper failed: ${error.message}`);
  process.exitCode = 1;
});