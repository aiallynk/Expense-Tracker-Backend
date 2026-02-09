import mongoose from 'mongoose';

import { Category, CategoryStatus } from '../../models/Category';
import { config } from '../../config/index';
import { callOpenAI } from '../openaiWrapper.service';
import { logger } from '@/config/logger';

const AI_CATEGORY_TIMEOUT_MS = 10000;

/** Line item with description (or desc from API) and amount */
export interface LineItemLike {
  description?: string;
  desc?: string;
  amount?: number;
}

/** Receipt-like input for post-processing (OcrResult or ExtractedReceipt) */
export interface ReceiptLike {
  vendor?: string;
  lineItems?: Array<LineItemLike>;
  notes?: string;
  transactionDescription?: string;
  paymentCategory?: string;
  /** Category label shown in receipt UI, when present */
  category?: string;
  /** Top-level description/memo field when present */
  description?: string;
  [key: string]: any;
}

/** Result of category inference from full receipt text */
export interface CategoryInferenceResult {
  categorySuggestion: string | null;
  categoryId?: mongoose.Types.ObjectId;
  categoryUnidentified: boolean;
  matchedKeywords?: string[];
  /** 0–1 when from AI; undefined when from keyword fallback */
  confidence?: number;
}

/**
 * Extra keywords (vendor names + line-item terms) that map to category names.
 * Aligns with required categories: Food, Office, Travel, Fuel, Stationary, Material Purchase,
 * Transport Charges, Weighbridge expenses, Staff welfare, Vehicle Maintainence, medical expenses, Others.
 * Keys must match category.name.toLowerCase() so frontend-created categories are detected.
 */
const VENDOR_SYNONYM_KEYWORDS: Record<string, string[]> = {
  stationery: ['stationary', 'stationery', 'stationery shop', 'stationery store', 'stationary mart', 'pen', 'pencil', 'whitener', 'a4', 'paper', 'folder', 'file', 'notebook', 'register'],
  stationary: ['stationary', 'stationery', 'stationery shop', 'stationery store', 'stationary mart', 'pen', 'pencil', 'whitener', 'a4', 'paper', 'folder', 'file', 'notebook', 'register'],
  material_purchase: ['furniture', 'furnitures', 'cement', 'plywood', 'doors', 'windows', 'wooden', 'building material', 'suppliers', 'material purchase', 'material purchase shop', 'material purchase store', 'pipes', 'nuts', 'bolts', 'nails', 'binding wire', 'nut', 'bolt'],
  'material purchase': ['furniture', 'furnitures', 'cement', 'plywood', 'doors', 'windows', 'wooden', 'building material', 'suppliers', 'pipes', 'nuts', 'bolts', 'nails', 'binding wire', 'nut', 'bolt'],
  furnitures: ['furniture', 'furnitures', 'cement', 'plywood', 'doors', 'windows', 'wooden', 'building material', 'suppliers', 'material purchase'],
  furniture: ['furnitures', 'cement', 'plywood', 'doors', 'windows', 'wooden', 'building material', 'suppliers', 'material purchase'],
  construction: ['cement', 'plywood', 'doors', 'windows', 'building material', 'furniture', 'suppliers', 'pipes', 'nails', 'bolts'],
  office: ['stationery', 'stationary', 'office supplies', 'xerox', 'computer stationery', 'pen', 'pencil', 'paper', 'folder', 'file'],
  'office supplies': ['stationery', 'stationary', 'xerox', 'computer stationery', 'pen', 'pencil', 'paper', 'folder', 'file'],
  groceries: ['grocery', 'supermarket', 'provisions', 'grocery store', 'big bazaar', 'dmart', 'reliance fresh', 'more supermarket', 'spencer', 'nilgiris'],
  medical: ['medical', 'pharmacy', 'chemist', 'drug', 'apollo', 'apollo pharmacy', 'medplus', 'netmeds', '1mg', 'pharmeasy', 'healthkart', 'hospital', 'clinic'],
  travel: ['travels', 'tour', 'tours', 'tourism', 'cab', 'booking', 'airline', 'airlines', 'flight', 'flights', 'hotel', 'hotels', 'motel', 'resort', 'resorts', 'stay', 'accommodation', 'lodge', 'lodging', 'inn', 'guest house', 'guesthouse', 'hostel', 'homestay', 'room charges', 'room', 'suite', 'booking.com', 'makemytrip', 'goibibo', 'airbnb', 'oyo', 'treebo', 'fabhotels', 'cleartrip', 'yatra', 'expedia', 'agoda', 'trivago', 'indigo', 'spicejet', 'air india', 'vistara', 'go air', 'taxi', 'uber', 'ola', 'rapido', 'rail', 'railway', 'train', 'ticket', 'bus', 'travel agency', 'travel agent'],
  fuel: ['petrol', 'petrolium', 'diesel', 'gas station', 'filling station', 'fuel', 'petrol pump', 'hp petrol', 'iocl', 'bharat petrol', 'shell', 'reliance petroleum'],
  food: ['restaurant', 'cafe', 'bakery', 'kitchen', 'dining', 'meal', 'lunch', 'dinner', 'breakfast', 'food', 'sweet', 'emporio', 'swiggy', 'zomato', 'dominos', 'mcdonalds', 'kfc', 'pizza', 'hotel', 'dhaba', 'canteen', 'mess'],
  'transport charges': ['transport only', 'delivery', 'freight', 'tempo', 'logistics', 'transportation', 'courier', 'shipping', 'cargo'],
  'weighbridge expenses': ['weighbridge', 'peb', 'tmt', 'steel', 'weigh bridge'],
  weighbridge: ['weighbridge', 'peb', 'tmt', 'steel'],
  'staff welfare': ['staff', 'welfare', 'staff welfare', 'employee'],
  'vehicle maintainence': ['vehicle', 'maintenance', 'maintainence', 'servicing', 'puncture', 'tyre', 'tire', 'service center', 'garage'],
  'vehicle maintenance': ['vehicle', 'maintenance', 'maintainence', 'servicing', 'puncture', 'tyre', 'tire', 'service center', 'garage'],
  'medical expenses': ['medical', 'pharmacy', 'chemist', 'checkup', 'medical expenses', 'drug', 'medicine'],
  others: [],
};

/** Line item descriptions that should be skipped (totals, tax, payment, legal) */
const SKIP_PATTERNS = [
  /^\s*total\s*$/i,
  /^\s*subtotal\s*$/i,
  /^\s*tax\s*$/i,
  /^\s*gst\s*$/i,
  /^\s*vat\s*$/i,
  /^\s*discount\s*$/i,
  /^\s*payment\s*$/i,
  /^\s*cash\s*$/i,
  /^\s*card\s*$/i,
  /^\s*upi\s*$/i,
  /^\s*amount\s*paid\s*$/i,
  /^\s*grand\s*total\s*$/i,
  /^\s*round\s*off\s*$/i,
  /^\s*convenience\s*fee\s*$/i,
  /^\s*delivery\s*fee\s*$/i,
  /^\s*service\s*charge\s*$/i,
  /terms\s*and\s*conditions/i,
  /thank\s*you/i,
  /visit\s*again/i,
];

/**
 * Build a single normalized text blob from receipt fields for category inference.
 */
export function buildFullReceiptText(result: ReceiptLike): string {
  const parts: string[] = [];

  if (result.vendor && String(result.vendor).trim()) {
    parts.push(String(result.vendor).trim());
  }

  if (result.lineItems && Array.isArray(result.lineItems)) {
    for (const item of result.lineItems) {
      const desc = (item as LineItemLike)?.description ?? (item as LineItemLike)?.desc;
      if (desc && String(desc).trim()) {
        parts.push(String(desc).trim());
      }
    }
  }

  if (result.notes && String(result.notes).trim()) {
    parts.push(String(result.notes).trim());
  }

  if (result.transactionDescription && String(result.transactionDescription).trim()) {
    parts.push(String(result.transactionDescription).trim());
  }

  if (result.paymentCategory && String(result.paymentCategory).trim()) {
    parts.push(String(result.paymentCategory).trim());
  }

  if (result.category && String(result.category).trim()) {
    parts.push(String(result.category).trim());
  }

  if (result.description && String(result.description).trim()) {
    parts.push(String(result.description).trim());
  }

  const blob = parts.join(' ');
  return blob.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Derive normalized keywords for a category from its name and code.
 * - Lowercase
 * - Split into words
 * - Add simple singular/plural variants
 * - Include full multi-word name as a phrase when applicable
 */
function deriveCategoryKeywords(name: string, code?: string): string[] {
  const keywords = new Set<string>();

  const addKeyword = (kw: string | undefined | null) => {
    if (!kw) return;
    const normalized = kw.toString().trim().toLowerCase();
    if (!normalized || normalized.length < 2) return;
    keywords.add(normalized);
  };

  const processSource = (source?: string) => {
    if (!source) return;
    const lower = source.toString().trim().toLowerCase();
    if (!lower) return;

    const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length === 0) return;

    // Full phrase (e.g. "office supplies")
    if (words.length > 1) {
      addKeyword(words.join(' '));
    }

    for (const word of words) {
      addKeyword(word);

      // Simple singular/plural variants
      if (word.length > 3) {
        if (word.endsWith('ies')) {
          addKeyword(word.slice(0, -3) + 'y');
        } else if (word.endsWith('s')) {
          addKeyword(word.slice(0, -1));
        } else {
          addKeyword(word + 's');
          if (word.endsWith('y') && word.length > 1) {
            addKeyword(word.slice(0, -1) + 'ies');
          }
        }
      }
    }
  };

  processSource(name);
  processSource(code);

  return Array.from(keywords);
}

/**
 * Escape a string for safe use inside a RegExp.
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Score a single keyword against text.
 * - Exact word match (word boundaries) → exact = true
 * - Substring match (case-insensitive) → partial = true
 */
function scoreKeywordInText(
  text: string,
  keyword: string
): { exact: boolean; partial: boolean } {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return { exact: false, partial: false };

  // Exact word match using word boundaries
  const wordRegex = new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i');
  const exact = wordRegex.test(text);

  // Partial match as substring (only when not already counted as exact)
  const partial = !exact && text.includes(kw);

  return { exact, partial };
}

type CategoryLean = { name: string; code?: string; _id: mongoose.Types.ObjectId };

/**
 * Try AI-based category inference. Returns null if disabled, invalid, or on error (caller should fall back to keyword).
 */
async function tryAICategoryInference(
  fullText: string,
  categories: CategoryLean[],
  companyId?: mongoose.Types.ObjectId
): Promise<CategoryInferenceResult | null> {
  if (config.ai?.disableCategoryMatching || !config.openai?.apiKey) {
    return null;
  }

  const categoryList = categories
    .map((c) => (c.code ? `${c.name} (${c.code})` : c.name))
    .join('\n');

  const prompt = `You are an AI system specialized in classifying real-world expense receipts.

Categories are predefined and must be selected carefully.

Receipt text:
${fullText}

Allowed categories (you MUST choose exactly one from this list):
${categoryList}

═══════════════════════════════════════════════════════════════
CLASSIFICATION FRAMEWORK - Follow this decision process STRICTLY:
═══════════════════════════════════════════════════════════════

STEP 1: Identify CONTEXT, not just keywords
────────────────────────────────────────────
Do NOT classify based only on words like "charges", "invoice", or "service".
Instead, identify the BUSINESS CONTEXT using:
  • Vendor type (what business is this?)
  • Nature of service (what did the customer receive?)
  • Duration indicators (dates, nights, arrival/departure times)
  • Line items (room, stay, nights, folio, check-in, check-out)
  • Payment purpose (what was actually purchased?)

STEP 2: Apply EXCEPTION RULES (CRITICAL - Read Carefully!)
────────────────────────────────────────────────────────────

⚠️ RULE 1: Travel vs Transport Charges (Most Common Confusion)
   
   Classify as TRAVEL if receipt contains ANY of:
   ✓ Hotel, Resort, Lodge, Guest House, Motel, Inn, Hostel
   ✓ Room Charges, Room Rent, Accommodation Charges
   ✓ No. of Nights, Night(s), Stay duration
   ✓ Check-in / Check-out dates
   ✓ Arrival / Departure times
   ✓ Folio No, GR Card No, Reservation No
   ✓ Room Type (Deluxe, Suite, Standard, etc.)
   ✓ Booking platforms (MakeMyTrip, Goibibo, OYO, Airbnb, etc.)
   ✓ Flight tickets, Train tickets, Bus bookings
   → ALWAYS classify as "Travel" even if no vehicle is explicitly mentioned
   
   Classify as TRANSPORT CHARGES ONLY if:
   ✓ Delivery service (courier, shipping, freight explicitly mentioned)
   ✓ Logistics company (DHL, Blue Dart, FedEx, etc.)
   ✓ Cargo or freight forwarding
   ✓ Goods transportation (tempo, truck rental for moving goods)
   → DO NOT use Transport Charges for personal travel (taxi, cab, uber, etc.)
   → Personal rides = Travel, NOT Transport Charges

⚠️ RULE 2: Travel vs Food
   
   If food is part of a hotel stay (hotel restaurant, room service):
   → Classify as TRAVEL
   
   If standalone restaurant bill (not inside a hotel):
   → Classify as FOOD

⚠️ RULE 3: Fuel vs Transport vs Travel
   
   Fuel station / Petrol pump / Diesel purchase:
   → Classify as FUEL
   
   Ride service (Uber, Ola, taxi, cab, auto):
   → Classify as TRAVEL (personal transportation)
   
   Delivery / Shipping / Freight service:
   → Classify as TRANSPORT CHARGES (goods transportation)

⚠️ RULE 4: Office Supplies vs Stationery vs IT
   
   Physical items (pens, paper, folders, files):
   → OFFICE or STATIONERY (whichever category exists)
   
   Software licenses, subscriptions, cloud services:
   → IT (if exists) or OFFICE

⚠️ RULE 5: Medical Expenses
   
   Pharmacy, chemist, medicine, checkup, hospital:
   → MEDICAL EXPENSES (if exists) or MEDICAL

STEP 3: CONFIDENCE OVERRIDE
────────────────────────────
If multiple categories seem valid:
  • Choose the category that represents the PRIMARY PURPOSE
  • Ignore secondary or bundled services
  
Example: Hotel bill with restaurant charges
  → Primary: Hotel stay
  → Secondary: Food
  → Classify as: TRAVEL

STEP 4: VALIDATION (Final Check)
──────────────────────────────────
Before finalizing, ask yourself:
"What was the user ACTUALLY PAYING FOR?"

If the answer is:
  • A place to stay (hotel, room) → TRAVEL
  • Food delivery to their location → TRANSPORT CHARGES
  • Eating at a restaurant → FOOD
  • Fuel for vehicle → FUEL
  • Medicine or treatment → MEDICAL EXPENSES
  • Office items → OFFICE or STATIONERY

═══════════════════════════════════════════════════════════════
IMPORTANT REMINDERS:
═══════════════════════════════════════════════════════════════
✓ Context > Keywords: Don't just match words
✓ Hotels are ALWAYS Travel, never Transport
✓ Uber/Ola/Taxi = Travel, not Transport
✓ Delivery services = Transport Charges
✓ Choose primary purpose, not secondary items
✓ Return only categories from the allowed list
✓ Confidence: 0-1 (e.g., 0.95 for clear cases, 0.70 for ambiguous)

Return JSON only, no other text:
{"bestCategory": "Exact Category Name from the list", "confidence": 0.95, "reason": "Brief one-line explanation"}`;

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('AI category inference timeout')), AI_CATEGORY_TIMEOUT_MS)
    );
    const aiPromise = callOpenAI({
      companyId: companyId?.toString() || 'unknown',
      userId: 'unknown',
      feature: 'AI_ASSIST',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
      temperature: 0.1,
      response_format: { type: 'json_object' as const },
    });
    const response = await Promise.race([aiPromise, timeoutPromise]);
    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as { bestCategory?: string; confidence?: number };
    const bestCategory = typeof parsed.bestCategory === 'string' ? parsed.bestCategory.trim() : '';
    let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    if (confidence > 1) confidence /= 100;

    const threshold = config.ai?.categoryConfidenceThreshold ?? 0.6;
    if (confidence < threshold) return null;

    const matchedCategory = categories.find(
      (c) => c.name.trim().toLowerCase() === bestCategory.toLowerCase()
    );
    if (!matchedCategory) return null;

    logger.info(
      { companyId, categoryName: matchedCategory.name, confidence },
      'OCR post-process: category inferred from AI'
    );
    return {
      categorySuggestion: matchedCategory.name,
      categoryId: matchedCategory._id,
      categoryUnidentified: false,
      confidence,
    };
  } catch (err: any) {
    logger.debug({ err: err?.message, companyId }, 'OCR post-process: AI category inference failed, using keyword fallback');
    return null;
  }
}

/**
 * Infer expense category from full receipt text using AI first, then keyword rules and company categories.
 * Optional vendorText: when provided, keyword matches in the vendor name get a scoring bonus
 * so e.g. "SUNDARAM STATIONERY MART" strongly favours Stationery/Office.
 */
export async function inferCategoryFromReceiptText(
  fullText: string,
  companyId?: mongoose.Types.ObjectId,
  options?: { vendorText?: string }
): Promise<CategoryInferenceResult> {
  const normalizedText = fullText.replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedVendor = (options?.vendorText ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalizedText) {
    logger.debug({ companyId }, 'OCR post-process: no text for category inference');
    return {
      categorySuggestion: null,
      categoryUnidentified: true,
    };
  }

  const categories = await Category.find({
    status: CategoryStatus.ACTIVE,
    $or: [{ companyId: null }, { companyId }],
  })
    .select('name code _id')
    .lean() as unknown as CategoryLean[];

  if (categories.length === 0) {
    logger.warn({ companyId }, 'OCR post-process: no active categories found');
    return { categorySuggestion: null, categoryUnidentified: true };
  }

  const aiResult = await tryAICategoryInference(normalizedText, categories, companyId);
  if (aiResult !== null) return aiResult;

  type ScoredCategory = {
    category: { name: string; code?: string; _id: mongoose.Types.ObjectId };
    score: number;
    matchedKeywords: string[];
    matchedInVendor: boolean;
  };

  let bestScore = 0;
  const bestCategories: ScoredCategory[] = [];

  for (const category of categories) {
    const baseKeywords = deriveCategoryKeywords(category.name, category.code);
    const nameLower = category.name.trim().toLowerCase();
    const vendorSynonyms = VENDOR_SYNONYM_KEYWORDS[nameLower] || [];
    const keywords = [...new Set([...baseKeywords, ...vendorSynonyms.map((s) => s.toLowerCase().trim())])];
    if (keywords.length === 0) continue;

    let score = 0;
    const matchedKeywords: string[] = [];
    let matchedInVendor = false;

    for (const kw of keywords) {
      const { exact, partial } = scoreKeywordInText(normalizedText, kw);
      if (exact) {
        score += 2;
        matchedKeywords.push(kw);
      } else if (partial) {
        score += 1;
        matchedKeywords.push(kw);
      }
      if (normalizedVendor && (exact || partial)) {
        const inVendor = scoreKeywordInText(normalizedVendor, kw);
        if (inVendor.exact || inVendor.partial) {
          score += 1;
          matchedInVendor = true;
        }
      }
    }

    if (score <= 0) continue;

    if (score > bestScore) {
      bestScore = score;
      bestCategories.length = 0;
      bestCategories.push({ category, score, matchedKeywords, matchedInVendor });
    } else if (score === bestScore) {
      bestCategories.push({ category, score, matchedKeywords, matchedInVendor });
    }
  }

  if (bestScore === 0 || bestCategories.length === 0) {
    // No category matched - find "Others" category as fallback
    const othersCategory = categories.find(
      (c) => c.name.trim().toLowerCase() === 'others'
    );

    if (othersCategory) {
      logger.info(
        { companyId, textPreview: normalizedText.slice(0, 100), categoryName: 'Others' },
        'OCR post-process: no category matched, defaulting to Others (needs manual review)'
      );
      return {
        categorySuggestion: othersCategory.name,
        categoryId: othersCategory._id,
        categoryUnidentified: true, // Flag for manual review
      };
    } else {
      // No "Others" category found either - truly uncategorized
      logger.warn(
        { companyId, textPreview: normalizedText.slice(0, 100) },
        'OCR post-process: no category matched and no Others category available'
      );
      return {
        categorySuggestion: null,
        categoryUnidentified: true,
      };
    }
  }

  const compareCategories = (a: ScoredCategory, b: ScoredCategory) => {
    const nameA = a.category.name.toLowerCase();
    const nameB = b.category.name.toLowerCase();
    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;
    const idA = a.category._id.toString();
    const idB = b.category._id.toString();
    if (idA < idB) return -1;
    if (idA > idB) return 1;
    return 0;
  };

  // Tie-breaker 1: prefer categories that matched in the vendor name (e.g. "STATIONERY MART" → Stationery)
  const withVendorMatch = bestCategories.filter((entry) => entry.matchedInVendor);
  // Tie-breaker 2: prefer categories whose full name appears in the text
  const withNameInText = (withVendorMatch.length > 0 ? withVendorMatch : bestCategories).filter((entry) => {
    const nameLower = entry.category.name?.toString().trim().toLowerCase();
    if (!nameLower) return false;
    return normalizedText.includes(nameLower);
  });

  let chosen: ScoredCategory;
  if (withNameInText.length > 0) {
    chosen = withNameInText.sort(compareCategories)[0];
  } else if (withVendorMatch.length > 0) {
    chosen = withVendorMatch.sort(compareCategories)[0];
  } else {
    chosen = bestCategories.sort(compareCategories)[0];
  }

  logger.info(
    {
      companyId,
      categoryName: chosen.category.name,
      categoryId: chosen.category._id,
      keywordHits: chosen.matchedKeywords,
    },
    'OCR post-process: category inferred from dynamic keywords'
  );

  return {
    categorySuggestion: chosen.category.name,
    categoryId: chosen.category._id,
    categoryUnidentified: false,
    matchedKeywords: chosen.matchedKeywords,
  };
}

/**
 * Check if a line item description should be skipped (total, tax, payment, etc.).
 */
function shouldSkipLineItem(description: string): boolean {
  const d = description.trim();
  if (!d) return true;
  return SKIP_PATTERNS.some((re) => re.test(d));
}

/**
 * Build notes string from line items: comma-separated item descriptions.
 * Skips totals, tax, payment, legal text. Fallback to vendor/category summary if no items.
 */
export function extractNotesFromLineItems(
  result: ReceiptLike,
  options?: { vendor?: string; categoryName?: string }
): string {
  const items: string[] = [];

  if (result.lineItems && Array.isArray(result.lineItems)) {
    for (const item of result.lineItems) {
      const li = item as LineItemLike;
      const desc = (li?.description ?? li?.desc ?? '').toString().trim();
      if (!desc) continue;
      if (shouldSkipLineItem(desc)) continue;
      items.push(desc);
    }
  }

  if (items.length > 0) {
    return items.join(', ');
  }

  if (result.notes && String(result.notes).trim()) {
    return String(result.notes).trim();
  }

  const vendor = options?.vendor ?? result.vendor;
  const categoryName = options?.categoryName;
  if (vendor && String(vendor).trim()) {
    if (categoryName) {
      return `${String(vendor).trim()} - ${categoryName}`;
    }
    return String(vendor).trim();
  }

  return '';
}
