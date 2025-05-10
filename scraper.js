const axios = require('axios');
const cheerio = require('cheerio');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'legisfacil';
const COLLECTION_NAME = 'legislation';

const BASE_URL = 'https://www.camara.leg.br/legislacao/busca';
const BASE_DETAIL_URL = 'https://www2.camara.leg.br';

const MAX_PAGES_TO_SCRAPE = process.env.MAX_PAGES_TO_SCRAPE ? parseInt(process.env.MAX_PAGES_TO_SCRAPE) : 10;
const DETAIL_FETCH_CONCURRENCY = 5;
const DB_BATCH_SIZE = 50;
const DELAY_BETWEEN_SEARCH_PAGES_MS = 2000;
const DELAY_BETWEEN_DETAIL_FETCHES_MS = 500;
const MAX_RETRIES_FETCH = 3;
const RETRY_DELAY_MS = 1000;

const processedUrls = new Set();

const client = new MongoClient(MONGODB_URI);
let legislationCollection;

async function fetchHtml(url, attempt = 1) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
      timeout: 15000,
    });
    return response.data;
  } catch (error) {
    console.warn(`Error fetching ${url} (attempt ${attempt}/${MAX_RETRIES_FETCH}):`, error.message);
    if (attempt < MAX_RETRIES_FETCH) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      return fetchHtml(url, attempt + 1);
    }
    console.error(`Failed to fetch ${url} after ${MAX_RETRIES_FETCH} attempts.`);
    return null;
  }
}

function parseLegislationItems($) {
  const items = [];
  $('.busca-resultados__item').each((index, element) => {
    const $element = $(element);
    const anchor = $element.find('.busca-resultados__cabecalho a');
    const url = anchor.attr('href');
    if (!url) {
        console.warn('Skipping item with no URL in search results.');
        return;
    }
    const searchResultTitle = anchor.text().trim();
    const description = $element.find('.busca-resultados__descricao').text().trim();
    const searchResultStatus = $element.find('.busca-resultados__situacao').text().trim().replace('Situação:', '').trim();

    const fullUrl = url.startsWith('http') ? url : `${BASE_DETAIL_URL}${url}`;
    
    if (processedUrls.has(fullUrl)) {
      console.log(`Skipping duplicate URL: ${fullUrl}`);
      return;
    }
    
    items.push({
      searchResultTitle,
      url: fullUrl,
      searchResultDescription: description,
      searchResultStatus,
    });
  });
  return items;
}

function getNextPageUrl($) {
  const nextPageLink = $('.pagination-list__nav-link').filter(function() {
    return $(this).text().trim().includes('Próxima');
  });
  
  if (nextPageLink.length === 0) {
    return null;
  }
  
  const href = nextPageLink.attr('href');
  if (!href || href === '#' || href === '') {
    return null;
  }
  
  return href;
}

async function fetchLegislationDetail(itemUrl) {
  const html = await fetchHtml(itemUrl);
  if (!html) return null;

  const $ = cheerio.load(html);

  const title = $('.dadosNorma h1').text().trim();
  const ementa = $('.dadosNorma .ementa').text().trim().replace(/^EMENTA:\s*/i, '').trim();

  const originalTextLink = $('.dadosNorma a[href*="publicacaooriginal"]').attr('href');
  let originalTextUrl = null;
  let originalText = null;

  if (originalTextLink) {
    originalTextUrl = new URL(originalTextLink, itemUrl).href;
    const originalHtml = await fetchHtml(originalTextUrl);
    if (originalHtml) {
      const $original = cheerio.load(originalHtml);
      originalText = $original('.textoNorma').text().trim();
    } else {
      console.warn(`Could not fetch original text from ${originalTextUrl}`);
    }
  }

  const proposicaoOriginaria = $('.dadosNorma a[href*="Prop_Detalhe"]').text().trim();
  const origem = $('.dadosNorma .sessao').filter(function() {
    return $(this).clone().children().remove().end().text().trim().startsWith('Origem');
  }).text().replace(/^Origem:\s*/i, '').trim();

  const situacao = $('.dadosNorma .sessao').filter(function() {
    return $(this).clone().children().remove().end().text().trim().startsWith('Situação');
  }).text().replace(/^Situação:\s*/i, '').trim();

  const indexacao = $('.dadosNorma .grupoRetratil .corpo').map((i, el) => $(el).text().trim()).get().join('; ').trim();


  return {
    title: title || null,
    ementa: ementa || null,
    originalTextUrl,
    originalText,
    proposicaoOriginaria: proposicaoOriginaria || null,
    origem: origem || null,
    situacao: situacao || null,
    indexacao: indexacao || null,
    url: itemUrl
  };
}

async function processLegislationItem(searchItem) {
  console.log(`Fetching details for: ${searchItem.searchResultTitle || searchItem.url}`);
  
  processedUrls.add(searchItem.url);
  
  const details = await fetchLegislationDetail(searchItem.url);

  if (details) {
    const legislationData = {
      ...searchItem,
      ...details,
      lastFetchedAt: new Date(),
    };
    if (details.title) delete legislationData.searchResultTitle;
    if (details.situacao) delete legislationData.searchResultStatus;
    return legislationData;
  } else {
    console.warn(`Failed to fetch details for ${searchItem.url}. Storing minimal info.`);
    return {
        url: searchItem.url,
        searchResultTitle: searchItem.searchResultTitle,
        searchResultDescription: searchItem.searchResultDescription,
        searchResultStatus: searchItem.searchResultStatus,
        fetchError: true,
        lastAttemptedAt: new Date()
    };
  }
}

async function scrapeLegislation() {
  const { default: pLimit } = await import('p-limit');

  try {
    await client.connect();
    console.log('Connected to MongoDB');
    const database = client.db(DB_NAME);
    legislationCollection = database.collection(COLLECTION_NAME);

    console.log('Ensuring index on "url" field...');
    await legislationCollection.createIndex({ url: 1 }, { unique: true });
    console.log('Index on "url" ensured.');

    await legislationCollection.createIndex({ title: 1, ementa: 1 }, { sparse: true });
    console.log('Index on "title" and "ementa" ensured.');

    let currentUrl = `${BASE_URL}?geral=&ano=&situacao=&abrangencia=&tipo=&origem=&numero=&ordenacao=data%3ADESC`;
    let pageNum = 1;
    let totalScrapedCount = 0;
    const documentsToUpsert = [];
    let previousPageUrls = new Set();  

    const limit = pLimit(DETAIL_FETCH_CONCURRENCY);  

    console.log(`Starting legislation scraping. Max pages: ${MAX_PAGES_TO_SCRAPE}, Concurrency: ${DETAIL_FETCH_CONCURRENCY}`);

    while (currentUrl && pageNum <= MAX_PAGES_TO_SCRAPE) {
      if (previousPageUrls.has(currentUrl)) {
        console.warn(`Detected pagination loop at URL: ${currentUrl}. Stopping.`);
        break;
      }
      
      previousPageUrls.add(currentUrl);
      
      console.log(`Scraping search results page ${pageNum}: ${currentUrl}`);
      const searchHtml = await fetchHtml(currentUrl);
      if (!searchHtml) {
        console.error(`Failed to fetch search page ${pageNum}. Stopping pagination.`);
        break;
      }

      const $ = cheerio.load(searchHtml);
      const legislationItemsFromSearch = parseLegislationItems($);
      console.log(`Found ${legislationItemsFromSearch.length} items on page ${pageNum}`);

      if (legislationItemsFromSearch.length === 0) {
        console.log('No items found on page, likely end of results.');
        break;
      }

      const itemProcessingPromises = legislationItemsFromSearch.map(item => {
        return limit(async () => {
          const processedData = await processLegislationItem(item);
          if (DELAY_BETWEEN_DETAIL_FETCHES_MS > 0) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_DETAIL_FETCHES_MS));
          }
          return processedData;
        });
      });

      const processedItems = (await Promise.all(itemProcessingPromises)).filter(item => item !== null);

      if (processedItems.length > 0) {
        documentsToUpsert.push(...processedItems);
      }

      if (documentsToUpsert.length >= DB_BATCH_SIZE || (!getNextPageUrl($) || pageNum === MAX_PAGES_TO_SCRAPE)) {
        if (documentsToUpsert.length > 0) {
          console.log(`Writing ${documentsToUpsert.length} documents to MongoDB...`);
          const bulkOps = documentsToUpsert.map(doc => ({
            updateOne: {
              filter: { url: doc.url },
              update: {
                $set: doc,
                $setOnInsert: { createdAt: new Date() }
              },
              upsert: true,
            },
          }));
          try {
            const result = await legislationCollection.bulkWrite(bulkOps, { ordered: false });
            console.log(`MongoDB bulk write: ${result.upsertedCount} inserted, ${result.modifiedCount} updated.`);
            totalScrapedCount += documentsToUpsert.length;
          } catch (dbError) {
            console.error('Error during MongoDB bulk write:', dbError);
          }
          documentsToUpsert.length = 0;
        }
      }

      const nextPageRelativeUrl = getNextPageUrl($);
      if (nextPageRelativeUrl) {
        const nextUrl = nextPageRelativeUrl.startsWith('http') ? nextPageRelativeUrl : 
                       (nextPageRelativeUrl.startsWith('/') ? `${BASE_URL}${nextPageRelativeUrl}` : `${BASE_URL}/${nextPageRelativeUrl}`);
        
        if (nextUrl === currentUrl) {
          console.warn('Next URL is the same as current URL. Stopping to prevent infinite loop.');
          break;
        }
        
        currentUrl = nextUrl;
      } else {
        console.log('No next page found.');
        currentUrl = null;
      }

      pageNum++;
      if (currentUrl && DELAY_BETWEEN_SEARCH_PAGES_MS > 0) {
        console.log(`Waiting ${DELAY_BETWEEN_SEARCH_PAGES_MS}ms before next search page...`);
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_SEARCH_PAGES_MS));
      }
    }

    console.log(`Scraping complete. Total items processed and attempted to save: ${totalScrapedCount}.`);

  } catch (error) {
    console.error('Critical error during scraping process:', error);
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
}

scrapeLegislation();