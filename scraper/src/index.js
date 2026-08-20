const fs = require("fs");
const path = require("path");

const PAGE_URL = "https://books.toscrape.com/catalogue/page-1.html";
const CACHE_DIR = path.join(__dirname, "..", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "catalogue-page-1.html");

async function fetchPage() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  // Use cache if it already exists
  if (fs.existsSync(CACHE_FILE)) {
    const html = fs.readFileSync(CACHE_FILE, "utf8");

    console.log("CACHE HIT");
    console.log(`response_size=${Buffer.byteLength(html, "utf8")} bytes`);

    return html;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    console.log("FETCH");

    const response = await fetch(PAGE_URL, {
      headers: {
        "User-Agent":
          "FlyRankInternship-A9/1.0 (https://github.com/Ebraheim/polite-scraper)",
      },
      signal: controller.signal,
    });

    if (response.status !== 200) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const html = await response.text();

    fs.writeFileSync(CACHE_FILE, html, "utf8");

    console.log(`status=${response.status}`);
    console.log(`response_size=${Buffer.byteLength(html, "utf8")} bytes`);
    console.log(`saved=${CACHE_FILE}`);

    return html;
  } catch (error) {
    if (error.name === "AbortError") {
      console.error("Request timed out");
    } else {
      console.error(`Fetch failed: ${error.message}`);
    }

    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

fetchPage();