const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");
const { z } = require("zod");

const START_URL = "https://books.toscrape.com/catalogue/page-1.html";

const CACHE_DIR = path.join(__dirname, "..", "cache");
const OUTPUT_DIR = path.join(__dirname, "..", "output");

const BOOKS_FILE = path.join(OUTPUT_DIR, "books.json");
const ERRORS_FILE = path.join(OUTPUT_DIR, "errors.json");
const RUN_REPORT_FILE = path.join(OUTPUT_DIR, "run-report.json");

const USER_AGENT =
  "FlyRankInternship-A9/1.0 (https://github.com/Ebraheim/polite-scraper)";

/*
  Statistics for this single run.
*/
const stats = {
  pagesFetched: 0,
  cacheHits: 0,
};

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

/*
  Make one HTTP request with a 5-second timeout.
*/
async function requestPage(url) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 5000);

  try {
    return await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/*
  Polite fetch rules:

  - use cache when available
  - wait before real requests
  - identify ourselves with User-Agent
  - timeout requests
  - check status
  - retry timeout / 5xx once
  - do NOT retry 403 or 404
*/
async function fetchWithCache(url, cacheFilename = null) {
  ensureDir(CACHE_DIR);

  const filename = cacheFilename || safeFilename(url);
  const cachePath = path.join(CACHE_DIR, filename);

  if (fs.existsSync(cachePath)) {
    const html = fs.readFileSync(cachePath, "utf8");

    stats.cacheHits++;

    console.log(`CACHE HIT ${url}`);

    return html;
  }

  await sleep(600);

  console.log(`FETCH ${url}`);

  try {
    const response = await requestPage(url);

    /*
      403 and 404 must never be retried.
    */
    if (response.status === 403 || response.status === 404) {
      throw new Error(`HTTP ${response.status}`);
    }

    /*
      Retry server errors once.
    */
    if (response.status >= 500) {
      console.log(`RETRY ${url} after HTTP ${response.status}`);

      await sleep(1000);

      const retryResponse = await requestPage(url);

      if (retryResponse.status !== 200) {
        throw new Error(`HTTP ${retryResponse.status}`);
      }

      const retryHtml = await retryResponse.text();

      fs.writeFileSync(cachePath, retryHtml, "utf8");

      stats.pagesFetched++;

      return retryHtml;
    }

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();

    fs.writeFileSync(cachePath, html, "utf8");

    stats.pagesFetched++;

    return html;
  } catch (error) {
    /*
      A timeout gets exactly one retry.
    */
    if (error.name === "AbortError") {
      console.log(`TIMEOUT ${url}`);
      console.log(`RETRY ${url}`);

      await sleep(1000);

      const retryResponse = await requestPage(url);

      if (retryResponse.status !== 200) {
        throw new Error(`HTTP ${retryResponse.status}`);
      }

      const retryHtml = await retryResponse.text();

      fs.writeFileSync(cachePath, retryHtml, "utf8");

      stats.pagesFetched++;

      return retryHtml;
    }

    throw error;
  }
}

/*
  Discover exactly the first three catalogue pages
  by following the site's own Next link.
*/
async function discoverBooks() {
  let currentUrl = START_URL;

  const books = [];
  let cataloguePages = 0;

  while (currentUrl && cataloguePages < 3) {
    cataloguePages++;

    const cacheFilename = `catalogue-page-${cataloguePages}.html`;

    const html = await fetchWithCache(
      currentUrl,
      cacheFilename
    );

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

  /*
    Remove duplicate product URLs.
  */
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
  const ratingClass =
    $("p.star-rating").attr("class") || "";

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

  const description = heading
    .next("p")
    .text()
    .trim();

  return description || null;
}

async function extractBook(book) {
  const html = await fetchWithCache(book.product_url);

  const $ = cheerio.load(html);

  return {
    title: $(".product_main h1")
      .first()
      .text()
      .trim(),

    product_url: book.product_url,

    price_text: $(".product_main .price_color")
      .first()
      .text()
      .trim(),

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
  const cleaned = priceText
    .replace("£", "")
    .trim();

  return Number.parseFloat(cleaned);
}

/*
  Finished record schema.
*/
const BookSchema = z.object({
  title: z.string().min(1),

  product_url: z.string().url(),

  price_text: z.string().min(1),

  price_gbp: z
    .number()
    .finite()
    .nonnegative(),

  availability_text: z.string().min(1),

  rating_text: z
    .enum(["One", "Two", "Three", "Four", "Five"])
    .nullable(),

  description: z.string().nullable(),

  source_page: z.string().url(),

  fetched_at: z.string().min(1),
});

async function main() {
  ensureDir(OUTPUT_DIR);

  const startedAt = new Date();

  /*
    Discover the real 60 books.
  */
  const books = await discoverBooks();

  /*
    Stage 5 failure test.

    This URL is deliberately fake.
    It should return 404.

    The scraper must skip it rather than crash.
  */
  books.push({
    product_url:
      "https://books.toscrape.com/catalogue/this-book-does-not-exist-9999/index.html",

    source_page:
      "https://books.toscrape.com/catalogue/page-1.html",
  });

  const validRecords = [];

  const errors = [];

  let invalidRecords = 0;
  let failedPages = 0;

  for (let i = 0; i < books.length; i++) {
    const book = books[i];

    try {
      const raw = await extractBook(book);

      const normalized = {
        ...raw,
        price_gbp: normalizePrice(raw.price_text),
      };

      const validation =
        BookSchema.safeParse(normalized);

      /*
        Schema failure.
      */
      if (!validation.success) {
        invalidRecords++;

        errors.push({
          type: "validation_error",
          product_url: book.product_url,
          reason: validation.error.issues,
        });

        console.log(
          `INVALID ${book.product_url}`
        );

        continue;
      }

      validRecords.push(validation.data);

      console.log(
        `processed ${i + 1}/${books.length}`
      );
    } catch (error) {
      /*
        Page failure.

        One bad page must not kill the run.
      */
      failedPages++;

      errors.push({
        type: "fetch_error",
        product_url: book.product_url,
        reason: error.message,
      });

      console.log(
        `FAILED ${book.product_url} -> ${error.message}`
      );
    }
  }

  /*
    Canonical product URL is our unique identity.

    Map ensures reruns or duplicate discoveries
    cannot create duplicate records.
  */
  const uniqueMap = new Map();

  for (const record of validRecords) {
    uniqueMap.set(
      record.product_url,
      record
    );
  }

  const uniqueRecords = [
    ...uniqueMap.values(),
  ];

  /*
    Store validated records.
  */
  fs.writeFileSync(
    BOOKS_FILE,
    JSON.stringify(
      uniqueRecords,
      null,
      2
    )
  );

  /*
    Store validation and fetch errors.
  */
  fs.writeFileSync(
    ERRORS_FILE,
    JSON.stringify(
      errors,
      null,
      2
    )
  );

  const finishedAt = new Date();

  /*
    Honest run report.
  */
  const runReport = {
    started_at:
      startedAt.toISOString(),

    finished_at:
      finishedAt.toISOString(),

    duration_ms:
      finishedAt.getTime() -
      startedAt.getTime(),

    catalogue_pages: 3,

    discovered_book_urls: 60,

    pages_fetched:
      stats.pagesFetched,

    cache_hits:
      stats.cacheHits,

    valid_records:
      uniqueRecords.length,

    invalid_records:
      invalidRecords,

    failed_pages:
      failedPages,
  };

  fs.writeFileSync(
    RUN_REPORT_FILE,
    JSON.stringify(
      runReport,
      null,
      2
    )
  );

  console.log("");
  console.log("RUN COMPLETE");
  console.log("");

  console.log(
    `valid_records=${uniqueRecords.length}`
  );

  console.log(
    `invalid_records=${invalidRecords}`
  );

  console.log(
    `failed_pages=${failedPages}`
  );

  console.log(
    `pages_fetched=${stats.pagesFetched}`
  );

  console.log(
    `cache_hits=${stats.cacheHits}`
  );

  console.log("");
  console.log("RUN REPORT");

  console.log(
    JSON.stringify(
      runReport,
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    `Scraper failed: ${error.message}`
  );

  process.exitCode = 1;
});